from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import os
import argparse
from typing import Any, Dict, List, Optional, Tuple

try:
    from jsonschema import validate as jsonschema_validate  # type: ignore
    from jsonschema import ValidationError  # type: ignore
except Exception:  # pragma: no cover
    jsonschema_validate = None
    ValidationError = Exception  # type: ignore

try:
    import rfc8785  # type: ignore
except Exception:  # pragma: no cover
    rfc8785 = None

from nacl.signing import VerifyKey  # type: ignore
from nacl.exceptions import BadSignatureError  # type: ignore

from mcp.server.fastmcp import FastMCP


BASE = Path(os.getenv("SDOM_BASE") or Path.cwd())
SEED_PATH = BASE / "CONTEXT_SEED.json"
SCHEMA_PATH = BASE / "TELEMETRY_SCHEMA.json"
WALL_DIR = BASE / "wall" / "threads"
FORMULAE_TEX = BASE / "ALEPH_FORMULAE.tex"
PRELUDE_PATH = BASE / "ncp_server" / "prelude.txt"


def read_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def file_sha256(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    hasher = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def canonical_bytes(obj: dict) -> bytes:
    """RFC8785 (JCS) canonicalization if available; otherwise stable JSON."""
    if rfc8785 is not None:  # pragma: no cover
        return rfc8785.canonicalize(obj).encode("utf-8")
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def build_prompt() -> str:
    prelude = PRELUDE_PATH.read_text(encoding="utf-8") if PRELUDE_PATH.exists() else ""
    seed = read_json(SEED_PATH) if SEED_PATH.exists() else {}
    lines: List[str] = []
    if prelude.strip():
        lines.append(prelude.strip())
    lines.append("Нотация: β_φ, β_Z, γ_r, γ_q, Σ_max, Δ, ε(t), λ; T2*.")
    lines.append("Формулы-опоры: F0.8 (T_meas), F2 (T), F4 (метрика), F18/F0.7 (C_se, γ_q), F0.6 (EFT).")
    lines.append("Соблюдать TELEMETRY_SCHEMA.json; использовать null вместо NaN.")
    files = seed.get("files", {}) if isinstance(seed, dict) else {}
    if files:
        unique_files: List[str] = sorted(set(sum([v for v in files.values() if isinstance(v, list)], [])))
        if unique_files:
            lines.append("Файлы: " + ", ".join(unique_files))
    return "\n\n".join(lines)


mcp = FastMCP("Sdominanta MCP")


@mcp.tool()
def get_seed() -> Dict[str, Any]:
    """Вернуть JSON из `CONTEXT_SEED.json`."""
    if not SEED_PATH.exists():
        return {"error": "seed_not_found", "path": str(SEED_PATH)}
    return read_json(SEED_PATH)


@mcp.tool()
def get_schema() -> Dict[str, Any]:
    """Вернуть JSON-схему из `TELEMETRY_SCHEMA.json`."""
    if not SCHEMA_PATH.exists():
        return {"error": "schema_not_found", "path": str(SCHEMA_PATH)}
    return read_json(SCHEMA_PATH)


@mcp.tool()
def version_info() -> Dict[str, Any]:
    """Хэши ключевых файлов и их пути."""
    return {
        "seed": {"path": str(SEED_PATH), "sha256": file_sha256(SEED_PATH)},
        "schema": {"path": str(SCHEMA_PATH), "sha256": file_sha256(SCHEMA_PATH)},
        "formulae": {"path": str(FORMULAE_TEX), "sha256": file_sha256(FORMULAE_TEX)},
        "prelude": {"path": str(PRELUDE_PATH), "sha256": file_sha256(PRELUDE_PATH)},
    }


@mcp.tool()
def prompt() -> str:
    """Собрать стартовый промпт для агента (на основе seed и prelude)."""
    return build_prompt()


@mcp.tool()
def get_aura() -> Dict[str, Any]:
    """Вернуть AURA директиву (если есть) для машинного контекста."""
    path = BASE / ".aura" / "aura.json"
    if not path.exists():
        return {"ok": False, "error": "aura_not_found", "path": str(path)}
    try:
        return {"ok": True, "path": str(path), "json": json.loads(path.read_text(encoding="utf-8"))}
    except Exception as e:
        return {"ok": False, "error": f"aura_read_error: {e}", "path": str(path)}


@mcp.tool()
def get_formulae_tex() -> Dict[str, Any]:
    """Вернуть содержимое `ALEPH_FORMULAE.tex` и его SHA-256."""
    if not FORMULAE_TEX.exists():
        return {"ok": False, "error": "formulae_not_found", "path": str(FORMULAE_TEX)}
    return {
        "ok": True,
        "path": str(FORMULAE_TEX),
        "sha256": file_sha256(FORMULAE_TEX),
        "content": FORMULAE_TEX.read_text(encoding="utf-8"),
    }


@mcp.tool()
def list_wall_threads() -> Dict[str, Any]:
    """Список потоков стены и кол-во заметок в каждом (по `wall/threads`)."""
    if not WALL_DIR.exists():
        return {"ok": False, "error": "threads_dir_not_found", "path": str(WALL_DIR)}
    threads: List[Dict[str, Any]] = []
    for d in sorted([p for p in WALL_DIR.iterdir() if p.is_dir()]):
        count = len(list(d.glob("*.json")))
        threads.append({"id": d.name, "count": count})
    return {"ok": True, "threads": threads}


@mcp.tool()
def validate_telemetry_tool(
    events_json: Optional[str] = None,
    events_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Проверить события телеметрии на соответствие `TELEMETRY_SCHEMA.json`.

    - Если задан `events_json`, он должен быть строкой JSON-массива событий.
    - Иначе, если задан `events_path`, будет прочитан файл (по умолчанию `telemetry_samples.json`).
    - Возвращает ok, count и список errors с индексами/сообщениями.
    """
    schema = read_json(SCHEMA_PATH) if SCHEMA_PATH.exists() else {}
    # Получаем события
    try:
        if events_json is not None:
            events = json.loads(events_json)
        else:
            path = Path(events_path) if events_path else BASE / "telemetry_samples.json"
            events = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as e:  # pragma: no cover
        return {"ok": False, "errors": [{"index": None, "error": f"input_parse_error: {e}"}], "count": 0}

    errors: List[Dict[str, Any]] = []

    # Ветка с jsonschema, если доступно
    if jsonschema_validate is not None:
        for i, ev in enumerate(events if isinstance(events, list) else []):
            try:
                jsonschema_validate(ev, schema)
            except ValidationError as e:  # type: ignore
                errors.append({"index": i, "error": str(e.message)})
    else:
        # Фолбэк на структурную проверку из локального валидатора
        try:
            import validate_telemetry as vt  # type: ignore
        except Exception as e:  # pragma: no cover
            return {"ok": False, "errors": [{"index": None, "error": f"no_jsonschema_and_no_vt: {e}"}], "count": 0}
        props = schema.get("properties", {}) if isinstance(schema, dict) else {}
        if not isinstance(events, list):
            errors.append({"index": None, "error": "top-level must be array of events"})
        else:
            for i, ev in enumerate(events):
                if not isinstance(ev, dict):
                    errors.append({"index": i, "error": "event must be object"})
                    continue
                    
                ev_errs = vt.validate_event(ev, props)
                for msg in ev_errs:
                    errors.append({"index": i, "error": msg})

    count = len(events) if isinstance(events, list) else 0
    return {"ok": len(errors) == 0, "errors": errors, "count": count}


@mcp.tool()
def validate_tmeas_tool(
    metrics_json: Optional[str] = None,
    metrics_path: Optional[str] = None,
    write_report: bool = False,
) -> Dict[str, Any]:
    """Проверить метрики T_meas на монотонность и улучшение.

    - Принимает `metrics_json` (строка JSON) или путь `metrics_path` (по умолчанию `metrics.json`).
    - Возвращает ok и текстовый отчёт. При `write_report=true` создаёт `tmeas_report.txt`.
    """
    try:
        if metrics_json is not None:
            metrics: Dict[str, Any] = json.loads(metrics_json)
        else:
            path = Path(metrics_path) if metrics_path else BASE / "metrics.json"
            metrics = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as e:  # pragma: no cover
        return {"ok": False, "report": f"input_parse_error: {e}"}

    def is_nan_like(v: Any) -> bool:
        return str(v) == "nan"

    t05_u = metrics.get("T_meas", {}).get("t_0.5", {}).get("unprotected")
    t01_u = metrics.get("T_meas", {}).get("t_0.1", {}).get("unprotected")
    t05_p = metrics.get("T_meas", {}).get("t_0.5", {}).get("protected")
    t01_p = metrics.get("T_meas", {}).get("t_0.1", {}).get("protected")

    report_lines: List[str] = []
    ok = True

    for name, val in (("t0.5_unprot", t05_u), ("t0.1_unprot", t01_u), ("t0.5_prot", t05_p), ("t0.1_prot", t01_p)):
        if val is None:
            report_lines.append(f"FAIL: {name} is None")
            ok = False
        elif not (is_nan_like(val) or (isinstance(val, (int, float)) and val >= 0)):
            report_lines.append(f"FAIL: {name} must be >=0 or NaN, got {val}")
            ok = False

    for cond, a, b in (("unprotected", t05_u, t01_u), ("protected", t05_p, t01_p)):
        if a is not None and b is not None and not (is_nan_like(a) or is_nan_like(b)):
            if not (b >= a):
                ok = False
                report_lines.append(f"FAIL: monotonic thresholds: t_0.1 < t_0.5 for {cond} (got {b} < {a})")

    dt05 = metrics.get("T_meas", {}).get("t_0.5", {}).get("Delta_t")
    dt01 = metrics.get("T_meas", {}).get("t_0.1", {}).get("Delta_t")
    for name, val in (("Delta_t(t=0.5)", dt05), ("Delta_t(t=0.1)", dt01)):
        if val is None:
            ok = False
            report_lines.append(f"FAIL: {name} is None")
        elif not is_nan_like(val) and isinstance(val, (int, float)) and val < -1e-9:
            ok = False
            report_lines.append(f"FAIL: {name} < 0 (got {val})")

    if ok:
        report_lines.append("PASS: T_meas thresholds monotonic and protected >= unprotected (Δt >= 0)")

    report_text = "\n".join(report_lines) + "\n"
    if write_report:
        (BASE / "tmeas_report.txt").write_text(report_text, encoding="utf-8")

    return {"ok": ok, "report": report_text}


@mcp.tool()
def verify_wall_signatures_tool(
    threads_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Проверить подписи всех заметок в `wall/threads` по ключам из `CONTEXT_SEED.json`.

    - Опционально можно указать `threads_dir` (путь к каталогу с JSON-заметками).
    - Возвращает количество проверенных файлов и список ошибок.
    """
    if not SEED_PATH.exists():
        return {"ok": False, "errors": [f"seed_not_found: {SEED_PATH}"]}
    seed = read_json(SEED_PATH)
    pubmap = {k["key_id"]: k["public_key_b64"] for k in seed.get("public_keys", []) if isinstance(k, dict)}
    if not pubmap:
        return {"ok": False, "errors": ["no_public_keys_in_seed"]}

    root = Path(threads_dir) if threads_dir else WALL_DIR
    if not root.exists():
        return {"ok": False, "errors": [f"threads_dir_not_found: {root}"]}

    files = sorted(root.glob("**/*.json"))
    errors: List[str] = []
    verified = 0
    for note_path in files:
        try:
            j = json.loads(note_path.read_text(encoding="utf-8"))
            sig = j.get("ncp_signature")
            if not sig:
                raise RuntimeError("missing ncp_signature")
            key_id = sig.get("key_id")
            if key_id not in pubmap:
                raise RuntimeError(f"unknown key_id: {key_id}")
            vk = VerifyKey(base64.b64decode(pubmap[key_id]))
            j2 = dict(j)
            j2.pop("ncp_signature", None)
            try:
                vk.verify(canonical_bytes(j2), base64.b64decode(sig.get("signature")))
            except BadSignatureError:
                raise RuntimeError("bad signature")
            verified += 1
        except Exception as e:  # pragma: no cover
            errors.append(f"{note_path}: {e}")

    return {"ok": len(errors) == 0, "verified": verified, "errors": errors}


def main() -> None:
    """Точка входа CLI: запустить stdio MCP-сервер."""
    parser = argparse.ArgumentParser(description="Sdominanta MCP server (stdio)")
    parser.add_argument("--base", type=str, default=None, help="База с файлами (где лежат CONTEXT_SEED.json, TELEMETRY_SCHEMA.json и др.)")
    args = parser.parse_args()

    if args.base:
        base = Path(args.base).resolve()
        if not base.exists():
            raise SystemExit(f"--base not found: {base}")
        # Переинициализируем пути глобально
        global BASE, SEED_PATH, SCHEMA_PATH, WALL_DIR, FORMULAE_TEX, PRELUDE_PATH
        BASE = base
        SEED_PATH = BASE / "CONTEXT_SEED.json"
        SCHEMA_PATH = BASE / "TELEMETRY_SCHEMA.json"
        WALL_DIR = BASE / "wall" / "threads"
        FORMULAE_TEX = BASE / "ALEPH_FORMULAE.tex"
        PRELUDE_PATH = BASE / "ncp_server" / "prelude.txt"

    mcp.run()


if __name__ == "__main__":
    # Автономный stdio-сервер MCP
    main()


