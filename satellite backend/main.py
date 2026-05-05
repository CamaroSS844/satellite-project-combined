"""
Satellite Realignment Backend — v3 (MPU-6050 feedback)
New endpoints:
  POST /esp32/imu_update        — live IMU angle stream from ESP32
  POST /esp32/movement_verify   — movement verification result from ESP32
  POST /esp32/calibrate_ack     — ESP32 confirms calibration was executed
  POST /dashboard/calibrate/{station_id} — dashboard triggers calibration
"""

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from enum import Enum
from typing import Dict, List, Optional
from datetime import datetime, timedelta, timezone
import asyncio
import json
import sqlite3
import httpx
import io

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
)

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

HEARTBEAT_TIMEOUT   = timedelta(seconds=10)
ANGLE_TOLERANCE     = 0.5      # servo command tolerance (degrees)
IMU_VERIFY_TOLERANCE = 3.0     # IMU must move at least this many degrees to call it a success
LOG_LEVEL           = "STATE"  # OFF | ACCESS | STATE

STATION_COORDS = {
    "station_1": {"lat": -17.8292, "lon": 31.0522, "label": "Station A – Harare"},
    "station_2": {"lat": -17.9243, "lon": 25.8572, "label": "Station B – Victoria Falls"},
}

# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────

def log_access(msg: str):
    if LOG_LEVEL in ("ACCESS", "STATE"):
        print(f"[ACCESS] {msg}")

def log_state(msg: str, state=None):
    if LOG_LEVEL == "STATE":
        print(f"[STATE]  {msg}")
        if state:
            print(json.dumps(state.model_dump(), indent=2, default=str))

# ─────────────────────────────────────────────────────────────────────────────
# ENUMS & MODELS
# ─────────────────────────────────────────────────────────────────────────────

class Mode(str, Enum):
    AUTO   = "AUTO"
    MANUAL = "MANUAL"
    MAINT  = "MAINT"
    ERROR  = "ERROR"


class Angles(BaseModel):
    azimuth:   float
    elevation: float


class CommandState(BaseModel):
    pending:      bool               = False
    issued_at:    Optional[datetime] = None
    acknowledged: bool               = False


class ErrorState(BaseModel):
    has_error:     bool               = False
    error_code:    Optional[str]      = None
    error_message: Optional[str]      = None
    timestamp:     Optional[datetime] = None


class ConnectionState(BaseModel):
    last_heartbeat: Optional[datetime] = None
    online:         bool               = False


class IMUState(BaseModel):
    """Live gyro angles relative to the calibrated home position."""
    imu_az:           float           = 0.0
    imu_el:           float           = 0.0
    calibrated:       bool            = False
    last_updated:     Optional[datetime] = None


class MovementVerification(BaseModel):
    """Latest movement verification result from the ESP32."""
    success:          Optional[bool]  = None   # None = no verification yet
    imu_az_delta:     float           = 0.0
    imu_el_delta:     float           = 0.0
    target_az:        float           = 0.0
    target_el:        float           = 0.0
    verified_at:      Optional[datetime] = None


class StationState(BaseModel):
    station_id:          str
    mode:                Mode                = Mode.AUTO
    connection:          ConnectionState     = ConnectionState()
    current_angles:      Angles              = Angles(azimuth=0.0, elevation=0.0)
    target_angles:       Optional[Angles]    = None
    command:             CommandState        = CommandState()
    error:               ErrorState          = ErrorState()
    signal_dbm:          float               = -99.0
    # ── IMU feedback fields ──────────────────────────────────────────────
    imu:                 IMUState            = IMUState()
    last_verification:   MovementVerification = MovementVerification()
    calibration_pending: bool                = False   # set by dashboard, cleared by ESP32 ack


class WeatherData(BaseModel):
    temperature: float
    wind_speed:  float
    rain:        float
    humidity:    float
    pressure:    float
    fetched_at:  Optional[datetime] = None


class EnvironmentalResponse(BaseModel):
    station_a:     WeatherData
    station_b:     WeatherData
    user_location: Optional[WeatherData] = None
    user_lat:      Optional[float]       = None
    user_lon:      Optional[float]       = None

# ─────────────────────────────────────────────────────────────────────────────
# SQLITE PERSISTENCE
# ─────────────────────────────────────────────────────────────────────────────

DB_PATH = "satellite.db"

def init_db():
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS env_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station_id TEXT, ts TEXT,
            temperature REAL, wind_speed REAL, rain REAL,
            humidity REAL, pressure REAL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS system_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, station_id TEXT, message TEXT, level TEXT DEFAULT 'INFO'
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS kpi_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, avg_signal_dbm REAL, realignments_hour REAL,
            downtime_reduction REAL, power_usage_w REAL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS imu_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, station_id TEXT,
            imu_az REAL, imu_el REAL,
            servo_az REAL, servo_el REAL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS verification_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, station_id TEXT,
            success INTEGER, imu_az_delta REAL, imu_el_delta REAL,
            target_az REAL, target_el REAL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS calibration_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, station_id TEXT, triggered_by TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS position_signal_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts          TEXT,
            station_id  TEXT,
            azimuth     REAL,
            elevation   REAL,
            signal_dbm  REAL
        )
    """)
    con.commit()
    con.close()


def db_exec(sql: str, params: tuple = ()):
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(sql, params)
    con.commit()
    con.close()


def db_fetch(sql: str, params: tuple = ()) -> list:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute(sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return rows


def log_to_db(station_id: str, message: str, level: str = "INFO"):
    ts = datetime.now(timezone.utc).isoformat()
    db_exec(
        "INSERT INTO system_log (ts, station_id, message, level) VALUES (?,?,?,?)",
        (ts, station_id, message, level)
    )


def persist_env(station_id: str, w: WeatherData):
    ts = datetime.now(timezone.utc).isoformat()
    db_exec(
        "INSERT INTO env_log (station_id, ts, temperature, wind_speed, rain, humidity, pressure) VALUES (?,?,?,?,?,?,?)",
        (ts, station_id, w.temperature, w.wind_speed, w.rain, w.humidity, w.pressure)
    )


def persist_imu(station_id: str, imu_az: float, imu_el: float, servo_az: float, servo_el: float):
    ts = datetime.now(timezone.utc).isoformat()
    db_exec(
        "INSERT INTO imu_log (ts, station_id, imu_az, imu_el, servo_az, servo_el) VALUES (?,?,?,?,?,?)",
        (ts, station_id, imu_az, imu_el, servo_az, servo_el)
    )

def persist_position_signal(station_id: str, azimuth: float, elevation: float, signal_dbm: float):
    ts = datetime.now(timezone.utc).isoformat()
    db_exec(
        "INSERT INTO position_signal_log (ts, station_id, azimuth, elevation, signal_dbm) VALUES (?,?,?,?,?)",
        (ts, station_id, azimuth, elevation, signal_dbm)
    )

def persist_verification(station_id: str, success: bool, imu_az_delta: float,
                          imu_el_delta: float, target_az: float, target_el: float):
    ts = datetime.now(timezone.utc).isoformat()
    db_exec(
        "INSERT INTO verification_log (ts, station_id, success, imu_az_delta, imu_el_delta, target_az, target_el) VALUES (?,?,?,?,?,?,?)",
        (ts, station_id, int(success), imu_az_delta, imu_el_delta, target_az, target_el)
    )

# ─────────────────────────────────────────────────────────────────────────────
# WEATHER
# ─────────────────────────────────────────────────────────────────────────────

async def fetch_weather(lat: float, lon: float) -> WeatherData:
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        "&current=temperature_2m,relative_humidity_2m,rain,wind_speed_10m,surface_pressure"
        "&wind_speed_unit=kmh"
    )
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url)
            r.raise_for_status()
            d = r.json()["current"]
            return WeatherData(
                temperature = d.get("temperature_2m",       25.0),
                wind_speed  = d.get("wind_speed_10m",       10.0),
                rain        = d.get("rain",                  0.0),
                humidity    = d.get("relative_humidity_2m", 60.0),
                pressure    = d.get("surface_pressure",   1013.0),
                fetched_at  = datetime.now(timezone.utc),
            )
    except Exception as e:
        print(f"[WEATHER] Failed ({lat},{lon}): {e}")
        return WeatherData(
            temperature=25.0, wind_speed=12.0, rain=0.0,
            humidity=65.0, pressure=1012.0,
            fetched_at=datetime.now(timezone.utc),
        )

# ─────────────────────────────────────────────────────────────────────────────
# APP
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="Satellite Realignment Backend v3 — IMU Feedback")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

stations: Dict[str, StationState] = {}
weather_cache: Dict[str, WeatherData] = {}
realignment_counts: Dict[str, int] = {}

# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def get_station(station_id: str) -> StationState:
    if station_id not in stations:
        stations[station_id] = StationState(station_id=station_id)
        log_to_db(station_id, f"Station initialised: {station_id}")
    return stations[station_id]

# ─────────────────────────────────────────────────────────────────────────────
# ESP32 ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

class HeartbeatIn(BaseModel):
    station_id: str
    mode:       Mode
    signal_dbm: Optional[float] = None
    azimuth:    Optional[float] = None
    elevation:  Optional[float] = None

@app.post("/esp32/heartbeat")
def heartbeat(data: HeartbeatIn):
    log_access(f"Heartbeat: {data.station_id}")
    station = get_station(data.station_id)
    station.connection.last_heartbeat = datetime.now(timezone.utc)
    station.connection.online = True

    if data.signal_dbm is not None:
        station.signal_dbm = data.signal_dbm

    if data.azimuth is not None and data.elevation is not None:
        prev_az = station.current_angles.azimuth
        prev_el = station.current_angles.elevation
        station.current_angles = Angles(azimuth=data.azimuth, elevation=data.elevation)

        # Log only when position actually changed (0.5° tolerance matches ANGLE_TOLERANCE)
        if abs(data.azimuth - prev_az) > 0.5 or abs(data.elevation - prev_el) > 0.5:
            persist_position_signal(
                data.station_id,
                data.azimuth,
                data.elevation,
                station.signal_dbm,   # use the stored value — already updated above
            )

    if station.mode != data.mode:
        log_state(f"Mode mismatch ESP32={data.mode} Backend={station.mode}", station)

    return {
        "status":              "ok",
        "authoritative_mode":  station.mode,
        "calibrate":           station.calibration_pending,
    }

@app.get("/esp32/state/{station_id}")
def esp32_get_state(station_id: str):
    return get_station(station_id)


class AngleUpdateIn(BaseModel):
    station_id: str
    azimuth:    float
    elevation:  float
    imu_az:     Optional[float] = None
    imu_el:     Optional[float] = None


@app.post("/esp32/update_angles")
def update_angles(data: AngleUpdateIn):
    station = get_station(data.station_id)
    station.current_angles = Angles(azimuth=data.azimuth, elevation=data.elevation)

    if data.imu_az is not None:
        station.imu.imu_az = data.imu_az
        station.imu.last_updated = datetime.now(timezone.utc)
    if data.imu_el is not None:
        station.imu.imu_el = data.imu_el

    persist_imu(
        data.station_id,
        data.imu_az or 0.0,
        data.imu_el or 0.0,
        data.azimuth,
        data.elevation,
    )

    if station.command.pending and station.target_angles:
        da = abs(station.current_angles.azimuth   - station.target_angles.azimuth)
        de = abs(station.current_angles.elevation - station.target_angles.elevation)
        if da <= ANGLE_TOLERANCE and de <= ANGLE_TOLERANCE:
            station.command.pending      = False
            station.command.acknowledged = True
            station.target_angles        = None
            log_to_db(station.station_id, "Servo realignment command completed")

    return {"status": "updated"}


class IMUUpdateIn(BaseModel):
    station_id: str
    imu_az:     float
    imu_el:     float
    calibrated: bool = False


@app.post("/esp32/imu_update")
def imu_update(data: IMUUpdateIn):
    """Receives the continuous IMU telemetry stream from the ESP32."""
    station = get_station(data.station_id)
    station.imu.imu_az       = data.imu_az
    station.imu.imu_el       = data.imu_el
    station.imu.calibrated   = data.calibrated
    station.imu.last_updated = datetime.now(timezone.utc)
    return {"status": "imu_received"}


class MovementVerifyIn(BaseModel):
    station_id:   str
    success:      bool
    imu_az_delta: float
    imu_el_delta: float
    target_az:    float
    target_el:    float


@app.post("/esp32/movement_verify")
def movement_verify(data: MovementVerifyIn):
    """
    ESP32 reports whether the servos actually moved to the commanded angles,
    determined by comparing the IMU delta to IMU_VERIFY_TOLERANCE.
    """
    station = get_station(data.station_id)
    station.last_verification = MovementVerification(
        success       = data.success,
        imu_az_delta  = data.imu_az_delta,
        imu_el_delta  = data.imu_el_delta,
        target_az     = data.target_az,
        target_el     = data.target_el,
        verified_at   = datetime.now(timezone.utc),
    )

    persist_verification(
        data.station_id, data.success,
        data.imu_az_delta, data.imu_el_delta,
        data.target_az, data.target_el,
    )

    level = "INFO" if data.success else "WARN"
    msg = (
        f"Movement verify {'OK' if data.success else 'FAILED'}: "
        f"IMU delta AZ={data.imu_az_delta:.1f}° EL={data.imu_el_delta:.1f}°"
    )
    log_to_db(data.station_id, msg, level)

    if not data.success:
        # Surface the failure as a soft error visible on dashboard
        station.error = ErrorState(
            has_error     = True,
            error_code    = "MOVE_VERIFY_FAIL",
            error_message = f"Servo did not reach target. IMU delta: AZ={data.imu_az_delta:.1f}° EL={data.imu_el_delta:.1f}°",
            timestamp     = datetime.now(timezone.utc),
        )

    return {"status": "verified", "success": data.success}


class CalibrateAckIn(BaseModel):
    station_id: str


@app.post("/esp32/calibrate_ack")
def calibrate_ack(data: CalibrateAckIn):
    """ESP32 confirms it has executed the calibration command."""
    station = get_station(data.station_id)
    station.calibration_pending = False
    station.imu.calibrated      = True
    station.imu.imu_az          = 0.0
    station.imu.imu_el          = 0.0
    log_to_db(data.station_id, "IMU home calibration confirmed by ESP32")
    return {"status": "calibration_acknowledged"}


class ErrorIn(BaseModel):
    station_id:    str
    error_code:    str
    error_message: str


@app.post("/esp32/error")
def report_error(data: ErrorIn):
    station = get_station(data.station_id)
    station.mode  = Mode.ERROR
    station.error = ErrorState(
        has_error     = True,
        error_code    = data.error_code,
        error_message = data.error_message,
        timestamp     = datetime.now(timezone.utc),
    )
    log_to_db(station.station_id, f"ERROR {data.error_code}: {data.error_message}", "ERROR")
    return {"status": "error_reported"}

# ─────────────────────────────────────────────────────────────────────────────
# DASHBOARD ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/dashboard/stations")
def get_all_stations():
    return stations


class ManualCommandIn(BaseModel):
    azimuth:   float = Field(..., ge=0, le=360)
    elevation: float = Field(..., ge=0, le=180)


@app.post("/dashboard/manual/{station_id}")
def manual_command(station_id: str, data: ManualCommandIn):
    station = get_station(station_id)
    if station.mode != Mode.MANUAL:
        raise HTTPException(400, "Station not in MANUAL mode")
    station.target_angles = Angles(azimuth=data.azimuth, elevation=data.elevation)
    station.command = CommandState(
        pending=True, issued_at=datetime.now(timezone.utc), acknowledged=False
    )
    realignment_counts[station_id] = realignment_counts.get(station_id, 0) + 1
    log_to_db(station_id, f"Manual command: az={data.azimuth} el={data.elevation}")
    return {"status": "command_issued"}


class ModeChangeIn(BaseModel):
    mode: Mode


@app.post("/dashboard/mode/{station_id}")
def change_mode(station_id: str, data: ModeChangeIn):
    station = get_station(station_id)
    station.mode = data.mode
    if data.mode != Mode.MANUAL:
        station.command       = CommandState()
        station.target_angles = None
    if data.mode != Mode.ERROR:
        station.error = ErrorState()
    log_to_db(station_id, f"Mode changed to {data.mode}")
    return {"status": "mode_changed"}


@app.post("/dashboard/reset_error/{station_id}")
def reset_error(station_id: str):
    station       = get_station(station_id)
    station.error = ErrorState()
    station.mode  = Mode.MAINT
    log_to_db(station_id, "Error cleared, mode set to MAINT")
    return {"status": "error_reset"}


@app.post("/dashboard/calibrate/{station_id}")
def trigger_calibration(station_id: str):
    """
    Dashboard operator presses 'Calibrate' for a station.
    This sets calibration_pending = True which the ESP32 polls
    and then executes the calibration on its side (setting home offsets).
    """
    station = get_station(station_id)
    station.calibration_pending = True
    ts = datetime.now(timezone.utc).isoformat()
    db_exec(
        "INSERT INTO calibration_log (ts, station_id, triggered_by) VALUES (?,?,?)",
        (ts, station_id, "dashboard")
    )
    log_to_db(station_id, "Calibration requested from dashboard")
    return {"status": "calibration_pending", "station_id": station_id}


@app.get("/dashboard/imu/{station_id}")
def get_imu_state(station_id: str):
    """Return current IMU angles and calibration state for a station."""
    station = get_station(station_id)
    return {
        "station_id":        station_id,
        "imu":               station.imu,
        "last_verification": station.last_verification,
        "calibration_pending": station.calibration_pending,
    }


@app.get("/dashboard/imu_history/{station_id}")
def get_imu_history(station_id: str, limit: int = 50):
    rows = db_fetch(
        "SELECT ts, imu_az, imu_el, servo_az, servo_el FROM imu_log WHERE station_id=? ORDER BY id DESC LIMIT ?",
        (station_id, limit)
    )
    return {"station_id": station_id, "history": rows}


@app.get("/dashboard/verification_log/{station_id}")
def get_verification_log(station_id: str, limit: int = 50):
    rows = db_fetch(
        "SELECT ts, success, imu_az_delta, imu_el_delta, target_az, target_el FROM verification_log WHERE station_id=? ORDER BY id DESC LIMIT ?",
        (station_id, limit)
    )
    return {"station_id": station_id, "verifications": rows}


@app.get("/dashboard/position_signal_log/{station_id}")
def get_position_signal_log(station_id: str, limit: int = 200):
    rows = db_fetch(
        "SELECT ts, azimuth, elevation, signal_dbm FROM position_signal_log "
        "WHERE station_id=? ORDER BY id DESC LIMIT ?",
        (station_id, limit)
    )
    return {"station_id": station_id, "records": rows}
# ─────────────────────────────────────────────────────────────────────────────
# ENVIRONMENTAL DATA
# ─────────────────────────────────────────────────────────────────────────────

class UserLocationIn(BaseModel):
    lat: Optional[float] = None
    lon: Optional[float] = None


@app.post("/environmental-data")
async def environmental_data(loc: UserLocationIn):
    coords_a = STATION_COORDS["station_1"]
    coords_b = STATION_COORDS["station_2"]

    weather_a, weather_b = await asyncio.gather(
        fetch_weather(coords_a["lat"], coords_a["lon"]),
        fetch_weather(coords_b["lat"], coords_b["lon"]),
    )
    persist_env("station_1", weather_a)
    persist_env("station_2", weather_b)

    weather_user = None
    if loc.lat is not None and loc.lon is not None:
        weather_user = await fetch_weather(loc.lat, loc.lon)

    return EnvironmentalResponse(
        station_a=weather_a, station_b=weather_b,
        user_location=weather_user, user_lat=loc.lat, user_lon=loc.lon,
    )

# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM STATUS
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/system-status")
def system_status():
    result = {}
    for sid, st in stations.items():
        result[sid] = {
            "station_id":          sid,
            "label":               STATION_COORDS.get(sid, {}).get("label", sid),
            "status":              "ONLINE" if st.connection.online else "OFFLINE",
            "signal_dbm":          st.signal_dbm,
            "azimuth":             st.current_angles.azimuth,
            "elevation":           st.current_angles.elevation,
            "mode":                st.mode,
            "has_error":           st.error.has_error,
            "error_message":       st.error.error_message,
            # IMU additions
            "imu_az":              st.imu.imu_az,
            "imu_el":              st.imu.imu_el,
            "imu_calibrated":      st.imu.calibrated,
            "calibration_pending": st.calibration_pending,
            "last_verify_ok":      st.last_verification.success,
        }

    if stations:
        sigs  = [s.signal_dbm for s in stations.values()]
        avg_s = sum(sigs) / len(sigs)
        total_r = sum(realignment_counts.values())
        ts = datetime.now(timezone.utc).isoformat()
        db_exec(
            "INSERT INTO kpi_log (ts, avg_signal_dbm, realignments_hour, downtime_reduction, power_usage_w) VALUES (?,?,?,?,?)",
            (ts, avg_s, total_r, 15.0, 48.5)
        )
    return result

# ─────────────────────────────────────────────────────────────────────────────
# LOGS
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/logs")
def get_logs(limit: int = 100):
    rows = db_fetch(
        "SELECT ts, station_id, message, level FROM system_log ORDER BY id DESC LIMIT ?",
        (limit,)
    )
    return {"logs": rows}

# ─────────────────────────────────────────────────────────────────────────────
# PDF REPORT
# ─────────────────────────────────────────────────────────────────────────────


def _build_pdf() -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            rightMargin=2*cm, leftMargin=2*cm,
                            topMargin=2*cm, bottomMargin=2*cm)

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("Title2", parent=styles["Title"],
                                 fontSize=20, spaceAfter=6,
                                 textColor=colors.HexColor("#0f172a"))
    h1   = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=14,
                           textColor=colors.HexColor("#1e40af"), spaceAfter=4, spaceBefore=12)
    body = styles["BodyText"]
    small = ParagraphStyle("Small", parent=body, fontSize=8, textColor=colors.grey)

    ts_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    story  = []

    story.append(Paragraph("Satellite Realignment System", title_style))
    story.append(Paragraph("Operational Report (with IMU Feedback)", styles["Heading2"]))
    story.append(Paragraph(f"Generated: {ts_str}", small))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#1e40af")))
    story.append(Spacer(1, 0.5*cm))

    # 1. Overview
    story.append(Paragraph("1. System Overview", h1))
    overview = [
        ["Parameter", "Value"],
        ["Stations Monitored", str(len(stations))],
        ["Online Stations",    str(sum(1 for s in stations.values() if s.connection.online))],
        ["IMU Feedback",       "Active (MPU-6050)"],
        ["Architecture",       "ESP32 → FastAPI → Dashboard"],
        ["Report Timestamp",   ts_str],
    ]
    t = Table(overview, colWidths=[7*cm, 9*cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR",  (0,0), (-1,0), colors.white),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 9),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID",       (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
        ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("RIGHTPADDING",(0,0), (-1,-1), 6),
    ]))
    story.append(t)
    story.append(Spacer(1, 0.4*cm))

    # 2. Station Status (now includes IMU)
    story.append(Paragraph("2. Station Status", h1))
    rows = [["Station", "Status", "Mode", "AZ (°)", "EL (°)", "IMU AZ (°)", "IMU EL (°)", "Signal (dBm)", "IMU Cal"]]
    for sid, st in stations.items():
        label = STATION_COORDS.get(sid, {}).get("label", sid)
        sig   = f"{st.signal_dbm:.1f}" if st.signal_dbm > -99 else "N/A"
        rows.append([
            label,
            "ONLINE" if st.connection.online else "OFFLINE",
            st.mode,
            f"{st.current_angles.azimuth:.1f}",
            f"{st.current_angles.elevation:.1f}",
            f"{st.imu.imu_az:.1f}",
            f"{st.imu.imu_el:.1f}",
            sig,
            "Yes" if st.imu.calibrated else "No",
        ])
    if len(rows) == 1:
        rows.append(["No stations", "-", "-", "-", "-", "-", "-", "-", "-"])
    t2 = Table(rows, colWidths=[3.2*cm, 1.8*cm, 1.6*cm, 1.6*cm, 1.6*cm, 2*cm, 2*cm, 2.2*cm, 1.5*cm])
    t2.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR",  (0,0), (-1,0), colors.white),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 7),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID",       (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
        ("ALIGN",      (1,0), (-1,-1), "CENTER"),
    ]))
    story.append(t2)
    story.append(Spacer(1, 0.4*cm))

    # 3. Movement Verifications
    story.append(Paragraph("3. Movement Verification Log", h1))
    v_rows = db_fetch(
        "SELECT ts, station_id, success, imu_az_delta, imu_el_delta, target_az, target_el FROM verification_log ORDER BY id DESC LIMIT 20"
    )
    vt = [["Time", "Station", "Result", "IMU AZ Δ (°)", "IMU EL Δ (°)", "Target AZ", "Target EL"]]
    for row in v_rows:
        vt.append([
            row["ts"][:16],
            STATION_COORDS.get(row["station_id"], {}).get("label", row["station_id"]),
            "OK" if row["success"] else "FAIL",
            f"{row['imu_az_delta']:.2f}",
            f"{row['imu_el_delta']:.2f}",
            f"{row['target_az']:.1f}°",
            f"{row['target_el']:.1f}°",
        ])
    if len(vt) == 1:
        vt.append(["No data", "-", "-", "-", "-", "-", "-"])
    t3 = Table(vt, colWidths=[3.5*cm, 3.5*cm, 1.5*cm, 2.5*cm, 2.5*cm, 2*cm, 2.5*cm])
    t3.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR",  (0,0), (-1,0), colors.white),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 7),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID",       (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
        ("ALIGN",      (2,0), (-1,-1), "CENTER"),
    ]))
    story.append(t3)
    story.append(Spacer(1, 0.4*cm))

    # 4. Position vs Signal log
    story.append(Paragraph("4. Position vs Signal Log", h1))
    ps_rows = db_fetch(
        "SELECT ts, station_id, azimuth, elevation, signal_dbm "
        "FROM position_signal_log ORDER BY id DESC LIMIT 50"
    )
    ps_table = [["Time", "Station", "AZ (°)", "EL (°)", "Signal (dBm)"]]
    for row in ps_rows:
        sig = f"{row['signal_dbm']:.1f}" if row['signal_dbm'] > -99 else "N/A"
        ps_table.append([
            row["ts"][:16],
            STATION_COORDS.get(row["station_id"], {}).get("label", row["station_id"]),
            f"{row['azimuth']:.1f}",
            f"{row['elevation']:.1f}",
            sig,
        ])
    if len(ps_table) == 1:
        ps_table.append(["No data", "-", "-", "-", "-"])
    t_ps = Table(ps_table, colWidths=[4*cm, 4.5*cm, 2.5*cm, 2.5*cm, 3.5*cm])
    t_ps.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR",  (0,0), (-1,0), colors.white),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 7),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID",       (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
        ("ALIGN",      (2,0), (-1,-1), "CENTER"),
    ]))
    story.append(t_ps)
    story.append(Spacer(1, 0.4*cm))

    # 5. Environmental
    story.append(Paragraph("4. Environmental Data", h1))
    env_rows_db = db_fetch(
        "SELECT station_id, ts, temperature, wind_speed, rain, humidity, pressure FROM env_log ORDER BY id DESC LIMIT 20"
    )
    env_table = [["Station", "Timestamp", "Temp (°C)", "Wind (km/h)", "Rain", "Humidity", "Pressure"]]
    for row in env_rows_db:
        env_table.append([
            STATION_COORDS.get(row["station_id"], {}).get("label", row["station_id"]),
            row["ts"][:16],
            f"{row['temperature']:.1f}",
            f"{row['wind_speed']:.1f}",
            f"{row['rain']:.1f}",
            f"{row['humidity']:.0f}%",
            f"{row['pressure']:.0f}",
        ])
    if len(env_table) == 1:
        env_table.append(["No data", "-", "-", "-", "-", "-", "-"])
    t4 = Table(env_table, colWidths=[3.8*cm, 3*cm, 2*cm, 2.2*cm, 2*cm, 2.2*cm, 2.3*cm])
    t4.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR",  (0,0), (-1,0), colors.white),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 7),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID",       (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
    ]))
    story.append(t4)
    story.append(Spacer(1, 0.4*cm))

    # 6. System Logs
    story.append(Paragraph("5. System Logs (Last 30)", h1))
    log_rows = db_fetch(
        "SELECT ts, station_id, level, message FROM system_log ORDER BY id DESC LIMIT 30"
    )
    log_table = [["Timestamp", "Station", "Level", "Message"]]
    for row in log_rows:
        log_table.append([row["ts"][:16], row["station_id"], row["level"], row["message"]])
    if len(log_table) == 1:
        log_table.append(["No logs", "-", "-", "-"])
    t5 = Table(log_table, colWidths=[3.5*cm, 3*cm, 2*cm, 9.5*cm])
    t5.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR",  (0,0), (-1,0), colors.white),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 7),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID",       (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
        ("VALIGN",     (0,0), (-1,-1), "TOP"),
    ]))
    story.append(t5)
    story.append(Spacer(1, 0.4*cm))

    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.grey))
    story.append(Paragraph("End of Report — Satellite Realignment System v3", small))

    doc.build(story)
    return buf.getvalue()


@app.get("/report/pdf")
def download_pdf():
    try:
        pdf_bytes = _build_pdf()
    except Exception as e:
        raise HTTPException(500, f"PDF generation failed: {e}")
    fname = f"satellite_report_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.pdf"
    return Response(content=pdf_bytes, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})

# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND TASKS
# ─────────────────────────────────────────────────────────────────────────────

async def heartbeat_monitor():
    while True:
        now = datetime.now(timezone.utc)
        for st in stations.values():
            if st.connection.last_heartbeat:
                if now - st.connection.last_heartbeat > HEARTBEAT_TIMEOUT:
                    if st.connection.online:
                        st.connection.online = False
                        log_to_db(st.station_id, "Station went OFFLINE (heartbeat timeout)", "WARN")
        await asyncio.sleep(1)


async def auto_weather_refresh():
    await asyncio.sleep(5)
    while True:
        for sid, coords in STATION_COORDS.items():
            w = await fetch_weather(coords["lat"], coords["lon"])
            persist_env(sid, w)
        await asyncio.sleep(300)


@app.on_event("startup")
async def startup():
    init_db()
    for sid in STATION_COORDS:
        get_station(sid)
    asyncio.create_task(heartbeat_monitor())
    asyncio.create_task(auto_weather_refresh())
    log_to_db("system", "Backend v3 started — IMU feedback active")