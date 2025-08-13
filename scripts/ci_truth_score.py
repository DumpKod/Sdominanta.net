#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import re

try:
    import requests  # type: ignore
except Exception as e:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"requests_missing: {e}"}, ensure_ascii=False))
    sys.exit(0)


def sha256_hex_stream(url: str, timeout: int = 15) -> Tuple[str, bytes | None]:
    h = hashlib.sha256()
    try:
        with requests.get(url, stream=True, timeout=timeout) as r:
            r.raise_for_status()
            data = b""
            for chunk in r.iter_content(chunk_size=65536):
                if chunk:
                    h.update(chunk)
                    data += chunk
            return h.hexdigest(), data
    except Exception:
        return "", None


def is_probably_json(data: bytes) -> bool:
    s = data.lstrip()[:1]
    return s in (b"{", b"[")


def load_schema_props(schema_path: Path) -> Dict[str, Any]:
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        return schema.get("properties", {}) if isinstance(schema, dict) else {}
    except Exception:
        return {}


def validate_telemetry_payload(obj: Any, schema_props: Dict[str, Any]) -> List[str]:
    errs: List[str] = []
    try:
        import validate_telemetry as vt  # type: ignore
    except Exception as e:  # pragma: no cover
        return [f"validator_import_error: {e}"]

    if not isinstance(obj, list):
        return ["telemetry must be an array of events"]
    for i, ev in enumerate(obj):
        if not isinstance(ev, dict):
            errs.append(f"[{i}] not an object")
            continue
        ev_errs = vt.validate_event(ev, schema_props)
        errs.extend([f"[{i}] {m}" for m in ev_errs])
    return errs


def main() -> int:
    p = argparse.ArgumentParser(description="Compute truth score for a note by checking evidence")
    p.add_argument("--note", required=True, help="Path to note JSON")
    p.add_argument("--schema", default="TELEMETRY_SCHEMA.json", help="Path to telemetry schema JSON")
    p.add_argument("--timeout", type=int, default=15)
    args = p.parse_args()

    note_path = Path(args.note)
    if not note_path.exists():
        print(json.dumps({"ok": False, "error": f"note_not_found: {note_path}"}, ensure_ascii=False))
        return 0

    try:
        note = json.loads(note_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"note_parse_error: {e}"}, ensure_ascii=False))
        return 0

    evidence = note.get("evidence", []) if isinstance(note, dict) else []
    if not isinstance(evidence, list) or not evidence:
        print(json.dumps({"ok": True, "score": 0.5, "details": {"evidence": 0}}, ensure_ascii=False))
        return 0

    schema_props = load_schema_props(Path(args.schema))

    total = 0
    ok_hash = 0
    ok_schema = 0
    details: List[Dict[str, Any]] = []

    for ev in evidence:
        if not isinstance(ev, dict):
            continue
        total += 1
        url = str(ev.get("url", ""))
        claimed = str(ev.get("sha256", ""))
        e_type = str(ev.get("type", ""))

        rec: Dict[str, Any] = {"url": url, "type": e_type, "sha256_ok": False, "schema_ok": None}

        if not re.match(r"^https?://", url):
            details.append(rec)
            continue

        h, data = sha256_hex_stream(url, timeout=args.timeout)
        if data is not None and h == claimed:
            rec["sha256_ok"] = True
            ok_hash += 1
            # simple JSON check for telemetry
            if e_type == "telemetry" and is_probably_json(data):
                try:
                    payload = json.loads(data.decode("utf-8"))
                    errs = validate_telemetry_payload(payload, schema_props)
                    if not errs:
                        rec["schema_ok"] = True
                        ok_schema += 1
                    else:
                        rec["schema_ok"] = False
                        rec["schema_errors"] = errs[:5]
                except Exception as e:
                    rec["schema_ok"] = False
                    rec["schema_error"] = str(e)
        else:
            rec["sha256_expected"] = claimed
            rec["sha256_got"] = h
        details.append(rec)

    # score: base on hash pass ratio + bonus for schema pass on telemetry
    if total == 0:
        score = 0.5
    else:
        hash_ratio = ok_hash / total
        schema_ratio = (ok_schema / total) if total > 0 else 0.0
        score = 0.5 * hash_ratio + 0.5 * min(1.0, hash_ratio + schema_ratio)
        score = round(min(max(score, 0.0), 1.0), 4)

    out = {
        "ok": True,
        "score": score,
        "counts": {"total": total, "hash_ok": ok_hash, "schema_ok": ok_schema},
        "note": str(note_path),
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


