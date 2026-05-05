"""
gpr_model.py — Gaussian Process Regression for antenna pointing optimisation

WHAT THIS FILE DOES
───────────────────
Trains a GPR on (azimuth, elevation) → signal_dbm data collected by the
station during sweeps and normal operation.  After training it can:
  - Predict signal strength at any (az, el) position
  - Return the predicted best (az, el) to point the antenna
  - Report confidence (uncertainty) at any position
  - Save / load itself to disk so the model survives reboots

WHY GPR AND NOT A NEURAL NET
─────────────────────────────
GPR is designed for small, sparse datasets.  Your station will have tens to
low hundreds of rows for a long time.  GPR:
  - Works well with as few as 10–20 samples
  - Returns uncertainty alongside predictions (crucial for deciding where to
    explore next)
  - Assumes nearby angles have similar signal — which is physically true for
    antennas (smooth radiation pattern)
  - Trains in milliseconds on this data size

DEPENDENCIES
────────────
  pip install scikit-learn numpy joblib

CLASSES
───────
  AntennaGPR
    .train(records)            — fit on list of dicts with azimuth/elevation/signal_dbm
    .predict(az, el)           — returns (mean_dbm, std_dbm)
    .best_angle(az_range, el_range, resolution) — grid search for predicted best angle
    .save(path)                — persist to disk with joblib
    .load(path)  [classmethod] — restore from disk
    .is_trained                — bool property

INTERNAL DESIGN NOTES
──────────────────────
Input features are normalised to [0, 1] before fitting.  This matters because
GPR kernels are sensitive to scale — without normalisation a 0–180° azimuth
range would dominate a 0–90° elevation range in the distance calculations.

The kernel is:
  ConstantKernel * RBF + WhiteKernel

  ConstantKernel  — learns the overall signal amplitude (vertical scale)
  RBF (radial basis function) — the smoothness assumption; length_scale is
                                 how quickly signal changes with angle
  WhiteKernel     — models measurement noise (ESP32 RSSI readings have ~2–3 dBm
                     jitter inherently)

n_restarts_optimizer=5 means sklearn tries 5 random starting points when
fitting the kernel hyperparameters, reducing the chance of landing in a
local optimum.  On your data size this adds ~50 ms to training — acceptable.
"""

import os
import numpy as np
import joblib
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import RBF, ConstantKernel, WhiteKernel
from sklearn.preprocessing import MinMaxScaler
from typing import List, Dict, Tuple, Optional


# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

# Minimum rows before we trust the model enough to make recommendations.
# Below this threshold best_angle() raises NotEnoughDataError.
MIN_SAMPLES = 8

# Grid resolution used by best_angle() when no override is given.
# 3° steps → 60×30 = 1800 candidate points — fast enough (<10 ms).
DEFAULT_RESOLUTION = 3.0


# ─────────────────────────────────────────────────────────────────────────────
# EXCEPTIONS
# ─────────────────────────────────────────────────────────────────────────────

class NotEnoughDataError(Exception):
    """Raised when there are too few samples to train a reliable model."""
    pass


class ModelNotTrainedError(Exception):
    """Raised when predict() or best_angle() is called before train()."""
    pass


# ─────────────────────────────────────────────────────────────────────────────
# MAIN CLASS
# ─────────────────────────────────────────────────────────────────────────────

class AntennaGPR:
    """
    Gaussian Process Regressor wrapped for antenna pointing optimisation.

    Typical usage
    ─────────────
        gpr = AntennaGPR(station_id="station_1")

        # Train
        records = db_fetch("SELECT azimuth, elevation, signal_dbm
                            FROM position_signal_log WHERE station_id=?",
                           ("station_1",))
        gpr.train(records)

        # Get best angle
        az, el, predicted_dbm, confidence = gpr.best_angle()
        print(f"Point to AZ={az}° EL={el}° → predicted {predicted_dbm:.1f} dBm")

        # Persist
        gpr.save("model_store/station_1.pkl")

        # Restore later
        gpr = AntennaGPR.load("model_store/station_1.pkl")
    """

    def __init__(self, station_id: str = "unknown"):
        self.station_id   = station_id
        self._gpr         = None     # sklearn GaussianProcessRegressor
        self._scaler      = None     # MinMaxScaler fitted on training inputs
        self._n_samples   = 0        # how many rows were used in last train()
        self._trained_at  = None     # datetime of last train()

    # ── properties ──────────────────────────────────────────────────────────

    @property
    def is_trained(self) -> bool:
        return self._gpr is not None

    @property
    def n_samples(self) -> int:
        return self._n_samples

    # ── training ────────────────────────────────────────────────────────────

    def train(self, records: List[Dict]) -> None:
        """
        Fit the GPR on a list of records.

        Each record must have keys: azimuth, elevation, signal_dbm
        (exactly what position_signal_log returns from db_fetch).

        Steps
        ─────
        1. Extract numpy arrays from records
        2. Filter out sentinel signal values (-99 means "no reading")
        3. Normalise inputs to [0, 1] — important for RBF kernel
        4. Build kernel with sensible starting hyperparameters
        5. Fit GPR
        6. Store scaler so predict() can normalise new inputs the same way
        """
        if len(records) < MIN_SAMPLES:
            raise NotEnoughDataError(
                f"Need at least {MIN_SAMPLES} samples to train. "
                f"Have {len(records)}. Run a sweep first."
            )

        # Step 1 — extract arrays
        X_raw = np.array([[r["azimuth"], r["elevation"]] for r in records],
                         dtype=float)
        y     = np.array([r["signal_dbm"] for r in records], dtype=float)

        # Step 2 — filter sentinel values
        valid = y > -98
        X_raw, y = X_raw[valid], y[valid]

        if len(X_raw) < MIN_SAMPLES:
            raise NotEnoughDataError(
                f"After filtering invalid readings, only {len(X_raw)} valid "
                f"samples remain. Need {MIN_SAMPLES}."
            )

        # Step 3 — normalise inputs
        # We fit the scaler here and store it — predict() will use the same
        # scaler so new (az, el) inputs are normalised identically.
        self._scaler = MinMaxScaler()
        X = self._scaler.fit_transform(X_raw)

        # Step 4 — kernel definition
        # Starting length_scale=0.3 means the model initially assumes signal
        # changes noticeably over ~30% of the angle range.  sklearn will
        # optimise this during fitting.
        # Bounds prevent the optimiser from collapsing to degenerate solutions.
        kernel = (
            ConstantKernel(1.0, constant_value_bounds=(0.1, 10.0))
            * RBF(length_scale=0.3, length_scale_bounds=(0.05, 2.0))
            + WhiteKernel(noise_level=0.1, noise_level_bounds=(0.01, 2.0))
        )

        # Step 5 — fit
        self._gpr = GaussianProcessRegressor(
            kernel=kernel,
            n_restarts_optimizer=5,   # try 5 random starts, keep best
            normalize_y=True,         # centres y around its mean internally
            alpha=1e-6,               # numerical stability
        )
        self._gpr.fit(X, y)

        self._n_samples = len(X)

        from datetime import datetime, timezone
        self._trained_at = datetime.now(timezone.utc)

    # ── prediction ──────────────────────────────────────────────────────────

    def predict(self, az: float, el: float) -> Tuple[float, float]:
        """
        Predict signal strength at a single (az, el) position.

        Returns
        ───────
        (mean_dbm, std_dbm)
            mean_dbm  — predicted signal strength in dBm
            std_dbm   — 1-sigma uncertainty in dBm
                        e.g. std=3 means model is confident to ±3 dBm
                        e.g. std=15 means the model is very unsure here
        """
        if not self.is_trained:
            raise ModelNotTrainedError("Call train() before predict().")

        X = self._scaler.transform([[az, el]])
        mean, std = self._gpr.predict(X, return_std=True)
        return float(mean[0]), float(std[0])

    # ── best angle search ───────────────────────────────────────────────────

    def best_angle(
        self,
        az_range:   Tuple[float, float] = (10.0, 150.0),
        el_range:   Tuple[float, float] = (10.0, 150.0),
        resolution: float               = DEFAULT_RESOLUTION,
    ) -> Tuple[float, float, float, float]:
        """
        Grid-search the az/el space for the angle with the highest predicted
        signal strength.

        Parameters
        ──────────
        az_range    — (min_az, max_az) in degrees.  Defaults match your
                      MIN_ANGLE / MAX_ANGLE constants in the ESP32 code.
        el_range    — (min_el, max_el) in degrees
        resolution  — step size in degrees.  3° gives 1800 candidates and
                      runs in <10 ms.  Use 1° for a finer search (~16 000
                      candidates, still <100 ms).

        Returns
        ───────
        (best_az, best_el, predicted_dbm, confidence_pct)
            best_az        — recommended azimuth
            best_el        — recommended elevation
            predicted_dbm  — predicted signal at that angle
            confidence_pct — 0–100.  100 = very certain, 0 = pure guess.
                             Derived from the std: confidence = 100 * exp(-std/10)
                             This is a heuristic — not a formal probability.
        """
        if not self.is_trained:
            raise ModelNotTrainedError("Call train() before best_angle().")

        # Build candidate grid
        az_vals = np.arange(az_range[0], az_range[1] + resolution, resolution)
        el_vals = np.arange(el_range[0], el_range[1] + resolution, resolution)
        az_grid, el_grid = np.meshgrid(az_vals, el_vals)
        candidates = np.column_stack([az_grid.ravel(), el_grid.ravel()])

        # Normalise the entire grid at once — much faster than looping
        candidates_norm = self._scaler.transform(candidates)
        means, stds = self._gpr.predict(candidates_norm, return_std=True)

        # Find the index with the highest predicted mean signal
        best_idx       = int(np.argmax(means))
        best_az        = float(candidates[best_idx, 0])
        best_el        = float(candidates[best_idx, 1])
        predicted_dbm  = float(means[best_idx])
        best_std       = float(stds[best_idx])

        # Convert std to a 0–100 confidence score
        # std=0  → confidence=100
        # std=5  → confidence≈60
        # std=10 → confidence≈37
        # std=20 → confidence≈14
        confidence_pct = float(100.0 * np.exp(-best_std / 10.0))

        return best_az, best_el, predicted_dbm, confidence_pct

    def uncertainty_map(
        self,
        az_range:   Tuple[float, float] = (10.0, 150.0),
        el_range:   Tuple[float, float] = (10.0, 150.0),
        resolution: float               = 5.0,
    ) -> List[Dict]:
        """
        Return the full predicted signal surface as a list of dicts.
        Used by the dashboard endpoint to render a heatmap.

        Each dict: { az, el, mean_dbm, std_dbm }
        """
        if not self.is_trained:
            raise ModelNotTrainedError("Call train() before uncertainty_map().")

        az_vals    = np.arange(az_range[0], az_range[1] + resolution, resolution)
        el_vals    = np.arange(el_range[0], el_range[1] + resolution, resolution)
        az_g, el_g = np.meshgrid(az_vals, el_vals)
        candidates = np.column_stack([az_g.ravel(), el_g.ravel()])
        cands_norm = self._scaler.transform(candidates)
        means, stds = self._gpr.predict(cands_norm, return_std=True)

        return [
            {
                "az":       round(float(candidates[i, 0]), 1),
                "el":       round(float(candidates[i, 1]), 1),
                "mean_dbm": round(float(means[i]), 2),
                "std_dbm":  round(float(stds[i]),  2),
            }
            for i in range(len(candidates))
        ]

    # ── persistence ─────────────────────────────────────────────────────────

    def save(self, path: str) -> None:
        """
        Persist the trained model to disk using joblib.

        joblib is better than pickle for numpy arrays — faster and more
        memory efficient.  The saved file contains the GPR, the scaler,
        the station_id, the sample count, and the training timestamp.
        """
        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
        payload = {
            "station_id":  self.station_id,
            "gpr":         self._gpr,
            "scaler":      self._scaler,
            "n_samples":   self._n_samples,
            "trained_at":  self._trained_at,
        }
        joblib.dump(payload, path)

    @classmethod
    def load(cls, path: str) -> "AntennaGPR":
        """
        Restore a previously saved model from disk.

        Returns a fully trained AntennaGPR instance ready to call
        predict() and best_angle() on immediately.

        Raises FileNotFoundError if the path does not exist — caller
        should catch this and treat it as a cold-start situation.
        """
        if not os.path.exists(path):
            raise FileNotFoundError(f"No saved model at {path}")

        payload       = joblib.load(path)
        instance      = cls(station_id=payload["station_id"])
        instance._gpr        = payload["gpr"]
        instance._scaler     = payload["scaler"]
        instance._n_samples  = payload["n_samples"]
        instance._trained_at = payload["trained_at"]
        return instance

    # ── info ────────────────────────────────────────────────────────────────

    def info(self) -> Dict:
        """Summary dict for the dashboard endpoint."""
        return {
            "station_id":  self.station_id,
            "is_trained":  self.is_trained,
            "n_samples":   self._n_samples,
            "trained_at":  self._trained_at.isoformat() if self._trained_at else None,
            "kernel":      str(self._gpr.kernel_) if self.is_trained else None,
        }
