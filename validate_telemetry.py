import json
from typing import Any, Dict, List
try:
    import jsonschema  # type: ignore
except Exception:  # pragma: no cover
    jsonschema = None


ALLOWED_MODULES = {"QuantumLens", "MW-Antenna", "GraphGate.16", "GraphReadout", "PKS"}


def is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def validate_event(ev: Dict[str, Any], schema_props: Dict[str, Any]) -> List[str]:
    errs: List[str] = []
    # required keys
    for req in ("ts", "run_id", "module"):
        if req not in ev:
            errs.append(f"missing required: {req}")

    # additionalProperties: false
    allowed_keys = set(schema_props.keys())
    extra = set(ev.keys()) - allowed_keys
    if extra:
        errs.append(f"additionalProperties not allowed: {sorted(list(extra))}")

    # types and ranges
    if "module" in ev and ev["module"] not in ALLOWED_MODULES:
        errs.append(f"module not in enum: {ev.get('module')}")

    def check_opt_num(name: str, minimum: float | None = None, maximum: float | None = None, integer: bool = False):
        if name in ev and ev[name] is not None:
            if integer:
                if not isinstance(ev[name], int):
                    errs.append(f"{name} must be integer")
            else:
                if not is_number(ev[name]):
                    errs.append(f"{name} must be number")
            if minimum is not None and is_number(ev[name]) and ev[name] < minimum:
                errs.append(f"{name} < {minimum}")
            if maximum is not None and is_number(ev[name]) and ev[name] > maximum:
                errs.append(f"{name} > {maximum}")

    check_opt_num("shot", minimum=0, integer=True)
    check_opt_num("odmr_contrast")
    check_opt_num("t2_star_us", minimum=0)
    check_opt_num("t1_ms", minimum=0)
    check_opt_num("photon_counts", minimum=0, integer=True)
    check_opt_num("gamma_r", minimum=0)
    check_opt_num("Sigma_max", minimum=0, maximum=1)
    check_opt_num("Delta", minimum=0)
    check_opt_num("epsilon_t")
    check_opt_num("lambda", minimum=0)
    check_opt_num("T_index", minimum=0, maximum=1)

    # threshold_crossings
    if "threshold_crossings" in ev and ev["threshold_crossings"] is not None:
        tc = ev["threshold_crossings"]
        if not isinstance(tc, dict):
            errs.append("threshold_crossings must be object")
        else:
            allowed_tc = {"T_0_5", "T_0_1"}
            extra_tc = set(tc.keys()) - allowed_tc
            if extra_tc:
                errs.append(f"threshold_crossings.additionalProperties not allowed: {sorted(list(extra_tc))}")
            for k in allowed_tc:
                if k in tc and tc[k] is not None and not is_number(tc[k]):
                    errs.append(f"threshold_crossings.{k} must be number or null")

    return errs


def main():
    with open("TELEMETRY_SCHEMA.json", "r", encoding="utf-8") as f:
        schema = json.load(f)
    with open("telemetry_samples.json", "r", encoding="utf-8") as f:
        events = json.load(f)

    props = schema.get("properties", {})
    all_errs: List[str] = []
    if not isinstance(events, list):
        all_errs.append("top-level must be array of events")
    else:
        for i, ev in enumerate(events):
            if not isinstance(ev, dict):
                all_errs.append(f"[{i}] not an object")
                continue
            errs = validate_event(ev, props)
            if errs:
                all_errs.append(f"Event[{i}] errors: " + "; ".join(errs))

    # If structural checks pass and jsonschema is available, perform full validation
    if not all_errs and jsonschema is not None:
        try:
            ev_schema = schema
            for i, ev in enumerate(events):
                jsonschema.validate(ev, ev_schema)
        except Exception as e:  # pragma: no cover
            all_errs.append(f"jsonschema validation failed at event[{i}]: {e}")

    if all_errs:
        print("FAIL")
        for e in all_errs:
            print(" -", e)
        return 1
    else:
        msg = "PASS: telemetry_samples.json conforms to TELEMETRY_SCHEMA.json"
        if jsonschema is None:
            msg += " (jsonschema not installed, ran structural checks)"
        print(msg)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())


