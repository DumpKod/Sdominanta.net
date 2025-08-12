import json
import numpy as np
import matplotlib.pyplot as plt


def T_of_t(
    t: np.ndarray,
    nphi: float = 0.3,
    Sigma_max: float = 0.9,
    Delta: float = 0.2,
    epsilon_t: float = 0.22,
    gamma_r: float = 1.0,
    lambda_: float = 0.01,
    epsilon0: float = 0.1,
) -> np.ndarray:
    """Universal coherence KPI (F2):
    T(t) = (1 - |¬φⁿ|/(1 + Σ_max * exp(-Δ + ε(t)/(γ_r + ε0)))) * exp(-λ t)
    """
    denom = 1.0 + Sigma_max * np.exp(-Delta + (epsilon_t / (gamma_r + epsilon0)))
    inner = 1.0 - (abs(nphi) / denom)
    return inner * np.exp(-lambda_ * t)


def T_meas_of_t(
    t: np.ndarray,
    odmr_Cmin: float,
    odmr_Cmax: float,
    T2star_us: float,
    alpha: float = 0.5,
) -> np.ndarray:
    """Operational measurement map (F0.8):
    T_meas(t) = α * \tilde C(t) + (1-α) * exp(-t/T2*)

    ODMR contrast model: C_ODMR(t) = Cmin + (Cmax - Cmin) * exp(-t/T2*)
    Hence \tilde C(t) = (C_ODMR(t) - Cmin)/(Cmax - Cmin).
    """
    # Guard
    Cspan = max(1e-9, (odmr_Cmax - odmr_Cmin))
    C_t = odmr_Cmin + (odmr_Cmax - odmr_Cmin) * np.exp(-t / max(1e-9, T2star_us))
    C_tilde = (C_t - odmr_Cmin) / Cspan
    return alpha * C_tilde + (1.0 - alpha) * np.exp(-t / max(1e-9, T2star_us))


def time_to_threshold(t: np.ndarray, y: np.ndarray, thr: float) -> float:
    """Return first time where y(t) falls below thr. If never, return np.nan."""
    mask = y <= thr
    if not np.any(mask):
        return np.nan
    idx = np.argmax(mask)
    if idx == 0:
        return t[0]
    # linear interpolate between (idx-1, idx)
    t0, t1 = t[idx - 1], t[idx]
    y0, y1 = y[idx - 1], y[idx]
    if y1 == y0:
        return t1
    frac = (thr - y0) / (y1 - y0)
    return float(t0 + frac * (t1 - t0))


def main():
    # time grid (microseconds)
    t = np.linspace(0, 200, 4001)

    # Parameters (aligned with notation)
    params_common = dict(nphi=0.3, Sigma_max=0.9, Delta=0.2, epsilon_t=0.22, lambda_=0.01, epsilon0=0.1)

    # Unprotected vs Protected (γ_r)
    gamma_r_unprot = 1.0
    gamma_r_prot = 0.5

    T_unprot = T_of_t(t, gamma_r=gamma_r_unprot, **params_common)
    T_prot = T_of_t(t, gamma_r=gamma_r_prot, **params_common)

    # F0.8 measurement map parameters
    alpha = 0.5
    # Use representative T2* in microseconds for Ramsey-like envelope
    T2star_unprot = 1.4
    T2star_prot = 1.6
    # ODMR contrast bounds (typical)
    Cmin, Cmax = 0.10, 0.40

    Tm_unprot = T_meas_of_t(t, odmr_Cmin=Cmin, odmr_Cmax=Cmax, T2star_us=T2star_unprot, alpha=alpha)
    Tm_prot = T_meas_of_t(t, odmr_Cmin=Cmin, odmr_Cmax=Cmax, T2star_us=T2star_prot, alpha=alpha)

    # thresholds and metrics
    metrics = {"T": {}, "T_meas": {}, "config": {}}
    for thr in (0.5, 0.1):
        tu = time_to_threshold(t, T_unprot, thr)
        tp = time_to_threshold(t, T_prot, thr)
        tm_u = time_to_threshold(t, Tm_unprot, thr)
        tm_p = time_to_threshold(t, Tm_prot, thr)
        metrics["T"][f"t_{thr}"] = {"unprotected": tu, "protected": tp, "Delta_t": (tp - tu) if np.isfinite(tp) and np.isfinite(tu) else np.nan}
        metrics["T_meas"][f"t_{thr}"] = {"unprotected": tm_u, "protected": tm_p, "Delta_t": (tm_p - tm_u) if np.isfinite(tm_p) and np.isfinite(tm_u) else np.nan}

    metrics["config"] = {
        "gamma_r": {"unprotected": gamma_r_unprot, "protected": gamma_r_prot},
        "alpha": alpha,
        "T2star_us": {"unprotected": T2star_unprot, "protected": T2star_prot},
        "ODMR": {"Cmin": Cmin, "Cmax": Cmax},
        "nphi": params_common["nphi"],
        "Sigma_max": params_common["Sigma_max"],
        "Delta": params_common["Delta"],
        "epsilon_t": params_common["epsilon_t"],
        "epsilon0": params_common["epsilon0"],
    }

    with open("metrics.json", "w", encoding="utf-8") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=2)

    # plot
    fig, ax = plt.subplots(figsize=(9, 5), dpi=160)
    # T(t)
    ax.plot(t, T_unprot, linestyle="--", color="#007B8A", label=r"T(t), unprot (\gamma_r=1.0)")
    ax.plot(t, T_prot, linestyle="-", color="#007B8A", label=r"T(t), prot (\gamma_r=0.5)")
    # T_meas(t)
    ax.plot(t, Tm_unprot, linestyle="--", color="#A23B72", label=r"T_{meas}(t), unprot")
    ax.plot(t, Tm_prot, linestyle="-", color="#A23B72", label=r"T_{meas}(t), prot")
    # thresholds
    ax.axhline(0.5, color="#AAAAAA", ls=":", lw=1)
    ax.axhline(0.1, color="#AAAAAA", ls=":", lw=1)
    ax.set_xlabel("t (µs)")
    ax.set_ylabel(r"T,\ T_{meas}")
    ax.set_title(r"Protected vs Unprotected: T(t) and $T_{meas}(t)$")
    ax.legend(ncol=2, fontsize=8)
    fig.tight_layout()
    fig.savefig("out_Tmeas_curves.png")
    print("Saved plot to out_Tmeas_curves.png and metrics.json")


if __name__ == '__main__':
    main()


