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
# ADD after "import httpx"
import numpy as np
from scipy.optimize import minimize

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

# ── SWEEP & OPTIMIZER CONSTANTS ───────────────────────────────────────────
SWEEP_AZ_START   = 10.0
SWEEP_AZ_END     = 150.0
SWEEP_EL_START   = 10.0
SWEEP_EL_END     = 150.0
SWEEP_AZ_STEP    = 70.0   # coarse grid spacing in degrees
SWEEP_EL_STEP    = 70.0
REDISCOVER_DROP_DBM   = 5.0    # dB drop triggers re-sweep
RECAL_VARIANCE_THRESH = 3.0    # dBm² sustained variance triggers re-sweep
RECAL_WINDOW          = 15     # how many recent samples to watch for instability
# ─────────────────────────────────────────────────────────────────────────

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

# ── ADD THIS ENTIRE BLOCK ─────────────────────────────────────────────────────
class OptimPhase(str, Enum):
    COARSE = "COARSE"
    REFINE = "REFINE"
    LOCK   = "LOCK"


class OptimSample(BaseModel):
    azimuth:    float
    elevation:  float
    signal_dbm: float


class OptimSession(BaseModel):
    active:          bool             = False
    phase:           OptimPhase       = OptimPhase.COARSE
    samples:         List[OptimSample]= []
    best_signal:     float            = -999.0
    best_az:         float            = 0.0
    best_el:         float            = 0.0
    iteration:       int              = 0
    last_commanded:  Optional[Angles] = None
    converged:       bool             = False
     # ── sweep fields ──────────────────────────────────────────────────────
    sweep_queue:     List[List[float]] = []   # list of [az, el] waypoints
    sweeping:        bool              = False
    sweep_reason:    str               = ""

# ─────────────────────────────────────────────────────────────────────────────





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

# ── ADD THIS ENTIRE FUNCTION ──────────────────────────────────────────────────
def fit_quadratic_peak(samples: List[OptimSample]):
    """
    Fit S = a·x² + b·y² + c·xy + d·x + e·y + f  via least squares.
    Returns (best_az, best_el) predicted peak, or None if underdetermined.
    Operates only on LOCAL samples — no global smoothness assumption.
    """
    if len(samples) < 6:
        return None   # need at least 6 points for 6 coefficients

    xs = np.array([s.azimuth    for s in samples])
    ys = np.array([s.elevation  for s in samples])
    zs = np.array([s.signal_dbm for s in samples])

    # Normalise to improve numerical conditioning
    x0, y0 = xs.mean(), ys.mean()
    xn, yn = xs - x0, ys - y0

    # Design matrix: [x² y² xy x y 1]
    A = np.column_stack([xn**2, yn**2, xn*yn, xn, yn, np.ones_like(xn)])
    try:
        coeffs, _, _, _ = np.linalg.lstsq(A, zs, rcond=None)
    except np.linalg.LinAlgError:
        return None

    a, b, c, d, e, _ = coeffs

    # Peak: solve ∂S/∂x = 2ax + cy + d = 0
    #              ∂S/∂y = 2by + cx + e = 0
    M = np.array([[2*a, c], [c, 2*b]])
    rhs = np.array([-d, -e])
    try:
        peak_norm = np.linalg.solve(M, rhs)
    except np.linalg.LinAlgError:
        return None

    # Check the Hessian is negative definite (actual maximum, not minimum)
    if a >= 0 or (4*a*b - c**2) <= 0:
        return None   # surface opens upward — no maximum here

    peak_az = float(peak_norm[0]) + x0
    peak_el = float(peak_norm[1]) + y0
    return peak_az, peak_el

def build_sweep_grid(
    az_start: float = SWEEP_AZ_START, az_end: float = SWEEP_AZ_END,
    el_start: float = SWEEP_EL_START, el_end: float = SWEEP_EL_END,
    az_step:  float = SWEEP_AZ_STEP,  el_step: float = SWEEP_EL_STEP,
) -> List[List[float]]:
    """
    Build a boustrophedon (snake) grid of (az, el) waypoints.
    Alternates direction each elevation row to minimise servo travel.
    """
    grid = []
    el = el_start
    row = 0
    while el <= el_end + 0.01:
        az_range = list(np.arange(az_start, az_end + 0.01, az_step))
        if row % 2 == 1:
            az_range = az_range[::-1]   # reverse alternate rows
        for az in az_range:
            grid.append([round(az, 1), round(el, 1)])
        el += el_step
        row += 1
    return grid


def build_local_sweep(center_az: float, center_el: float,
                      radius: float = 20.0, step: float = 5.0) -> List[List[float]]:
    """
    Small spiral grid around a known-good position.
    Used for recalibration after a disturbance — much faster than full sweep.
    """
    grid = []
    az_start = max(SWEEP_AZ_START, center_az - radius)
    az_end   = min(SWEEP_AZ_END,   center_az + radius)
    el_start = max(SWEEP_EL_START, center_el - radius)
    el_end   = min(SWEEP_EL_END,   center_el + radius)
    el = el_start
    row = 0
    while el <= el_end + 0.01:
        az_range = list(np.arange(az_start, az_end + 0.01, step))
        if row % 2 == 1:
            az_range = az_range[::-1]
        for az in az_range:
            grid.append([round(az, 1), round(el, 1)])
        el += step
        row += 1
    return grid

# ─────────────────────────────────────────────────────────────────────────────

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

optim_sessions: Dict[str, OptimSession] = {}   # ADD THIS LINE

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
    # ── OPTIMIZER HOOK ────────────────────────────────────────────────────────
    # ── OPTIMIZER HOOK ────────────────────────────────────────────────────────
    sess = optim_sessions.get(data.station_id)

    # Create session on first heartbeat from this station (not at server startup)
    if sess is None and station.mode == Mode.AUTO:
        grid = build_sweep_grid()
        sess = OptimSession(
            active       = True,
            phase        = OptimPhase.COARSE,
            samples      = [],
            best_signal  = data.signal_dbm if data.signal_dbm is not None else -999.0,
            best_az      = data.azimuth if data.azimuth is not None else station.current_angles.azimuth,
            best_el      = data.elevation if data.elevation is not None else station.current_angles.elevation,
            iteration    = 0,
            converged    = False,
            sweep_queue  = grid,
            sweeping     = True,
            sweep_reason = "boot sweep",
        )
        optim_sessions[data.station_id] = sess
        log_to_db(data.station_id,
                  f"ESP32 connected — boot sweep started ({len(grid)} waypoints)", "INFO")

    # Collect sample into active session
    if sess and sess.active and not sess.converged:
        if data.signal_dbm is not None and data.azimuth is not None and data.elevation is not None:
            sess.samples.append(OptimSample(
                azimuth    = data.azimuth,
                elevation  = data.elevation,
                signal_dbm = data.signal_dbm,
            ))
            if data.signal_dbm > sess.best_signal:
                sess.best_signal = data.signal_dbm
                sess.best_az     = data.azimuth
                sess.best_el     = data.elevation

    # While LOCKED: keep a rolling window of recent samples for disturbance detection
    # and track the current running signal so drop detection uses a live reference
    if sess and sess.converged:
        if data.signal_dbm is not None and data.azimuth is not None and data.elevation is not None:
            sess.samples.append(OptimSample(
                azimuth    = data.azimuth,
                elevation  = data.elevation,
                signal_dbm = data.signal_dbm,
            ))
            # Cap to avoid unbounded growth — keep last 60 samples
            if len(sess.samples) > 60:
                sess.samples = sess.samples[-60:]
    # ── END OPTIMIZER HOOK ───────────────────────────────────────────────────

    if station.mode != data.mode:
        log_state(f"Mode mismatch ESP32={data.mode} Backend={station.mode}", station)

    sess_now = optim_sessions.get(data.station_id)
    return {
        "status":              "ok",
        "authoritative_mode":  station.mode,
        "calibrate":           station.calibration_pending,
        "optim_phase":         sess_now.phase if sess_now else None,
        "optim_sweeping":      sess_now.sweeping if sess_now else False,
        "optim_converged":     sess_now.converged if sess_now else False,
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
# OPTIMIZER ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/optimizer/start/{station_id}")
def optimizer_start(station_id: str):
    """Initialise a new optimisation session for a station."""
    station = get_station(station_id)

    optim_sessions[station_id] = OptimSession(
        active      = True,
        phase       = OptimPhase.COARSE,
        samples     = [],
        best_signal = station.signal_dbm if station.signal_dbm > -99 else -999.0,
        best_az     = station.current_angles.azimuth,
        best_el     = station.current_angles.elevation,
        iteration   = 0,
        converged   = False,
    )
    # Ensure station is in AUTO so existing command plumbing works
    station.mode = Mode.AUTO
    log_to_db(station_id, "Optimizer started — COARSE phase", "INFO")
    return {"status": "optimizer_started", "station_id": station_id}


@app.post("/optimizer/step/{station_id}")
def optimizer_step(station_id: str):
    """
    Run one optimisation step:
      1. Fit quadratic surface to LOCAL samples near current best
      2. Predict peak angles
      3. Issue movement command via existing command system
    """
    sess = optim_sessions.get(station_id)
    if not sess or not sess.active:
        raise HTTPException(400, "No active optimizer session for this station")
    if sess.converged:
        return {"status": "already_converged", "best_az": sess.best_az, "best_el": sess.best_el}

    station = get_station(station_id)

    # ── Select LOCAL samples: within ±15° of current best ──────────────────
    LOCAL_WINDOW = 15.0
    local_samples = [
        s for s in sess.samples
        if abs(s.azimuth   - sess.best_az) <= LOCAL_WINDOW
        and abs(s.elevation - sess.best_el) <= LOCAL_WINDOW
    ]

    peak = fit_quadratic_peak(local_samples) if len(local_samples) >= 6 else None

    if peak is None:
        # Not enough data yet — nudge toward best known position with small offsets
        # to collect more samples around the neighbourhood
        NUDGE = 3.0
        sess.iteration += 1
        nudge_az = sess.best_az + (NUDGE if sess.iteration % 2 == 0 else -NUDGE)
        nudge_el = sess.best_el + (NUDGE if (sess.iteration // 2) % 2 == 0 else -NUDGE)
        target_az = float(np.clip(nudge_az, MIN_AZ, MAX_AZ))
        target_el = float(np.clip(nudge_el, MIN_EL, MAX_EL))
        reason = "nudge — collecting samples"
    else:
        # Clamp predicted peak to servo limits
        MIN_AZ, MAX_AZ = 10.0, 150.0
        MIN_EL, MAX_EL = 10.0, 150.0
        target_az = float(np.clip(peak[0], MIN_AZ, MAX_AZ))
        target_el = float(np.clip(peak[1], MIN_EL, MAX_EL))
        sess.phase = OptimPhase.REFINE
        sess.iteration += 1
        reason = "quadratic peak prediction"

    # ── Issue command via existing command system ────────────────────────────
    station.target_angles = Angles(azimuth=target_az, elevation=target_el)
    station.command = CommandState(
        pending=True,
        issued_at=datetime.now(timezone.utc),
        acknowledged=False,
    )
    sess.last_commanded = Angles(azimuth=target_az, elevation=target_el)

    log_to_db(station_id,
              f"Optimizer step {sess.iteration}: move to AZ={target_az:.1f} EL={target_el:.1f} [{reason}]")

    return {
        "status":      "command_issued",
        "iteration":   sess.iteration,
        "phase":       sess.phase,
        "target_az":   target_az,
        "target_el":   target_el,
        "reason":      reason,
        "sample_count": len(sess.samples),
        "local_count":  len(local_samples),
        "best_signal": sess.best_signal,
    }


@app.post("/optimizer/check/{station_id}")
def optimizer_check(station_id: str):
    """
    Check convergence:
      - Look at the last N samples near the best position
      - If RSSI variance is low → LOCK and stop
    """
    RECENT_N       = 10
    VAR_THRESHOLD  = 1.5    # dBm² — tune to your environment
    MIN_SAMPLES    = 10     # don't converge too early

    sess = optim_sessions.get(station_id)
    if not sess or not sess.active:
        raise HTTPException(400, "No active optimizer session for this station")

    if len(sess.samples) < MIN_SAMPLES:
        return {"status": "collecting", "sample_count": len(sess.samples)}

    # Take the most recent RECENT_N samples
    recent = sess.samples[-RECENT_N:]
    signals = [s.signal_dbm for s in recent]
    variance = float(np.var(signals))

    if variance <= VAR_THRESHOLD:
        sess.active    = False
        sess.converged = True
        sess.phase     = OptimPhase.LOCK
        log_to_db(station_id,
                  f"Optimizer LOCKED — best AZ={sess.best_az:.1f} EL={sess.best_el:.1f} "
                  f"signal={sess.best_signal:.1f} dBm (variance={variance:.2f})", "INFO")
        return {
            "status":       "converged",
            "best_az":      sess.best_az,
            "best_el":      sess.best_el,
            "best_signal":  sess.best_signal,
            "variance":     variance,
            "iterations":   sess.iteration,
        }

    return {
        "status":       "optimizing",
        "variance":     variance,
        "sample_count": len(sess.samples),
        "best_signal":  sess.best_signal,
        "phase":        sess.phase,
    }


@app.get("/optimizer/status/{station_id}")
def optimizer_status(station_id: str):
    """Read-only view of the current optimiser session."""
    sess = optim_sessions.get(station_id)
    if not sess:
        return {"active": False, "station_id": station_id}
    return sess


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
            # optimizer state
            "optim_phase":         optim_sessions[sid].phase if sid in optim_sessions else None,
            "optim_converged":     optim_sessions[sid].converged if sid in optim_sessions else None,
            "optim_best_signal":   optim_sessions[sid].best_signal if sid in optim_sessions else None,
            "optim_sweep_remaining": len(optim_sessions[sid].sweep_queue) if sid in optim_sessions else 0,
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

async def optimizer_loop():
    """
    Autonomous alignment loop. States:
      COARSE  → executing sweep_queue waypoints (boot sweep or recal sweep)
      REFINE  → quadratic regression homing
      LOCK    → holding; watching for disturbances
    """
    STEP_INTERVAL           = 4      # seconds between commands while refining
    CHECK_INTERVAL          = 3      # seconds between convergence checks
    LOCK_WATCH_INTERVAL     = 2      # seconds between disturbance checks while locked
    MIN_SAMPLES_FOR_REFINE  = 6      # minimum samples before attempting regression

    step_timers:  Dict[str, float] = {}
    check_timers: Dict[str, float] = {}
    watch_timers: Dict[str, float] = {}

    await asyncio.sleep(8)   # let stations connect and send first heartbeats

    while True:
        now = asyncio.get_event_loop().time()

        for station_id, sess in list(optim_sessions.items()):
            station = stations.get(station_id)
            if not station or station.mode != Mode.AUTO:
                continue

            # ── LOCKED: watch for disturbances ───────────────────────────
            if sess.converged:
                last_watch = watch_timers.get(station_id, 0)
                if now - last_watch < LOCK_WATCH_INTERVAL:
                    continue
                watch_timers[station_id] = now

                if len(sess.samples) < RECAL_WINDOW:
                    continue

                recent  = sess.samples[-RECAL_WINDOW:]
                signals = [s.signal_dbm for s in recent]
                current_signal = signals[-1]
                variance = float(np.var(signals))

                # Use rolling average of recent stable window as reference,
                # NOT the frozen best_signal from the sweep — that prevents
                # false triggers after signal naturally settles lower over time
                rolling_avg = sum(signals) / len(signals)
                drop_triggered     = current_signal < (rolling_avg - REDISCOVER_DROP_DBM)
                variance_triggered = variance > RECAL_VARIANCE_THRESH

                if drop_triggered or variance_triggered:
                    reason = (
                        f"signal drop {current_signal:.1f} vs best {sess.best_signal:.1f} dBm"
                        if drop_triggered
                        else f"variance {variance:.2f} dBm² exceeds threshold"
                    )
                    log_to_db(station_id, f"Disturbance detected ({reason}) — starting local recal sweep", "WARN")

                    # Local sweep around last known best — faster than full sweep
                    sess.sweep_queue  = build_local_sweep(sess.best_az, sess.best_el,
                                                          radius=25.0, step=12.5)
                    sess.sweeping     = True
                    sess.converged    = False
                    sess.active       = True
                    sess.phase        = OptimPhase.COARSE
                    sess.samples      = []
                    sess.iteration    = 0
                    sess.sweep_reason = reason
                continue   # handled above; skip refine logic

            if not sess.active:
                continue

            # ── COARSE: drain the sweep queue ────────────────────────────
            if sess.sweeping and sess.sweep_queue:
                if station.command.pending:
                    continue   # wait for ESP32 to finish current move

                waypoint = sess.sweep_queue.pop(0)
                target_az, target_el = waypoint[0], waypoint[1]

                station.target_angles = Angles(azimuth=target_az, elevation=target_el)
                station.command = CommandState(
                    pending=True,
                    issued_at=datetime.now(timezone.utc),
                    acknowledged=False,
                )
                sess.last_commanded = Angles(azimuth=target_az, elevation=target_el)
                sess.iteration += 1

                remaining = len(sess.sweep_queue)
                log_to_db(station_id,
                          f"[SWEEP] step={sess.iteration} → AZ={target_az} EL={target_el} "
                          f"remaining={remaining} reason='{sess.sweep_reason}'")

                # Sweep finished — transition to REFINE
                if not sess.sweep_queue:
                    sess.sweeping = False
                    sess.phase    = OptimPhase.REFINE
                    log_to_db(station_id,
                              f"Sweep complete — {len(sess.samples)} samples collected, entering REFINE")
                continue

            # ── REFINE: quadratic regression toward peak ──────────────────
            last_step = step_timers.get(station_id, 0)
            if now - last_step < STEP_INTERVAL:
                pass   # fall through to convergence check
            elif not station.command.pending and len(sess.samples) >= MIN_SAMPLES_FOR_REFINE:
                step_timers[station_id] = now

                MIN_AZ, MAX_AZ = SWEEP_AZ_START, SWEEP_AZ_END
                MIN_EL, MAX_EL = SWEEP_EL_START, SWEEP_EL_END
                LOCAL_WINDOW   = 20.0
                NUDGE          = 4.0

                local_samples = [
                    s for s in sess.samples
                    if abs(s.azimuth   - sess.best_az) <= LOCAL_WINDOW
                    and abs(s.elevation - sess.best_el) <= LOCAL_WINDOW
                ]

                peak = fit_quadratic_peak(local_samples) if len(local_samples) >= 6 else None

                if peak is None:
                    sess.iteration += 1
                    angle    = sess.iteration * 1.2
                    nudge_az = sess.best_az + NUDGE * np.cos(angle)
                    nudge_el = sess.best_el + NUDGE * np.sin(angle)
                    target_az = float(np.clip(nudge_az, MIN_AZ, MAX_AZ))
                    target_el = float(np.clip(nudge_el, MIN_EL, MAX_EL))
                    reason = "spiral nudge"
                else:
                    target_az = float(np.clip(peak[0], MIN_AZ, MAX_AZ))
                    target_el = float(np.clip(peak[1], MIN_EL, MAX_EL))
                    sess.phase = OptimPhase.REFINE
                    sess.iteration += 1
                    reason = "quadratic peak"

                station.target_angles = Angles(azimuth=target_az, elevation=target_el)
                station.command = CommandState(
                    pending=True,
                    issued_at=datetime.now(timezone.utc),
                    acknowledged=False,
                )
                sess.last_commanded = Angles(azimuth=target_az, elevation=target_el)
                log_to_db(station_id,
                          f"[REFINE] step={sess.iteration} → AZ={target_az:.1f} EL={target_el:.1f} "
                          f"[{reason}] samples={len(sess.samples)}")

            # ── CONVERGENCE CHECK ─────────────────────────────────────────
            last_check = check_timers.get(station_id, 0)
            if now - last_check >= CHECK_INTERVAL and len(sess.samples) >= 10:
                check_timers[station_id] = now
                recent   = sess.samples[-10:]
                signals  = [s.signal_dbm for s in recent]
                variance = float(np.var(signals))

                if variance <= 1.5:
                    sess.active    = False
                    sess.converged = True
                    sess.phase     = OptimPhase.LOCK
                    log_to_db(station_id,
                              f"LOCKED — AZ={sess.best_az:.1f} EL={sess.best_el:.1f} "
                              f"signal={sess.best_signal:.1f} dBm var={variance:.2f}", "INFO")

        await asyncio.sleep(0.5)

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
        # DO NOT pre-create optim_sessions here.
        # Sessions are created on first ESP32 heartbeat so the
        # sweep starts from the actual boot position, not server start.
    asyncio.create_task(heartbeat_monitor())
    asyncio.create_task(auto_weather_refresh())
    log_to_db("system", "Backend v3 started — IMU feedback active")
    asyncio.create_task(optimizer_loop())