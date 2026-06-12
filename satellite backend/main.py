"""
Satellite Realignment Backend — v4 (Coordinated Sweep + Collective Lock)
Changes from v3:
  - Sweep only starts when BOTH stations are online
  - Station sweeps are mirrored (one L→R, other R→L simultaneously)
  - Lock position chosen from collective best: highest combined signal
    across all paired (station_1_sample, station_2_sample) readings
    taken at the same sweep step index, not individual bests
"""

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from enum import Enum
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timedelta, timezone
import asyncio
import json
import sqlite3
import httpx
import io
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
ANGLE_TOLERANCE     = 0.5
IMU_VERIFY_TOLERANCE = 3.0

SWEEP_AZ_START   = 10.0
SWEEP_AZ_END     = 150.0
SWEEP_EL_START   = 10.0
SWEEP_EL_END     = 150.0
SWEEP_AZ_STEP    = 20.0
SWEEP_EL_STEP    = 20.0

REDISCOVER_DROP_DBM   = 10.0    # drop beyond this many dB below lock triggers recal
RECAL_VARIANCE_THRESH = 8.0
RECAL_WINDOW          = 10     # smaller window = faster reaction to drops
RECAL_SCHEDULED_SECS  = 120
RECAL_MIN_SIGNAL_DBM  = -75.0

# ── Recal sweep size (3×3 instead of original 5×5) ───────────────────────────
RECAL_AZ_STEP  = 46.7   # (150-10)/3 ≈ 46.7° gives 3 columns across the range
RECAL_EL_STEP  = 46.7   # same for elevation → true 3×3 = 9 waypoints total

LOG_LEVEL = "STATE"  # OFF | ACCESS | STATE

# The two station IDs that must BOTH be online before any sweep starts.
# Order matters for mirroring: index-0 sweeps forward, index-1 sweeps mirrored.
STATION_PAIR = ["station_1", "station_2"]

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
    imu_az:       float            = 0.0
    imu_el:       float            = 0.0
    calibrated:   bool             = False
    last_updated: Optional[datetime] = None


class MovementVerification(BaseModel):
    success:      Optional[bool]   = None
    imu_az_delta: float            = 0.0
    imu_el_delta: float            = 0.0
    target_az:    float            = 0.0
    target_el:    float            = 0.0
    verified_at:  Optional[datetime] = None


class OptimPhase(str, Enum):
    IDLE   = "IDLE"    # waiting for both stations to come online
    COARSE = "COARSE"
    REFINE = "REFINE"
    LOCK   = "LOCK"


class OptimSample(BaseModel):
    azimuth:    float
    elevation:  float
    signal_dbm: float
    # step_index ties samples from both stations taken at the same sweep step
    step_index: int = -1


class OptimSession(BaseModel):
    active:           bool              = False
    phase:            OptimPhase        = OptimPhase.IDLE
    samples:          List[OptimSample] = []
    best_signal:      float             = -999.0
    best_az:          float             = 0.0
    best_el:          float             = 0.0
    # Collective best — set once both stations have agreed on a lock point
    collective_best_az:     float       = 0.0
    collective_best_el:     float       = 0.0
    collective_best_signal: float       = -999.0
    # Second-best position — used as first probe target when recal triggers
    second_best_az:         float       = 0.0
    second_best_el:         float       = 0.0
    second_best_signal:     float       = -999.0
    iteration:        int               = 0
    last_commanded:   Optional[Angles]  = None
    converged:        bool              = False
    locked_at:        Optional[float]   = None
    sweep_queue:      List[List[float]] = []
    sweeping:         bool              = False
    sweep_reason:     str               = ""
    waiting_to_lock:  bool              = False
    # Which role this station plays in the current sweep pair
    # "forward"  → az ascending per row
    # "mirrored" → az descending per row (reversed within each row)
    sweep_role:       str               = "forward"


class StationState(BaseModel):
    station_id:          str
    mode:                Mode                 = Mode.AUTO
    connection:          ConnectionState      = ConnectionState()
    current_angles:      Angles               = Angles(azimuth=0.0, elevation=0.0)
    target_angles:       Optional[Angles]     = None
    command:             CommandState         = CommandState()
    error:               ErrorState           = ErrorState()
    signal_dbm:          float                = -99.0
    imu:                 IMUState             = IMUState()
    last_verification:   MovementVerification = MovementVerification()
    calibration_pending: bool                 = False


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
    cur.execute("""CREATE TABLE IF NOT EXISTS env_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        station_id TEXT, ts TEXT,
        temperature REAL, wind_speed REAL, rain REAL,
        humidity REAL, pressure REAL)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS system_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT, station_id TEXT, message TEXT, level TEXT DEFAULT 'INFO')""")
    cur.execute("""CREATE TABLE IF NOT EXISTS kpi_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT, avg_signal_dbm REAL, realignments_hour REAL,
        downtime_reduction REAL, power_usage_w REAL)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS imu_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT, station_id TEXT,
        imu_az REAL, imu_el REAL,
        servo_az REAL, servo_el REAL)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS verification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT, station_id TEXT,
        success INTEGER, imu_az_delta REAL, imu_el_delta REAL,
        target_az REAL, target_el REAL)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS calibration_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT, station_id TEXT, triggered_by TEXT)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS position_signal_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT,
        station_id TEXT,
        azimuth    REAL,
        elevation  REAL,
        signal_dbm REAL)""")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS collective_lock_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ts              TEXT,
            step_index      INTEGER,
            s1_az           REAL,
            s1_el           REAL,
            s1_signal       REAL,
            s2_az           REAL,
            s2_el           REAL,
            s2_signal       REAL,
            combined_score  REAL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS optimizer_reading_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts          TEXT,
            station_id  TEXT,
            phase       TEXT,        -- COARSE | REFINE | LOCK
            step_index  INTEGER,     -- sweep step number (-1 for refine/lock)
            commanded_az  REAL,      -- angle we sent to the servo
            commanded_el  REAL,
            reported_az   REAL,      -- angle the ESP32 actually reported back
            reported_el   REAL,
            signal_dbm    REAL,      -- RSSI at that position
            sweep_role    TEXT,      -- forward | mirrored
            reason        TEXT       -- why this point was chosen
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


def persist_optimizer_reading(
    station_id: str,
    phase: str,
    step_index: int,
    commanded_az: float,
    commanded_el: float,
    signal_dbm: float,
    sweep_role: str,
    reason: str,
    reported_az: float = 0.0,
    reported_el: float = 0.0,
):
    """
    Write one optimizer waypoint dispatch to optimizer_reading_log.
    Called at every COARSE sweep step, every REFINE nudge, and at LOCK.
    reported_az/el are filled in later by the heartbeat sample collector
    but we log the command immediately so nothing is ever lost.
    """
    ts = datetime.now(timezone.utc).isoformat()
    db_exec(
        "INSERT INTO optimizer_reading_log "
        "(ts, station_id, phase, step_index, commanded_az, commanded_el, "
        " reported_az, reported_el, signal_dbm, sweep_role, reason) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (ts, station_id, phase, step_index,
         commanded_az, commanded_el,
         reported_az, reported_el,
         signal_dbm, sweep_role, reason)
    )

# ─────────────────────────────────────────────────────────────────────────────
# SWEEP GRID HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def build_sweep_grid(
    az_start: float = SWEEP_AZ_START, az_end: float = SWEEP_AZ_END,
    el_start: float = SWEEP_EL_START, el_end: float = SWEEP_EL_END,
    az_step:  float = SWEEP_AZ_STEP,  el_step: float = SWEEP_EL_STEP,
    mirrored: bool  = False,
) -> List[List[float]]:
    """
    Build a boustrophedon (snake) grid of [az, el, step_index] waypoints.

    mirrored=True  → each row's azimuth direction is flipped relative to the
                     normal (forward) grid so the two stations sweep toward
                     each other on every row, keeping them roughly face-to-face
                     throughout the entire coarse scan.

    step_index is shared between the two grids: waypoint 0 on station_1
    corresponds to waypoint 0 on station_2, etc.
    """
    grid = []
    el = el_start
    row = 0
    step = 0
    while el <= el_end + 0.01:
        az_range = list(np.arange(az_start, az_end + 0.01, az_step))

        if mirrored:
            # Mirror: odd rows go forward, even rows go backward (opposite of forward grid)
            if row % 2 == 0:
                az_range = az_range[::-1]
        else:
            # Forward (normal boustrophedon): even rows forward, odd rows backward
            if row % 2 == 1:
                az_range = az_range[::-1]

        for az in az_range:
            grid.append([round(az, 1), round(el, 1), step])
            step += 1
        el += el_step
        row += 1
    return grid


def build_local_sweep(center_az: float, center_el: float,
                      radius: float = 20.0, step_size: float = 5.0,
                      mirrored: bool = False) -> List[List[float]]:
    """Small grid around a known-good position for recalibration."""
    az_start = max(SWEEP_AZ_START, center_az - radius)
    az_end   = min(SWEEP_AZ_END,   center_az + radius)
    el_start = max(SWEEP_EL_START, center_el - radius)
    el_end   = min(SWEEP_EL_END,   center_el + radius)

    grid = []
    el = el_start
    row = 0
    step = 0
    while el <= el_end + 0.01:
        az_range = list(np.arange(az_start, az_end + 0.01, step_size))
        if mirrored:
            if row % 2 == 0:
                az_range = az_range[::-1]
        else:
            if row % 2 == 1:
                az_range = az_range[::-1]
        for az in az_range:
            grid.append([round(az, 1), round(el, 1), step])
            step += 1
        el += step_size
        row += 1
    return grid

# ─────────────────────────────────────────────────────────────────────────────
# COLLECTIVE BEST — the heart of v4
# ─────────────────────────────────────────────────────────────────────────────

def compute_collective_best(
    sess1: "OptimSession",
    sess2: "OptimSession",
) -> Optional[Tuple[int, float, float, float, float, float]]:
    """
    Find the position pair where the *combined* signal is best.

    Combined score = min(s1_dbm, s2_dbm)  — maximise the weakest link.
    Tiebreaker = sum(s1_dbm + s2_dbm).

    TWO PAIRING STRATEGIES, both evaluated, best overall wins:

    Strategy A — COARSE step_index pairing (original):
        Samples tagged with the same step_index were captured while both
        servos were at their respective waypoints simultaneously.  Pure and
        reliable but only covers the coarse grid.

    Strategy B — REFINE proximity pairing:
        Refine samples (step_index = -1) are the highest-quality readings
        because the quadratic fit has already zoomed in.  We pair each
        refine sample from sess1 with the closest-in-time refine sample
        from sess2 (within a 10-second window) to form candidate pairs.
        This ensures the lock uses the best position found during REFINE,
        not just the coarsest grid point.

    The winning pair from A and B is returned.

    Returns:
        (step_index, s1_az, s1_el, s2_az, s2_el, combined_score)
        step_index is -1 for refine-derived pairs.
    or None if no pairs can be formed.
    """
    best_score: float = -1e9
    best_step:  int   = -1
    best_s1: Optional[OptimSample] = None
    best_s2: Optional[OptimSample] = None

    # ── Strategy A: coarse step_index pairs ──────────────────────────────────
    def index_by_step(sess: "OptimSession") -> Dict[int, OptimSample]:
        best: Dict[int, OptimSample] = {}
        for s in sess.samples:
            if s.step_index < 0:
                continue
            if s.step_index not in best or s.signal_dbm > best[s.step_index].signal_dbm:
                best[s.step_index] = s
        return best

    idx1 = index_by_step(sess1)
    idx2 = index_by_step(sess2)
    for step in set(idx1.keys()) & set(idx2.keys()):
        s1, s2   = idx1[step], idx2[step]
        score    = min(s1.signal_dbm, s2.signal_dbm)
        tiebreak = s1.signal_dbm + s2.signal_dbm
        cur_tb   = (best_s1.signal_dbm + best_s2.signal_dbm
                    if best_s1 and best_s2 else -1e9)
        if score > best_score or (score == best_score and tiebreak > cur_tb):
            best_score, best_step, best_s1, best_s2 = score, step, s1, s2

    # ── Strategy B: refine proximity pairs ───────────────────────────────────
    # Keep only the single best refine sample per station (highest signal_dbm).
    # These represent where each station's quadratic fit converged — the true
    # per-station optimum.  We then pair them directly: they were captured
    # during the same REFINE phase, so the pairing is semantically valid.
    refine1 = [s for s in sess1.samples if s.step_index < 0]
    refine2 = [s for s in sess2.samples if s.step_index < 0]

    if refine1 and refine2:
        # Best individual refine reading for each station
        r1 = max(refine1, key=lambda s: s.signal_dbm)
        r2 = max(refine2, key=lambda s: s.signal_dbm)
        score    = min(r1.signal_dbm, r2.signal_dbm)
        tiebreak = r1.signal_dbm + r2.signal_dbm
        cur_tb   = (best_s1.signal_dbm + best_s2.signal_dbm
                    if best_s1 and best_s2 else -1e9)
        if score > best_score or (score == best_score and tiebreak > cur_tb):
            best_score, best_step, best_s1, best_s2 = score, -1, r1, r2

    if best_s1 is None or best_s2 is None:
        return None

    return (best_step,
            best_s1.azimuth, best_s1.elevation,
            best_s2.azimuth, best_s2.elevation,
            best_score)

# ─────────────────────────────────────────────────────────────────────────────
# QUADRATIC SURFACE PEAK FIT (unchanged from v3)
# ─────────────────────────────────────────────────────────────────────────────

def fit_quadratic_peak(samples: List[OptimSample]):
    if len(samples) < 6:
        return None
    xs = np.array([s.azimuth    for s in samples])
    ys = np.array([s.elevation  for s in samples])
    zs = np.array([s.signal_dbm for s in samples])
    x0, y0 = xs.mean(), ys.mean()
    xn, yn = xs - x0, ys - y0
    A = np.column_stack([xn**2, yn**2, xn*yn, xn, yn, np.ones_like(xn)])
    try:
        coeffs, _, _, _ = np.linalg.lstsq(A, zs, rcond=None)
    except np.linalg.LinAlgError:
        return None
    a, b, c, d, e, _ = coeffs
    M   = np.array([[2*a, c], [c, 2*b]])
    rhs = np.array([-d, -e])
    try:
        peak_norm = np.linalg.solve(M, rhs)
    except np.linalg.LinAlgError:
        return None
    if a >= 0 or (4*a*b - c**2) <= 0:
        return None
    return float(peak_norm[0]) + x0, float(peak_norm[1]) + y0

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

app = FastAPI(title="Satellite Realignment Backend v4 — Coordinated Sweep")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

stations:           Dict[str, StationState]  = {}
weather_cache:      Dict[str, WeatherData]   = {}
realignment_counts: Dict[str, int]           = {}
optim_sessions:     Dict[str, OptimSession]  = {}

# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def get_station(station_id: str) -> StationState:
    if station_id not in stations:
        stations[station_id] = StationState(station_id=station_id)
        log_to_db(station_id, f"Station initialised: {station_id}")
    return stations[station_id]


def both_stations_online() -> bool:
    """True only when every station in STATION_PAIR has a live heartbeat."""
    return all(
        stations.get(sid) and stations[sid].connection.online
        for sid in STATION_PAIR
    )


def _maybe_start_coordinated_sweep():
    """
    Called after every heartbeat.  If both stations are now online and neither
    has an active session yet, create PAIRED sessions with mirrored grids and
    shared step_index values so collective scoring works correctly.
    """
    if not both_stations_online():
        return
    # Don't restart if sessions are already running / converged
    for sid in STATION_PAIR:
        if sid in optim_sessions and (
            optim_sessions[sid].active or optim_sessions[sid].converged
        ):
            return

    grid_forward  = build_sweep_grid(mirrored=False)
    grid_mirrored = build_sweep_grid(mirrored=True)

    for i, sid in enumerate(STATION_PAIR):
        station = get_station(sid)
        grid = grid_forward if i == 0 else grid_mirrored
        role = "forward"     if i == 0 else "mirrored"
        sess = OptimSession(
            active       = True,
            phase        = OptimPhase.COARSE,
            samples      = [],
            best_signal  = station.signal_dbm if station.signal_dbm > -99 else -999.0,
            best_az      = station.current_angles.azimuth,
            best_el      = station.current_angles.elevation,
            iteration    = 0,
            converged    = False,
            sweep_queue  = grid,
            sweeping     = True,
            sweep_reason = "boot sweep (coordinated)",
            sweep_role   = role,
        )
        optim_sessions[sid] = sess
        log_to_db(sid,
                  f"Coordinated boot sweep started — role={role} "
                  f"({len(grid)} waypoints)", "INFO")

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
        if abs(data.azimuth - prev_az) > 0.5 or abs(data.elevation - prev_el) > 0.5:
            persist_position_signal(data.station_id, data.azimuth, data.elevation, station.signal_dbm)

    # Try to start coordinated sweep if both stations are now online
    _maybe_start_coordinated_sweep()

    # Collect sample into active session
    sess = optim_sessions.get(data.station_id)
    if sess and sess.active and not sess.converged:
        if data.signal_dbm is not None and data.azimuth is not None and data.elevation is not None:
            # Determine step_index from the last commanded waypoint
            step_idx = -1
            if sess.last_commanded is not None and sess.sweep_queue is not None:
                # Use iteration count as step proxy — it is incremented each time
                # a sweep waypoint is dispatched, so samples collected after step N
                # are tagged with N.
                step_idx = sess.iteration
            sess.samples.append(OptimSample(
                azimuth    = data.azimuth,
                elevation  = data.elevation,
                signal_dbm = data.signal_dbm,
                step_index = step_idx,
            ))
            if data.signal_dbm > sess.best_signal:
                # Demote current best to second-best before overwriting
                if sess.best_signal > sess.second_best_signal:
                    sess.second_best_signal = sess.best_signal
                    sess.second_best_az     = sess.best_az
                    sess.second_best_el     = sess.best_el
                sess.best_signal = data.signal_dbm
                sess.best_az     = data.azimuth
                sess.best_el     = data.elevation
            elif data.signal_dbm > sess.second_best_signal and (
                abs(data.azimuth   - sess.best_az) > 5.0 or
                abs(data.elevation - sess.best_el) > 5.0
            ):
                # Only update second-best if it's at a meaningfully different position
                # (avoids second-best being virtually the same spot as best)
                sess.second_best_signal = data.signal_dbm
                sess.second_best_az     = data.azimuth
                sess.second_best_el     = data.elevation

    # Rolling window for disturbance detection while LOCKED
    if sess and sess.converged:
        if data.signal_dbm is not None and data.azimuth is not None and data.elevation is not None:
            sess.samples.append(OptimSample(
                azimuth    = data.azimuth,
                elevation  = data.elevation,
                signal_dbm = data.signal_dbm,
                step_index = -1,
            ))
            if len(sess.samples) > 60:
                sess.samples = sess.samples[-60:]

    if station.mode != data.mode:
        log_state(f"Mode mismatch ESP32={data.mode} Backend={station.mode}", station)

    sess_now = optim_sessions.get(data.station_id)
    return {
        "status":              "ok",
        "authoritative_mode":  station.mode,
        "calibrate":           station.calibration_pending,
        "optim_phase":         sess_now.phase        if sess_now else None,
        "optim_sweeping":      sess_now.sweeping      if sess_now else False,
        "optim_converged":     sess_now.converged     if sess_now else False,
        "both_online":         both_stations_online(),
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
    persist_imu(data.station_id, data.imu_az or 0.0, data.imu_el or 0.0,
                data.azimuth, data.elevation)
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
    station = get_station(data.station_id)
    station.last_verification = MovementVerification(
        success       = data.success,
        imu_az_delta  = data.imu_az_delta,
        imu_el_delta  = data.imu_el_delta,
        target_az     = data.target_az,
        target_el     = data.target_el,
        verified_at   = datetime.now(timezone.utc),
    )
    persist_verification(data.station_id, data.success,
                         data.imu_az_delta, data.imu_el_delta,
                         data.target_az, data.target_el)
    level = "INFO" if data.success else "WARN"
    msg = (f"Movement verify {'OK' if data.success else 'FAILED'}: "
           f"IMU delta AZ={data.imu_az_delta:.1f}° EL={data.imu_el_delta:.1f}°")
    log_to_db(data.station_id, msg, level)
    if not data.success:
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
    station = get_station(station_id)
    return {
        "station_id":          station_id,
        "imu":                 station.imu,
        "last_verification":   station.last_verification,
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


@app.get("/dashboard/collective_lock_log")
def get_collective_lock_log(limit: int = 50):
    """History of every collective lock decision — what step won and why."""
    rows = db_fetch(
        "SELECT ts, step_index, s1_az, s1_el, s1_signal, s2_az, s2_el, s2_signal, combined_score "
        "FROM collective_lock_log ORDER BY id DESC LIMIT ?",
        (limit,)
    )
    return {"records": rows}


@app.get("/dashboard/optimizer_readings/{station_id}")
def get_optimizer_readings(station_id: str, limit: int = 500):
    """
    Full optimizer reading log for one station — every COARSE, REFINE, and LOCK
    waypoint dispatch with the signal that was recorded at that position.
    Use this to troubleshoot sweep quality and convergence behaviour.
    """
    rows = db_fetch(
        "SELECT ts, phase, step_index, commanded_az, commanded_el, "
        "       reported_az, reported_el, signal_dbm, sweep_role, reason "
        "FROM optimizer_reading_log "
        "WHERE station_id=? ORDER BY id DESC LIMIT ?",
        (station_id, limit)
    )
    return {"station_id": station_id, "readings": rows}


@app.get("/dashboard/optimizer_readings_all")
def get_optimizer_readings_all(limit: int = 1000):
    """All stations combined, most recent first — useful for side-by-side comparison."""
    rows = db_fetch(
        "SELECT ts, station_id, phase, step_index, commanded_az, commanded_el, "
        "       reported_az, reported_el, signal_dbm, sweep_role, reason "
        "FROM optimizer_reading_log ORDER BY id DESC LIMIT ?",
        (limit,)
    )
    return {"readings": rows}

# ─────────────────────────────────────────────────────────────────────────────
# OPTIMIZER ENDPOINTS  (status / manual start)
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/optimizer/start/{station_id}")
def optimizer_start(station_id: str):
    """
    Manually re-trigger the coordinated sweep for a specific station.
    Both stations must be online; calling this for one side restarts both
    so the grids stay paired.
    """
    if not both_stations_online():
        raise HTTPException(400, "Both stations must be online before starting sweep")

    # Wipe existing sessions so _maybe_start_coordinated_sweep recreates them
    for sid in STATION_PAIR:
        optim_sessions.pop(sid, None)
    _maybe_start_coordinated_sweep()
    return {"status": "coordinated_sweep_started", "station_id": station_id}


@app.get("/optimizer/status/{station_id}")
def optimizer_status(station_id: str):
    sess = optim_sessions.get(station_id)
    if not sess:
        return {"active": False, "station_id": station_id,
                "waiting_for_partner": not both_stations_online()}
    return sess


@app.get("/optimizer/collective_best")
def optimizer_collective_best():
    """
    Return the current collective best position for each station pair,
    computed live from in-memory samples.
    """
    sid1, sid2 = STATION_PAIR
    sess1 = optim_sessions.get(sid1)
    sess2 = optim_sessions.get(sid2)
    if not sess1 or not sess2:
        return {"available": False, "reason": "Sessions not yet initialised"}

    result = compute_collective_best(sess1, sess2)
    if result is None:
        return {"available": False, "reason": "No matching step indices yet"}

    step_idx, s1_az, s1_el, s2_az, s2_el, score = result
    return {
        "available":      True,
        "step_index":     step_idx,
        "station_1":      {"az": s1_az, "el": s1_el},
        "station_2":      {"az": s2_az, "el": s2_el},
        "combined_score": score,
    }

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
        sess = optim_sessions.get(sid)
        result[sid] = {
            "station_id":              sid,
            "label":                   STATION_COORDS.get(sid, {}).get("label", sid),
            "status":                  "ONLINE" if st.connection.online else "OFFLINE",
            "signal_dbm":              st.signal_dbm,
            "azimuth":                 st.current_angles.azimuth,
            "elevation":               st.current_angles.elevation,
            "mode":                    st.mode,
            "has_error":               st.error.has_error,
            "error_message":           st.error.error_message,
            "imu_az":                  st.imu.imu_az,
            "imu_el":                  st.imu.imu_el,
            "imu_calibrated":          st.imu.calibrated,
            "calibration_pending":     st.calibration_pending,
            "last_verify_ok":          st.last_verification.success,
            "both_online":             both_stations_online(),
            "optim_phase":             sess.phase            if sess else None,
            "optim_converged":         sess.converged         if sess else None,
            "optim_sweep_role":        sess.sweep_role        if sess else None,
            "optim_best_signal":       sess.best_signal       if sess else None,
            "optim_collective_signal": sess.collective_best_signal if sess else None,
            "optim_sweep_remaining":   len(sess.sweep_queue)  if sess else 0,
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
    styles    = getSampleStyleSheet()
    title_style = ParagraphStyle("Title2", parent=styles["Title"], fontSize=20, spaceAfter=6,
                                 textColor=colors.HexColor("#0f172a"))
    h1   = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=14,
                           textColor=colors.HexColor("#1e40af"), spaceAfter=4, spaceBefore=12)
    body = styles["BodyText"]
    small = ParagraphStyle("Small", parent=body, fontSize=8, textColor=colors.grey)

    ts_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    story  = []

    story.append(Paragraph("Satellite Realignment System", title_style))
    story.append(Paragraph("Operational Report (v4 — Coordinated Sweep / Collective Lock)", styles["Heading2"]))
    story.append(Paragraph(f"Generated: {ts_str}", small))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#1e40af")))
    story.append(Spacer(1, 0.5*cm))

    story.append(Paragraph("1. System Overview", h1))
    overview = [
        ["Parameter", "Value"],
        ["Stations Monitored",  str(len(stations))],
        ["Online Stations",     str(sum(1 for s in stations.values() if s.connection.online))],
        ["Both Stations Online",str(both_stations_online())],
        ["IMU Feedback",        "Active (MPU-6050)"],
        ["Sweep Strategy",      "Coordinated mirror sweep — collective lock"],
        ["Report Timestamp",    ts_str],
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

    story.append(Paragraph("2. Station Status", h1))
    rows = [["Station", "Status", "Mode", "AZ (°)", "EL (°)", "IMU AZ", "IMU EL",
             "Signal (dBm)", "Sweep Role", "IMU Cal"]]
    for sid, st in stations.items():
        label = STATION_COORDS.get(sid, {}).get("label", sid)
        sig   = f"{st.signal_dbm:.1f}" if st.signal_dbm > -99 else "N/A"
        sess  = optim_sessions.get(sid)
        role  = sess.sweep_role if sess else "-"
        rows.append([
            label,
            "ONLINE" if st.connection.online else "OFFLINE",
            st.mode,
            f"{st.current_angles.azimuth:.1f}",
            f"{st.current_angles.elevation:.1f}",
            f"{st.imu.imu_az:.1f}",
            f"{st.imu.imu_el:.1f}",
            sig,
            role,
            "Yes" if st.imu.calibrated else "No",
        ])
    if len(rows) == 1:
        rows.append(["No stations"] + ["-"]*9)
    t2 = Table(rows, colWidths=[3*cm, 1.7*cm, 1.5*cm, 1.5*cm, 1.5*cm,
                                 1.7*cm, 1.7*cm, 2*cm, 2*cm, 1.5*cm])
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

    # Collective lock log
    story.append(Paragraph("3. Collective Lock History", h1))
    cl_rows = db_fetch(
        "SELECT ts, step_index, s1_az, s1_el, s1_signal, s2_az, s2_el, s2_signal, combined_score "
        "FROM collective_lock_log ORDER BY id DESC LIMIT 20"
    )
    ct = [["Time", "Step", "S1 AZ", "S1 EL", "S1 dBm", "S2 AZ", "S2 EL", "S2 dBm", "Score"]]
    for row in cl_rows:
        ct.append([
            row["ts"][:16],
            str(row["step_index"]),
            f"{row['s1_az']:.1f}°",
            f"{row['s1_el']:.1f}°",
            f"{row['s1_signal']:.1f}",
            f"{row['s2_az']:.1f}°",
            f"{row['s2_el']:.1f}°",
            f"{row['s2_signal']:.1f}",
            f"{row['combined_score']:.1f}",
        ])
    if len(ct) == 1:
        ct.append(["No data"] + ["-"]*8)
    t_cl = Table(ct, colWidths=[3.5*cm, 1.2*cm, 1.8*cm, 1.8*cm, 1.8*cm,
                                  1.8*cm, 1.8*cm, 1.8*cm, 1.8*cm])
    t_cl.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1e40af")),
        ("TEXTCOLOR",  (0,0), (-1,0), colors.white),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 7),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID",       (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
        ("ALIGN",      (1,0), (-1,-1), "CENTER"),
    ]))
    story.append(t_cl)
    story.append(Spacer(1, 0.4*cm))

    story.append(Paragraph("4. Movement Verification Log", h1))
    v_rows = db_fetch(
        "SELECT ts, station_id, success, imu_az_delta, imu_el_delta, target_az, target_el "
        "FROM verification_log ORDER BY id DESC LIMIT 20"
    )
    vt = [["Time", "Station", "Result", "IMU AZ Δ", "IMU EL Δ", "Target AZ", "Target EL"]]
    for row in v_rows:
        vt.append([
            row["ts"][:16],
            STATION_COORDS.get(row["station_id"], {}).get("label", row["station_id"]),
            "OK" if row["success"] else "FAIL",
            f"{row['imu_az_delta']:.2f}°",
            f"{row['imu_el_delta']:.2f}°",
            f"{row['target_az']:.1f}°",
            f"{row['target_el']:.1f}°",
        ])
    if len(vt) == 1:
        vt.append(["No data"] + ["-"]*6)
    t3 = Table(vt, colWidths=[3.5*cm, 3.5*cm, 1.5*cm, 2.2*cm, 2.2*cm, 2*cm, 2.6*cm])
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

    story.append(Paragraph("5. Environmental Data", h1))
    env_rows_db = db_fetch(
        "SELECT station_id, ts, temperature, wind_speed, rain, humidity, pressure "
        "FROM env_log ORDER BY id DESC LIMIT 20"
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
        env_table.append(["No data"] + ["-"]*6)
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

    story.append(Paragraph("6. System Logs (Last 30)", h1))
    log_rows = db_fetch(
        "SELECT ts, station_id, level, message FROM system_log ORDER BY id DESC LIMIT 30"
    )
    log_table = [["Timestamp", "Station", "Level", "Message"]]
    for row in log_rows:
        log_table.append([row["ts"][:16], row["station_id"], row["level"], row["message"]])
    if len(log_table) == 1:
        log_table.append(["No logs"] + ["-"]*3)
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
    story.append(Paragraph("End of Report — Satellite Realignment System v4", small))
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
    Main control loop — all sweep/refine/lock logic lives here.

    Key invariants enforced in v4:
      1. No sweep starts unless both stations are online.
      2. Station_1 runs the FORWARD grid; station_2 runs the MIRRORED grid.
         Both grids share the same step_index values so every waypoint pair
         is semantically "the same pose from each end."
      3. Sweep steps are dispatched in LOCKSTEP: a new waypoint is only sent
         to a station when it has acknowledged the previous command AND its
         partner has also moved (both commands must clear before advancing).
      4. Lock position is chosen by compute_collective_best(), which picks the
         step_index with the best min(s1, s2) signal — not individual bests.
    """
    STEP_INTERVAL          = 0.4    # was 1.33 — 10× faster than original 4s
    CHECK_INTERVAL         = 0.3    # was 1.0  — 10× faster than original 3s
    LOCK_WATCH_INTERVAL    = 0.2    # was 0.67 — 10× faster than original 2s
    MIN_SAMPLES_FOR_REFINE = 6

    check_timers: Dict[str, float] = {}
    watch_timers: Dict[str, float] = {}

    await asyncio.sleep(8)

    while True:
        now = asyncio.get_event_loop().time()

        # ── GUARD: only operate when both stations are present ─────────────
        if not both_stations_online():
            # Mark any active sessions as IDLE so the dashboard shows the wait
            for sid in STATION_PAIR:
                sess = optim_sessions.get(sid)
                if sess and sess.active and not sess.converged:
                    sess.phase = OptimPhase.IDLE
            await asyncio.sleep(1)
            continue

        sid1, sid2 = STATION_PAIR
        sess1 = optim_sessions.get(sid1)
        sess2 = optim_sessions.get(sid2)

        if not sess1 or not sess2:
            await asyncio.sleep(0.05)
            continue

        st1 = stations.get(sid1)
        st2 = stations.get(sid2)
        if not st1 or not st2:
            await asyncio.sleep(0.05)
            continue

        # Ensure both are in AUTO
        if st1.mode != Mode.AUTO or st2.mode != Mode.AUTO:
            await asyncio.sleep(0.05)
            continue

        # ── LOCKED: watch for disturbances on BOTH stations ────────────────
        if (sess1.converged or sess1.phase == OptimPhase.REFINE) and \
   (sess2.converged or sess2.phase == OptimPhase.REFINE):
            for sid, sess, st in [(sid1, sess1, st1), (sid2, sess2, st2)]:
                last_watch = watch_timers.get(sid, 0)
                if now - last_watch < LOCK_WATCH_INTERVAL:
                    continue
                watch_timers[sid] = now

                if len(sess.samples) < RECAL_WINDOW:
                    continue

                recent  = sess.samples[-RECAL_WINDOW:]
                signals = [s.signal_dbm for s in recent]
                current = signals[-1]

                # ── DROP DETECTION ─────────────────────────────────────────
                # Trigger immediately if current reading has dropped more than
                # RECAL_DROP_DBM below the collective lock signal.
                # No "sustained" requirement — a single bad reading is enough
                # because we react fast and validate at the second-best position
                # before committing to a full sweep.
                lock_ref   = sess.collective_best_signal
                drop_amount = lock_ref - current   # positive = signal got worse
                near_best   = current >= (lock_ref - REDISCOVER_DROP_DBM)

                locked_at = sess.locked_at or now
                scheduled = (now - locked_at) >= RECAL_SCHEDULED_SECS

                if near_best and not scheduled:
                    # Signal still healthy — reset the scheduled recal clock
                    sess.locked_at = now
                    continue

                if not near_best:
                    reason = (
                        f"signal drop {drop_amount:.1f} dB below lock "
                        f"(current={current:.1f} lock_ref={lock_ref:.1f})"
                    )
                elif scheduled:
                    reason = f"scheduled recal after {RECAL_SCHEDULED_SECS}s"
                else:
                    continue

                log_to_db(sid, f"Recal triggered ({reason})", "WARN")

                # ── 3-STEP RECAL STRATEGY ──────────────────────────────────
                #
                # Step 1: Move BOTH stations to their second-best position
                #         (the best position that isn't the lock position).
                # Step 2: Read signal at second-best.
                #         • If signal ≥ (lock_ref − RECAL_DROP_DBM) → lock there.
                #         • Otherwise → run a fast 3×3 full sweep and relock.
                #
                # The second-best probe is handled by the recal_probe state
                # machine below.  We set recal_phase="probe" on both sessions
                # and the probe logic runs on the next loop ticks.

                for i, (rsid, rsess) in enumerate([(sid1, sess1), (sid2, sess2)]):
                    mirrored = (i == 1)

                    has_second_best = rsess.second_best_signal > -900.0
                    probe_az = rsess.second_best_az if has_second_best else rsess.collective_best_az
                    probe_el = rsess.second_best_el if has_second_best else rsess.collective_best_el

                    # Reset to a probe sweep: one-waypoint queue = second-best position
                    # step_index 0 marks it as the probe point
                    rsess.sweep_queue     = [[probe_az, probe_el, 0]]
                    rsess.sweeping        = True
                    rsess.converged       = False
                    rsess.waiting_to_lock = False
                    rsess.active          = True
                    rsess.phase           = OptimPhase.COARSE
                    rsess.samples         = []
                    rsess.iteration       = 0
                    rsess.locked_at       = None
                    rsess.sweep_reason    = f"recal-probe: {reason}"
                    # Store the lock reference so probe can compare after moving
                    rsess.collective_best_signal = lock_ref

                    log_to_db(rsid,
                              f"Recal probe → second-best AZ={probe_az:.1f} "
                              f"EL={probe_el:.1f} ({rsess.sweep_role}) — {reason}", "WARN")
                break   # only one recal trigger per loop iteration
            await asyncio.sleep(0.05)
            continue

        # ── RECAL PROBE RESULT CHECK ───────────────────────────────────────
        # After the probe sweep (1-waypoint queue) drains and both stations
        # have collected at least 3 samples, evaluate the signal:
        #   • Good enough → lock immediately at probe position
        #   • Not good enough → escalate to full 3×3 sweep

        def _probe_complete(sess: OptimSession) -> bool:
            """True when the probe waypoint has been dispatched and samples collected."""
            return (
                sess.active
                and not sess.sweeping          # queue drained
                and not sess.converged
                and "recal-probe" in sess.sweep_reason
                and len(sess.samples) >= 3
            )

        if _probe_complete(sess1) and _probe_complete(sess2):
            probe_sig1 = max((s.signal_dbm for s in sess1.samples), default=-999.0)
            probe_sig2 = max((s.signal_dbm for s in sess2.samples), default=-999.0)
            ref1 = sess1.collective_best_signal
            ref2 = sess2.collective_best_signal

            good1 = probe_sig1 >= (ref1 - REDISCOVER_DROP_DBM)
            good2 = probe_sig2 >= (ref2 - REDISCOVER_DROP_DBM)

            if good1 and good2:
                # Signal recovered at second-best — lock both stations here
                log_to_db("system",
                          f"Recal probe successful — locking at second-best positions "
                          f"S1={probe_sig1:.1f} S2={probe_sig2:.1f}", "INFO")
                _apply_lock(sid1, sess1, st1, sess1.best_az, sess1.best_el, probe_sig1, now)
                _apply_lock(sid2, sess2, st2, sess2.best_az, sess2.best_el, probe_sig2, now)
                sess1.collective_best_signal = min(probe_sig1, probe_sig2)
                sess2.collective_best_signal = min(probe_sig1, probe_sig2)
            else:
                # Probe not good enough — escalate to fast 3×3 sweep
                log_to_db("system",
                          f"Recal probe insufficient (S1={probe_sig1:.1f} S2={probe_sig2:.1f}) "
                          f"— starting 3×3 sweep", "WARN")
                for i, (rsid, rsess) in enumerate([(sid1, sess1), (sid2, sess2)]):
                    mirrored = (i == 1)
                    rsess.sweep_queue  = build_sweep_grid(
                        az_step  = RECAL_AZ_STEP,
                        el_step  = RECAL_EL_STEP,
                        mirrored = mirrored,
                    )
                    rsess.sweeping        = True
                    rsess.converged       = False
                    rsess.waiting_to_lock = False
                    rsess.active          = True
                    rsess.phase           = OptimPhase.COARSE
                    rsess.samples         = []
                    rsess.iteration       = 0
                    rsess.locked_at       = None
                    rsess.sweep_reason    = "recal-3x3 sweep"
                    log_to_db(rsid, f"3×3 recal sweep started ({rsess.sweep_role})", "WARN")
            await asyncio.sleep(0.05)
            continue

        # ── WAITING TO LOCK: both must be ready before we commit ───────────
        # We wait indefinitely — no timeout.  Locking before both stations
        # have finished refining is what caused the bad lock in v4.1 where
        # station 2 timed out and locked individually at a poor position,
        # then the collective lock ran anyway and picked a coarse-only result.
        both_waiting  = sess1.waiting_to_lock and sess2.waiting_to_lock
        either_waiting = sess1.waiting_to_lock or sess2.waiting_to_lock
        if either_waiting and not both_waiting:
            # One station has converged, the other is still refining — just wait.
            await asyncio.sleep(0.17)
            continue

        if both_waiting:
            # ── COLLECTIVE LOCK DECISION ───────────────────────────────────
            result = compute_collective_best(sess1, sess2)
            if result is None:
                # Rare: no matching steps — fall back to individual bests
                log_to_db("system",
                          "No matching step indices for collective lock — using individual bests", "WARN")
                for sid, sess, st in [(sid1, sess1, st1), (sid2, sess2, st2)]:
                    _apply_lock(sid, sess, st,
                                sess.best_az, sess.best_el, sess.best_signal, now)
            else:
                step_idx, s1_az, s1_el, s2_az, s2_el, score = result

                # Record the decision
                ts = datetime.now(timezone.utc).isoformat()
                s1_sig = next((s.signal_dbm for s in sess1.samples if s.step_index == step_idx), -99.0)
                s2_sig = next((s.signal_dbm for s in sess2.samples if s.step_index == step_idx), -99.0)
                db_exec(
                    "INSERT INTO collective_lock_log "
                    "(ts, step_index, s1_az, s1_el, s1_signal, s2_az, s2_el, s2_signal, combined_score) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (ts, step_idx, s1_az, s1_el, s1_sig, s2_az, s2_el, s2_sig, score)
                )
                log_to_db("system",
                          f"Collective lock — step={step_idx} "
                          f"S1=[AZ={s1_az:.1f} EL={s1_el:.1f} {s1_sig:.1f}dBm] "
                          f"S2=[AZ={s2_az:.1f} EL={s2_el:.1f} {s2_sig:.1f}dBm] "
                          f"score(min)={score:.1f}", "INFO")

                _apply_lock(sid1, sess1, st1, s1_az, s1_el, s1_sig, now)
                _apply_lock(sid2, sess2, st2, s2_az, s2_el, s2_sig, now)

                # Store collective_best on each session for disturbance detection
                for sess, az, el, sig in [
                    (sess1, s1_az, s1_el, s1_sig),
                    (sess2, s2_az, s2_el, s2_sig),
                ]:
                    sess.collective_best_az     = az
                    sess.collective_best_el     = el
                    sess.collective_best_signal = score   # use the pair score as the health threshold
            await asyncio.sleep(0.05)
            continue

        # ── COARSE: lockstep sweep ─────────────────────────────────────────
        #
        # Both stations must be clear of pending commands before either one
        # advances. We check readiness for BOTH first, then dispatch to BOTH
        # in the same loop iteration. This prevents the previous bug where
        # station_1 was dispatched first (setting its command.pending=True),
        # which then caused station_2 to see its partner as busy and skip,
        # leaving station_2 permanently idle.

        s1_sweep_ready = (
            sess1.active and not sess1.converged and not sess1.waiting_to_lock
            and sess1.sweeping and bool(sess1.sweep_queue)
            and not st1.command.pending
        )
        s2_sweep_ready = (
            sess2.active and not sess2.converged and not sess2.waiting_to_lock
            and sess2.sweeping and bool(sess2.sweep_queue)
            and not st2.command.pending
        )

        # Only advance when BOTH are ready — true lockstep
        if s1_sweep_ready and s2_sweep_ready:
            for sid, sess, st in [(sid1, sess1, st1), (sid2, sess2, st2)]:
                waypoint = sess.sweep_queue.pop(0)
                target_az, target_el, step_idx = waypoint[0], waypoint[1], int(waypoint[2])

                st.target_angles = Angles(azimuth=target_az, elevation=target_el)
                st.command = CommandState(
                    pending=True,
                    issued_at=datetime.now(timezone.utc),
                    acknowledged=False,
                )
                sess.last_commanded = Angles(azimuth=target_az, elevation=target_el)
                sess.iteration      = step_idx   # keep iteration == step_index

                log_to_db(sid,
                          f"[SWEEP/{sess.sweep_role}] step={step_idx} → "
                          f"AZ={target_az} EL={target_el} "
                          f"remaining={len(sess.sweep_queue)} "
                          f"reason='{sess.sweep_reason}'")

                # ── Log every coarse waypoint dispatch ──────────────────────
                station_now = stations.get(sid)
                persist_optimizer_reading(
                    station_id   = sid,
                    phase        = "COARSE",
                    step_index   = step_idx,
                    commanded_az = target_az,
                    commanded_el = target_el,
                    signal_dbm   = station_now.signal_dbm if station_now else -99.0,
                    sweep_role   = sess.sweep_role,
                    reason       = sess.sweep_reason,
                    reported_az  = station_now.current_angles.azimuth if station_now else 0.0,
                    reported_el  = station_now.current_angles.elevation if station_now else 0.0,
                )

                if not sess.sweep_queue:
                    sess.sweeping = False
                    sess.phase    = OptimPhase.REFINE
                    log_to_db(sid, f"Sweep complete — {len(sess.samples)} samples, entering REFINE")

        # ── REFINE: quadratic regression toward peak (per-station) ─────────
        #
        # Both stations refine independently once their sweeps finish.
        # We still gate each REFINE step on both commands being clear so
        # step_index increments stay approximately in sync.

        both_sweep_done = not sess1.sweeping and not sess2.sweeping
        if both_sweep_done:
            for sid, sess, st in [(sid1, sess1, st1), (sid2, sess2, st2)]:
                if not sess.active or sess.converged or sess.waiting_to_lock or sess.sweeping:
                    continue

                last_step_time = getattr(sess, '_last_refine_t', 0)
                if now - last_step_time < STEP_INTERVAL:
                    continue
                if st.command.pending:
                    continue
                if len(sess.samples) < MIN_SAMPLES_FOR_REFINE:
                    continue

                sess._last_refine_t = now   # type: ignore[attr-defined]

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
                    angle     = sess.iteration * 1.2
                    target_az = float(np.clip(sess.best_az + NUDGE * np.cos(angle), MIN_AZ, MAX_AZ))
                    target_el = float(np.clip(sess.best_el + NUDGE * np.sin(angle), MIN_EL, MAX_EL))
                    reason    = "spiral nudge"
                else:
                    target_az = float(np.clip(peak[0], MIN_AZ, MAX_AZ))
                    target_el = float(np.clip(peak[1], MIN_EL, MAX_EL))
                    sess.phase = OptimPhase.REFINE
                    sess.iteration += 1
                    reason = "quadratic peak"

                st.target_angles = Angles(azimuth=target_az, elevation=target_el)
                st.command = CommandState(
                    pending=True,
                    issued_at=datetime.now(timezone.utc),
                    acknowledged=False,
                )
                sess.last_commanded = Angles(azimuth=target_az, elevation=target_el)
                log_to_db(sid,
                          f"[REFINE] step={sess.iteration} → AZ={target_az:.1f} EL={target_el:.1f} "
                          f"[{reason}] samples={len(sess.samples)}")

                # ── Log every refine waypoint dispatch ───────────────────────
                persist_optimizer_reading(
                    station_id   = sid,
                    phase        = "REFINE",
                    step_index   = sess.iteration,
                    commanded_az = target_az,
                    commanded_el = target_el,
                    signal_dbm   = st.signal_dbm if hasattr(st, 'signal_dbm') else -99.0,
                    sweep_role   = sess.sweep_role,
                    reason       = reason,
                    reported_az  = st.current_angles.azimuth,
                    reported_el  = st.current_angles.elevation,
                )

            # ── CONVERGENCE CHECK ──────────────────────────────────────────
            for sid, sess in [(sid1, sess1), (sid2, sess2)]:
                last_check = check_timers.get(sid, 0)
                if now - last_check < CHECK_INTERVAL:
                    continue
                if len(sess.samples) < 10:
                    continue
                check_timers[sid] = now

                signals  = [s.signal_dbm for s in sess.samples[-10:]]
                variance = float(np.var(signals))
                if variance <= 1.5:
                    sess.waiting_to_lock = True
                    sess.active          = False
                    log_to_db(sid,
                              f"Convergence reached — entering lock wait "
                              f"(AZ={sess.best_az:.1f} EL={sess.best_el:.1f} "
                              f"signal={sess.best_signal:.1f} dBm var={variance:.2f})", "INFO")

        await asyncio.sleep(0.05)   # 10× faster loop tick (was 0.5 original)


def _apply_lock(sid: str, sess: OptimSession, st: StationState,
                az: float, el: float, signal: float, loop_now: float):
    """Move the servo to the collective lock position and mark session as LOCKED."""
    st.target_angles = Angles(azimuth=az, elevation=el)
    st.command = CommandState(
        pending=True,
        issued_at=datetime.now(timezone.utc),
        acknowledged=False,
    )
    sess.best_az         = az
    sess.best_el         = el
    sess.best_signal     = signal
    sess.waiting_to_lock = False
    sess.active          = False
    sess.converged       = True
    sess.phase           = OptimPhase.LOCK
    sess.locked_at       = loop_now
    log_to_db(sid,
              f"LOCKED at collective best — AZ={az:.1f} EL={el:.1f} signal={signal:.1f} dBm", "INFO")


async def heartbeat_monitor():
    while True:
        now = datetime.now(timezone.utc)
        for st in stations.values():
            if st.connection.last_heartbeat:
                if now - st.connection.last_heartbeat > HEARTBEAT_TIMEOUT:
                    if st.connection.online:
                        st.connection.online = False
                        log_to_db(st.station_id, "Station went OFFLINE (heartbeat timeout)", "WARN")
                        # If a station drops offline mid-sweep, pause the sessions
                        sess = optim_sessions.get(st.station_id)
                        if sess and sess.active and not sess.converged:
                            sess.phase = OptimPhase.IDLE
                            log_to_db(st.station_id,
                                      "Sweep paused — station offline", "WARN")
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
        # Sessions created on first heartbeat once BOTH stations are online
    asyncio.create_task(heartbeat_monitor())
    asyncio.create_task(auto_weather_refresh())
    asyncio.create_task(optimizer_loop())
    log_to_db("system", "Backend v4 started — coordinated sweep / collective lock active")