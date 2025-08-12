import json
import sys
from typing import List, Dict, Any


def validate_monotonicity(series: List[float]) -> bool:
    return all(x2 <= x1 + 1e-9 for x1, x2 in zip(series, series[1:]))


def validate_bounds(series: List[float], low: float = 0.0, high: float = 1.0) -> bool:
    return all((low - 1e-9) <= x <= (high + 1e-9) for x in series)


def main(path_metrics: str = "metrics.json") -> int:
    try:
        with open(path_metrics, "r", encoding="utf-8") as f:
            metrics: Dict[str, Any] = json.load(f)
    except FileNotFoundError:
        print(f"ERROR: file not found: {path_metrics}")
        return 2

    # Expect that T_meas thresholds exist for t_0.5 and t_0.1 in metrics
    # For a simple validator, we reconstruct a monotone series proxy from threshold times:
    # earlier crossing at stricter threshold implies faster decay.
    t05_u = metrics.get("T_meas", {}).get("t_0.5", {}).get("unprotected")
    t01_u = metrics.get("T_meas", {}).get("t_0.1", {}).get("unprotected")
    t05_p = metrics.get("T_meas", {}).get("t_0.5", {}).get("protected")
    t01_p = metrics.get("T_meas", {}).get("t_0.1", {}).get("protected")

    report_lines = []
    ok = True

    # Bound checks: times must be non-negative
    for name, val in (("t0.5_unprot", t05_u), ("t0.1_unprot", t01_u), ("t0.5_prot", t05_p), ("t0.1_prot", t01_p)):
        if val is None:
            report_lines.append(f"FAIL: {name} is None")
            ok = False
        elif not (val >= 0 or str(val) == "nan"):
            report_lines.append(f"FAIL: {name} must be >=0 or NaN, got {val}")
            ok = False

    # Monotonic proxy: for each condition, t_0.1 should be >= t_0.5 (later to reach lower threshold)
    for cond, a, b in (("unprotected", t05_u, t01_u), ("protected", t05_p, t01_p)):
        if a is not None and b is not None and not (str(a) == "nan" or str(b) == "nan"):
            if not (b >= a):
                ok = False
                report_lines.append(f"FAIL: monotonic thresholds: t_0.1 < t_0.5 for {cond} (got {b} < {a})")

    # Improvement check: protected should not be worse (Δt >= 0)
    dt05 = metrics.get("T_meas", {}).get("t_0.5", {}).get("Delta_t")
    dt01 = metrics.get("T_meas", {}).get("t_0.1", {}).get("Delta_t")
    for name, val in (("Delta_t(t=0.5)", dt05), ("Delta_t(t=0.1)", dt01)):
        if val is None:
            ok = False
            report_lines.append(f"FAIL: {name} is None")
        elif not (str(val) == "nan") and val < -1e-9:
            ok = False
            report_lines.append(f"FAIL: {name} < 0 (got {val})")

    # Bounds: not available as a series here, but document pass/fail
    if ok:
        report_lines.append("PASS: T_meas thresholds monotonic and protected >= unprotected (Δt >= 0)")

    with open("tmeas_report.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(report_lines) + "\n")

    print("\n".join(report_lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())


