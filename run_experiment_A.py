import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import List, Dict, Any, Tuple

import numpy as np


# ---- Core formulas (aligned with ALEPH notation) ----
def T_of_t(
    t: np.ndarray,
    nphi: float,
    Sigma_max: float,
    Delta: float,
    epsilon_t: float,
    gamma_r: float,
    lambda_: float,
    epsilon0: float,
) -> np.ndarray:
    denom = 1.0 + Sigma_max * np.exp(-Delta + (epsilon_t / (gamma_r + epsilon0)))
    inner = 1.0 - (abs(nphi) / denom)
    return inner * np.exp(-lambda_ * t)


def T_meas_of_t(
    t: np.ndarray,
    odmr_Cmin: float,
    odmr_Cmax: float,
    T2star_us: float,
    alpha: float,
) -> np.ndarray:
    Cspan = max(1e-9, (odmr_Cmax - odmr_Cmin))
    C_t = odmr_Cmin + (odmr_Cmax - odmr_Cmin) * np.exp(-t / max(1e-9, T2star_us))
    C_tilde = (C_t - odmr_Cmin) / Cspan
    return alpha * C_tilde + (1.0 - alpha) * np.exp(-t / max(1e-9, T2star_us))


def time_to_threshold(t: np.ndarray, y: np.ndarray, thr: float) -> float:
    mask = y <= thr
    if not np.any(mask):
        return float("nan")
    idx = int(np.argmax(mask))
    if idx == 0:
        return float(t[0])
    t0, t1 = float(t[idx - 1]), float(t[idx])
    y0, y1 = float(y[idx - 1]), float(y[idx])
    if y1 == y0:
        return t1
    frac = (thr - y0) / (y1 - y0)
    return t0 + frac * (t1 - t0)


# ---- Experiment A adapter layer ----
@dataclass
class ExperimentConfig:
    n_repeats: int = 30
    seed: int = 17
    # Measurement map
    alpha: float = 0.5
    odmr_Cmin: float = 0.10
    odmr_Cmax: float = 0.40
    T2star_unprot: float = 1.40
    T2star_prot: float = 1.60
    # ALEPH params (common)
    nphi: float = 0.3
    Sigma_max: float = 0.9
    Delta: float = 0.2
    epsilon_t: float = 0.22
    lambda_: float = 0.01
    epsilon0: float = 0.1
    gamma_r_unprot: float = 1.0
    gamma_r_prot: float = 0.5


class SimAdapter:
    def __init__(self, cfg: ExperimentConfig):
        self.cfg = cfg
        self.rng = np.random.default_rng(cfg.seed)

    def measure_run(self, protected: bool) -> Dict[str, Any]:
        # расширим окно, чтобы T(t) гарантированно проходил 0.1
        t = np.linspace(0.0, 300.0, 6001)
        gamma_r = self.cfg.gamma_r_prot if protected else self.cfg.gamma_r_unprot
        T = T_of_t(
            t,
            nphi=self.cfg.nphi,
            Sigma_max=self.cfg.Sigma_max,
            Delta=self.cfg.Delta,
            epsilon_t=self.cfg.epsilon_t,
            gamma_r=gamma_r,
            lambda_=self.cfg.lambda_,
            epsilon0=self.cfg.epsilon0,
        )
        # Simple noise model for T (small measurement noise)
        T_noisy = np.clip(T + self.rng.normal(0.0, 0.002, size=T.shape), 0.0, 1.0)

        T2 = self.cfg.T2star_prot if protected else self.cfg.T2star_unprot
        Tm = T_meas_of_t(
            t,
            odmr_Cmin=self.cfg.odmr_Cmin,
            odmr_Cmax=self.cfg.odmr_Cmax,
            T2star_us=T2,
            alpha=self.cfg.alpha,
        )
        # Add light noise to T_meas too
        Tm_noisy = np.clip(Tm + self.rng.normal(0.0, 0.002, size=Tm.shape), 0.0, 1.0)

        t05_T = time_to_threshold(t, T_noisy, 0.5)
        t01_T = time_to_threshold(t, T_noisy, 0.1)
        t05_Tm = time_to_threshold(t, Tm_noisy, 0.5)
        t01_Tm = time_to_threshold(t, Tm_noisy, 0.1)

        # JSON-совместимость: NaN -> None
        def jval(x: float):
            return float(x) if np.isfinite(x) else None

        return {
            "t": t.tolist(),
            "T": T_noisy.tolist(),
            "T_meas": Tm_noisy.tolist(),
            "thresholds": {
                "T": {"t_0.5": jval(t05_T), "t_0.1": jval(t01_T)},
                "T_meas": {"t_0.5": jval(t05_Tm), "t_0.1": jval(t01_Tm)},
            },
        }


def bootstrap_ci95(values: List[float], rng: random.Random) -> Tuple[float, float]:
    clean = [v for v in values if math.isfinite(v)]
    if not clean:
        return (float("nan"), float("nan"))
    B = 5000
    samples = []
    for _ in range(B):
        resample = [rng.choice(clean) for _ in clean]
        samples.append(float(np.mean(resample)))
    samples.sort()
    lo = samples[int(0.025 * B)]
    hi = samples[int(0.975 * B)]
    return (lo, hi)


def run_experiment_A(cfg: ExperimentConfig, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    adapter = SimAdapter(cfg)
    rng = random.Random(cfg.seed)

    order = [True] * cfg.n_repeats + [False] * cfg.n_repeats
    rng.shuffle(order)

    prot_t05, unprot_t05 = [], []
    prot_t01, unprot_t01 = [], []
    events: List[Dict[str, Any]] = []

    module_cycle = ["QuantumLens", "MW-Antenna", "GraphGate.16", "GraphReadout", "PKS"]

    shot = 0
    for protected in order:
        shot += 1
        m = adapter.measure_run(protected)

        # Record thresholds for CI
        if protected:
            prot_t05.append(m["thresholds"]["T"]["t_0.5"])  # using T for acceptance
            prot_t01.append(m["thresholds"]["T"]["t_0.1"]) 
        else:
            unprot_t05.append(m["thresholds"]["T"]["t_0.5"]) 
            unprot_t01.append(m["thresholds"]["T"]["t_0.1"]) 

        # Telemetry event (schema compliant)
        module = module_cycle[(shot - 1) % len(module_cycle)]
        event = {
            "ts": "1970-01-01T00:00:00Z",
            "run_id": "exp-A",
            "shot": shot,
            "module": module,
            "odmr_contrast": float(cfg.odmr_Cmax),
            "t2_star_us": float(cfg.T2star_prot if protected else cfg.T2star_unprot),
            "t1_ms": None,
            "photon_counts": None,
            "gamma_r": float(cfg.gamma_r_prot if protected else cfg.gamma_r_unprot),
            "Sigma_max": float(cfg.Sigma_max),
            "Delta": float(cfg.Delta),
            "epsilon_t": float(cfg.epsilon_t),
            "lambda": float(cfg.lambda_),
            "T_index": None,
            "threshold_crossings": {
                "T_0_5": m["thresholds"]["T"]["t_0.5"],
                "T_0_1": m["thresholds"]["T"]["t_0.1"],
            },
            "notes": "protected" if protected else "unprotected",
        }
        events.append(event)

    # Δt distributions and CI
    # Align by counts (after randomized order we collected separately)
    n = min(len(prot_t05), len(unprot_t05))
    dt05 = [prot_t05[i] - unprot_t05[i] for i in range(n) if math.isfinite(prot_t05[i]) and math.isfinite(unprot_t05[i])]
    dt01 = [prot_t01[i] - unprot_t01[i] for i in range(n) if math.isfinite(prot_t01[i]) and math.isfinite(unprot_t01[i])]

    ci05 = bootstrap_ci95(dt05, rng)
    ci01 = bootstrap_ci95(dt01, rng)

    report = {
        "n_pairs": n,
        "t_0.5": {"mean_unprot": float(np.mean(unprot_t05)), "mean_prot": float(np.mean(prot_t05)), "delta_mean": float(np.mean(dt05)), "ci95": {"low": ci05[0], "high": ci05[1]}},
        "t_0.1": {"mean_unprot": float(np.mean(unprot_t01)), "mean_prot": float(np.mean(prot_t01)), "delta_mean": float(np.mean(dt01)), "ci95": {"low": ci01[0], "high": ci01[1]}},
        "acceptance": {"delta_t0.5_positive_95CI": (ci05[0] > 0.0)},
    }

    (out_dir / "ab_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    (out_dir / "telemetry_run_A.json").write_text(
        json.dumps(events, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )


def main() -> int:
    cfg = ExperimentConfig()
    out = Path(".")
    run_experiment_A(cfg, out)
    print("Saved ab_report.json and telemetry_run_A.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


