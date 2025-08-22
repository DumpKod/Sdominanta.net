#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

try:
    from jsonschema import validate as jsonschema_validate  # type: ignore
    from jsonschema import ValidationError  # type: ignore
except Exception:
    jsonschema_validate = None
    ValidationError = Exception  # type: ignore


def load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_notes(base: Path) -> tuple[int, List[str]]:
    schema_path = base / "wall" / "WALL_NOTE.schema.json"
    notes_dir = base / "wall" / "threads"
    if not schema_path.exists():
        raise SystemExit(f"schema_not_found: {schema_path}")
    if not notes_dir.exists():
        return 0, []

    schema = load_json(schema_path)
    errors: List[str] = []
    files = sorted(notes_dir.glob("**/*.json"))
    for f in files:
        try:
            note = load_json(f)
            if jsonschema_validate is None:  # pragma: no cover
                raise SystemExit("jsonschema package not available; install requirements.txt")
            jsonschema_validate(note, schema)
        except ValidationError as e:  # type: ignore
            errors.append(f"{f}: {e.message}")
        except Exception as e:  # pragma: no cover
            errors.append(f"{f}: {e}")

    return len(files), errors


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate WALL notes against schema")
    parser.add_argument("--base", type=str, default=".", help="Project root containing wall/")
    args = parser.parse_args()

    base = Path(args.base).resolve()
    count, errors = validate_notes(base)
    if errors:
        print("FAIL", len(errors), "errors of", count, "files")
        for err in errors:
            print("-", err)
        raise SystemExit(1)
    print("OK", count)


if __name__ == "__main__":
    main()


