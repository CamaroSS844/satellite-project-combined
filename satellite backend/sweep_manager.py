"""
sweep_manager.py — Cold-start sweep sequencer

WHAT THIS FILE DOES
───────────────────
On first boot (empty position_signal_log) the station has no data to train
the GPR on.  This module handles that by:

  1. Deciding whether a sweep is needed (cold start check)
  2. Generating a coarse grid of (az, el) positions to visit
  3. Issuing those positions one-by-one as manual commands to the ESP32
     via the existing backend command mechanism
  4. Monitoring progress and marking the sweep complete

DESIGN DECISIONS
────────────────
The sweep uses the EXISTING manual command pipeline — the ESP32 does not
know a sweep is happening.  It just receives a sequence of target angles
the same way a human operator would send them from the dashboard.  This
means no ESP32 firmware changes are needed.

The sweep is coarse on purpose.  A 5×5 grid (25 positions) covers the
full az/el range with 35° spacing.  This takes roughly 2–3 minutes
physically (servo movement + settling + signal reading) and gives the
GPR enough shape to work with.  The model refines itself passively
after that during normal operation.

SWEEP STATES
────────────
  IDLE          — no sweep running, station operating normally
  NEEDED        — cold start detected, sweep not yet started
  IN_PROGRESS   — sweep commands being issued
  COMPLETE      — sweep done, GPR trained, station handed off

HOW IT PLUGS INTO backend.py
──────────────────────────────
  1. Import SweepManager at the top of backend.py
  2. Create one instance per station in the `stations` dict
  3. Call sweep_manager.check_and_start(station_id) on each heartbeat
     (it's idempotent — safe to call every 500 ms, only acts when needed)
  4. The /esp32/heartbeat endpoint calls advance() to step the sweep forward

DEPENDENCIES
────────────
  No extra packages — uses only stdlib + what backend.py already has.
"""

import asyncio
import numpy as np
from datetime import datetime, timezone
from typing  import Dict, List, Optional, Tuple
from enum    import Enum


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

# How many rows in position_signal_log before we consider a station
# "already seeded" and skip the sweep.
COLD_START_THRESHOLD = 8

# Coarse grid dimensions — 5×5 = 25 positions.
# Increase for denser initial coverage at the cost of longer sweep time.
SWEEP_ROWS = 5
SWEEP_COLS = 5

# Angle ranges for the sweep — match your ESP32 MIN_ANGLE / MAX_ANGLE.
AZ_MIN, AZ_MAX = 10.0, 150.0
EL_MIN, EL_MAX = 10.0, 150.0

# How long (seconds) to wait at each sweep position before considering the
# signal reading settled and moving on.  The heartbeat arrives every 0.5 s
# so DWELL=3 means ~6 heartbeats per position.
DWELL_SECONDS = 3.0

# After the sweep finishes, how many new data points trigger a GPR retrain.
# e.g. RETRAIN_EVERY=10 means retrain after every 10 new position_signal_log
# rows added during normal operation.
RETRAIN_EVERY = 10


# ─────────────────────────────────────────────────────────────────────────────
# STATE ENUM
# ─────────────────────────────────────────────────────────────────────────────

class SweepState(str, Enum):
    IDLE        = "IDLE"
    NEEDED      = "NEEDED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETE    = "COMPLETE"


# ─────────────────────────────────────────────────────────────────────────────
# SWEEP MANAGER
# ─────────────────────────────────────────────────────────────────────────────

class SweepManager:
    """
    One instance per station.  Tracks sweep state and issues commands.

    The manager does NOT directly write to the station state — it returns
    the next (az, el) command and the caller (backend.py heartbeat handler)
    applies it.  This keeps the manager stateless with respect to the
    FastAPI station objects and easy to test in isolation.

    Attributes (all readable for dashboard display)
    ──────────────────────────────────────────────
    state           — current SweepState
    total_positions — total grid positions in this sweep
    completed       — how many positions have been visited
    current_target  — (az, el) the station is currently moving toward
    started_at      — datetime the sweep began
    finished_at     — datetime the sweep completed
    points_since_retrain — counter for triggering GPR retrains
    """

    def __init__(self, station_id: str):
        self.station_id            = station_id
        self.state                 = SweepState.IDLE
        self._grid: List[Tuple[float, float]] = []
        self._grid_index           = 0
        self._dwell_start: Optional[datetime] = None
        self.current_target: Optional[Tuple[float, float]] = None
        self.total_positions       = 0
        self.completed             = 0
        self.started_at: Optional[datetime]  = None
        self.finished_at: Optional[datetime] = None
        self.points_since_retrain  = 0

    # ── grid generation ─────────────────────────────────────────────────────

    def _build_grid(self) -> List[Tuple[float, float]]:
        """
        Build a coarse grid of (az, el) positions.

        Uses linspace so positions are evenly spaced across the full range.
        The grid is flattened in a snake pattern (row 0 left→right,
        row 1 right→left, etc.) to minimise total servo travel distance.

        Example output for 5×5:
          (10, 10), (47.5, 10), (85, 10), (122.5, 10), (160, 10),
          (160, 47.5), (122.5, 47.5), ...
        """
        az_vals = np.linspace(AZ_MIN, AZ_MAX, SWEEP_COLS)
        el_vals = np.linspace(EL_MIN, EL_MAX, SWEEP_ROWS)
        grid = []
        for row_idx, el in enumerate(el_vals):
            row_az = az_vals if row_idx % 2 == 0 else reversed(az_vals)
            for az in row_az:
                grid.append((round(float(az), 1), round(float(el), 1)))
        return grid

    # ── public interface ─────────────────────────────────────────────────────

    def check_and_start(self, existing_row_count: int) -> bool:
        """
        Call this on every heartbeat with the current row count from
        position_signal_log for this station.

        Returns True if a sweep was just initiated (caller should log this).
        Does nothing and returns False if a sweep is already running or
        not needed.
        """
        if self.state in (SweepState.IN_PROGRESS, SweepState.COMPLETE):
            return False

        if existing_row_count >= COLD_START_THRESHOLD:
            # Enough data already — skip sweep, go straight to GPR
            self.state = SweepState.COMPLETE
            return False

        # Cold start — initiate sweep
        self.state          = SweepState.IN_PROGRESS
        self._grid          = self._build_grid()
        self._grid_index    = 0
        self.total_positions = len(self._grid)
        self.completed      = 0
        self.started_at     = datetime.now(timezone.utc)
        self._dwell_start   = None
        self.current_target = self._grid[0]
        return True

    def advance(self, current_az: float, current_el: float) -> Optional[Tuple[float, float]]:
        """
        Call this on every heartbeat while state == IN_PROGRESS.

        Checks whether the station has reached the current target and
        dwelled long enough, then returns the next (az, el) target or
        None if the sweep is complete.

        Parameters
        ──────────
        current_az, current_el — the station's reported current angles
                                  (from the heartbeat payload)

        Returns
        ───────
        (az, el)  — next target to command (may be the same target if still
                    moving or dwelling)
        None      — sweep is finished
        """
        if self.state != SweepState.IN_PROGRESS:
            return None

        target_az, target_el = self._grid[self._grid_index]

        # Check if station has reached the current target (within 2°)
        az_ok = abs(current_az - target_az) <= 2.0
        el_ok = abs(current_el - target_el) <= 2.0
        at_target = az_ok and el_ok

        if at_target:
            if self._dwell_start is None:
                # Just arrived — start the dwell timer
                self._dwell_start = datetime.now(timezone.utc)

            elapsed = (datetime.now(timezone.utc) - self._dwell_start).total_seconds()

            if elapsed >= DWELL_SECONDS:
                # Dwell complete — move to next position
                self.completed    += 1
                self._grid_index  += 1
                self._dwell_start  = None

                if self._grid_index >= len(self._grid):
                    # Sweep finished
                    self.state        = SweepState.COMPLETE
                    self.finished_at  = datetime.now(timezone.utc)
                    self.current_target = None
                    return None

                self.current_target = self._grid[self._grid_index]

        # Return current target (either new or still moving/dwelling)
        return self.current_target

    def notify_new_point(self) -> bool:
        """
        Call this whenever a new row is added to position_signal_log
        during normal operation (i.e. after sweep is complete).

        Returns True when RETRAIN_EVERY new points have accumulated,
        signalling the caller to retrain the GPR.
        """
        self.points_since_retrain += 1
        if self.points_since_retrain >= RETRAIN_EVERY:
            self.points_since_retrain = 0
            return True
        return False

    def reset(self):
        """
        Force a fresh sweep on next heartbeat.
        Called when the operator clicks 'Reset model' on the dashboard.
        """
        self.state               = SweepState.IDLE
        self._grid               = []
        self._grid_index         = 0
        self.completed           = 0
        self.current_target      = None
        self.started_at          = None
        self.finished_at         = None
        self.points_since_retrain = 0

    def status(self) -> Dict:
        """Summary dict for the dashboard /dashboard/sweep_status endpoint."""
        return {
            "station_id":      self.station_id,
            "state":           self.state,
            "total_positions": self.total_positions,
            "completed":       self.completed,
            "progress_pct":    round(100 * self.completed / self.total_positions, 1)
                               if self.total_positions else 0,
            "current_target":  {"az": self.current_target[0], "el": self.current_target[1]}
                               if self.current_target else None,
            "started_at":      self.started_at.isoformat()  if self.started_at  else None,
            "finished_at":     self.finished_at.isoformat() if self.finished_at else None,
        }
