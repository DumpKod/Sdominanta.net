import numpy as np
import matplotlib.pyplot as plt


def simulate_T2star_anisotropy(
    t: np.ndarray,
    base_T2_us: float = 1.5,
    grad_percent: float = 0.15,
    n_trials: int = 200,
    noise_sd: float = 0.01,
):
    """Simulate anisotropy of T2* due to ∇T ≠ 0 along one axis (F4 influence).

    We model along axis-x: T2*_x = base_T2_us * (1 - grad_percent)
                          axis-y: T2*_y = base_T2_us * (1 + grad_percent)
    Generate repeated decay traces to estimate T2* via simple log-linear fit.
    """
    rng = np.random.default_rng(42)

    def gen_trace(T2_us: float) -> np.ndarray:
        y = np.exp(-t / T2_us)
        y_noisy = y + rng.normal(0.0, noise_sd, size=t.shape)
        y_noisy = np.clip(y_noisy, 1e-4, 1.0)
        return y_noisy

    def estimate_T2(trace: np.ndarray) -> float:
        # Robust windowed log-fit: use only region 0.1 <= y <= 0.8 to avoid tail clipping and near-DC zone
        y = np.clip(trace, 1e-4, 1.0).astype(np.float64)
        mask = (y >= 0.1) & (y <= 0.8)
        if np.count_nonzero(mask) < 10:
            # fallback to central 60% of points
            n = len(t)
            lo, hi = int(0.2 * n), int(0.8 * n)
            mask = np.zeros(n, dtype=bool)
            mask[lo:hi] = True
        tt = t[mask].astype(np.float64)
        yy = np.log(y[mask])
        # Centered covariance fit for numerical stability: ln y = a * t + b
        tt_c = tt - tt.mean()
        yy_c = yy - yy.mean()
        denom = float(np.dot(tt_c, tt_c))
        if denom <= 0:
            return float('nan')
        slope = float(np.dot(tt_c, yy_c) / denom)
        if slope >= -1e-12:  # avoid non-physical or near-zero slope
            return float('nan')
        T2_est = -1.0 / slope
        return float(T2_est)

    T2x = base_T2_us * (1.0 - grad_percent)
    T2y = base_T2_us * (1.0 + grad_percent)

    est_x = []
    est_y = []
    for _ in range(n_trials):
        est_x.append(estimate_T2(gen_trace(T2x)))
        est_y.append(estimate_T2(gen_trace(T2y)))

    est_x = np.array(est_x)
    est_y = np.array(est_y)

    return {
        "T2_true": {"x": T2x, "y": T2y},
        "T2_estimate_mean": {"x": float(np.mean(est_x)), "y": float(np.mean(est_y))},
        "T2_estimate_std": {"x": float(np.std(est_x, ddof=1)), "y": float(np.std(est_y, ddof=1))},
        "p_value": None,
        "rel_diff": float(abs(np.mean(est_y) - np.mean(est_x)) / np.mean(est_x)),
        "samples": {"x": est_x.tolist(), "y": est_y.tolist()},
    }


def main():
    t = np.linspace(0, 10.0, 2001)

    results = simulate_T2star_anisotropy(t, base_T2_us=1.5, grad_percent=0.25, n_trials=300, noise_sd=0.008)

    # Plot distributions
    fig, ax = plt.subplots(figsize=(7.5, 4.5), dpi=160)
    ax.hist(results["samples"]["x"], bins=30, alpha=0.6, label=r"T2* along x (∇T≠0)")
    ax.hist(results["samples"]["y"], bins=30, alpha=0.6, label=r"T2* along y (⊥)")
    ax.set_xlabel("Estimated T2* (µs)")
    ax.set_ylabel("Count")
    subtitle = f"ΔT2/T2≈{results['rel_diff']*100:.1f}%"
    ax.set_title("Anisotropy of T2* due to gradient in T\n" + subtitle)
    ax.legend()
    fig.tight_layout()
    fig.savefig("out_T2star_anisotropy.png")
    print("Saved plot to out_T2star_anisotropy.png")


if __name__ == "__main__":
    main()


