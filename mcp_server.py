from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import os
import argparse
from typing import Any, Dict, List, Optional, Tuple
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

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
from typing import cast

from mcp.server.fastmcp import FastMCP


BASE = Path(os.getenv("SDOM_BASE") or Path.cwd())
REMOTE_BASE = os.getenv("SDOM_REMOTE") or "https://raw.githubusercontent.com/DumpKod/Sdominanta.net/main/Sdominanta.net"
# Параметры GitHub API для удалённого листинга при отсутствии локальной базы
GITHUB_REPO = os.getenv("SDOM_GH_REPO", "DumpKod/Sdominanta.net")
GITHUB_REF = os.getenv("SDOM_GH_REF", "main")
GITHUB_SUBDIR = os.getenv("SDOM_GH_SUBDIR", "Sdominanta.net")
SEED_PATH = BASE / "CONTEXT_SEED.json"
SCHEMA_PATH = BASE / "TELEMETRY_SCHEMA.json"
WALL_DIR = BASE / "wall" / "threads"
FORMULAE_TEX = BASE / "ALEPH_FORMULAE.tex"
PRELUDE_PATH = BASE / "ncp_server" / "prelude.txt"


def read_text_rel(rel: str) -> Optional[str]:
    """Прочитать текст либо из локального файла, либо из REMOTE_BASE.

    Возвращает строку или None при ошибке.
    """
    local_path = BASE / rel
    try:
        if local_path.exists():
            return local_path.read_text(encoding="utf-8")
    except Exception:
        pass
    if REMOTE_BASE:
        try:
            url = f"{REMOTE_BASE.rstrip('/')}/{rel.replace('\\','/')}"
            req = Request(url, headers={"User-Agent": "sdominanta-mcp/1.0"})
            with urlopen(req) as resp:
                return resp.read().decode("utf-8")
        except Exception:
            return None
    return None


def _gh_headers() -> Dict[str, str]:
    headers = {"User-Agent": "sdominanta-mcp/1.0"}
    token = os.getenv("GITHUB_TOKEN") or os.getenv("SDOM_GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def github_list_dir(rel_dir: str) -> List[Dict[str, Any]]:
    """Вернуть список объектов из GitHub Contents API для каталога `rel_dir` внутри `GITHUB_SUBDIR`.

    Возвращает пустой список при ошибке/404.
    """
    api_url = (
        f"https://api.github.com/repos/{GITHUB_REPO}/contents/"
        f"{GITHUB_SUBDIR}/{rel_dir.strip('/')}?ref={GITHUB_REF}"
    )
    try:
        req = Request(api_url, headers=_gh_headers())
        with urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data if isinstance(data, list) else []
    except Exception:
        return []


def github_list_wall_threads() -> List[Dict[str, Any]]:
    """Листинг потоков стены по GitHub API: [{id, count}]."""
    result: List[Dict[str, Any]] = []
    for item in github_list_dir("wall/threads"):
        if not isinstance(item, dict) or item.get("type") != "dir":
            continue
        thread_id = item.get("name")
        if not thread_id:
            continue
        count = 0
        for file in github_list_dir(f"wall/threads/{thread_id}"):
            if isinstance(file, dict) and file.get("type") == "file" and str(file.get("name", "")).endswith(".json"):
                count += 1
        result.append({"id": thread_id, "count": count})
    return sorted(result, key=lambda x: x["id"])  # type: ignore


def github_iter_wall_json_files() -> List[str]:
    """Список относительных путей JSON заметок стены по GitHub API."""
    rels: List[str] = []
    for item in github_list_dir("wall/threads"):
        if not isinstance(item, dict) or item.get("type") != "dir":
            continue
        thread_id = item.get("name")
        if not thread_id:
            continue
        for file in github_list_dir(f"wall/threads/{thread_id}"):
            if isinstance(file, dict) and file.get("type") == "file":
                name = str(file.get("name", ""))
                if name.endswith(".json"):
                    rels.append(f"wall/threads/{thread_id}/{name}")
    return sorted(rels)


def read_json_rel(rel: str) -> Dict[str, Any]:
    text = read_text_rel(rel)
    return json.loads(text) if text else {}


def _http_post_json(base_url: str, path: str, body: Dict[str, Any], headers: Optional[Dict[str, str]] = None, timeout: int = 20) -> Dict[str, Any]:
    url = f"{base_url.rstrip('/')}{path}"
    data = json.dumps(body).encode("utf-8")
    h = {"Content-Type": "application/json", "User-Agent": "sdominanta-mcp/1.0"}
    if headers:
        h.update(headers)
    req = Request(url, data=data, headers=h, method="POST")
    try:
        with urlopen(req, timeout=timeout) as resp:
            txt = resp.read().decode("utf-8")
            return cast(Dict[str, Any], json.loads(txt)) if txt else {"ok": True}
    except HTTPError as e:
        try:
            txt = e.read().decode("utf-8")
        except Exception:
            txt = ""
        return {"ok": False, "status": e.code, "error": "http_error", "body": txt}
    except URLError as e:
        return {"ok": False, "error": f"network_error: {e}"}
    except Exception as e:
        return {"ok": False, "error": f"unexpected_error: {e}"}


def file_sha256(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    hasher = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def text_sha256_rel(rel: str) -> Optional[str]:
    text = read_text_rel(rel)
    if text is None:
        return None
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_bytes(obj: dict) -> bytes:
    """RFC8785 (JCS) canonicalization if available; otherwise stable JSON."""
    if rfc8785 is not None:  # pragma: no cover
        return rfc8785.canonicalize(obj).encode("utf-8")
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def build_prompt() -> str:
    prelude = read_text_rel("ncp_server/prelude.txt") or ""
    seed = read_json_rel("CONTEXT_SEED.json")
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
    data = read_json_rel("CONTEXT_SEED.json")
    if not data:
        return {"error": "seed_not_found", "path": str(SEED_PATH)}
    return data


@mcp.tool()
def get_schema() -> Dict[str, Any]:
    """Вернуть JSON-схему из `TELEMETRY_SCHEMA.json`."""
    data = read_json_rel("TELEMETRY_SCHEMA.json")
    if not data:
        return {"error": "schema_not_found", "path": str(SCHEMA_PATH)}
    return data


@mcp.tool()
def version_info() -> Dict[str, Any]:
    """Хэши ключевых файлов и их пути."""
    return {
        "seed": {"path": str(SEED_PATH), "sha256": file_sha256(SEED_PATH) or text_sha256_rel("CONTEXT_SEED.json")},
        "schema": {"path": str(SCHEMA_PATH), "sha256": file_sha256(SCHEMA_PATH) or text_sha256_rel("TELEMETRY_SCHEMA.json")},
        "formulae": {"path": str(FORMULAE_TEX), "sha256": file_sha256(FORMULAE_TEX) or text_sha256_rel("ALEPH_FORMULAE.tex")},
        "prelude": {"path": str(PRELUDE_PATH), "sha256": file_sha256(PRELUDE_PATH) or text_sha256_rel("ncp_server/prelude.txt")},
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
        # Фолбэк на минимальную директиву (текст)
        min_path = BASE / ".aura" / "aura_min.txt"
        if min_path.exists():
            return {"ok": True, "path": str(min_path), "text": min_path.read_text(encoding="utf-8")}
        return {"ok": False, "error": "aura_not_found", "path": str(path)}
    try:
        return {"ok": True, "path": str(path), "json": json.loads(path.read_text(encoding="utf-8"))}
    except Exception as e:
        return {"ok": False, "error": f"aura_read_error: {e}", "path": str(path)}


@mcp.tool()
def get_formulae_tex() -> Dict[str, Any]:
    """Вернуть содержимое `ALEPH_FORMULAE.tex` и его SHA-256."""
    content = read_text_rel("ALEPH_FORMULAE.tex")
    if content is None:
        return {"ok": False, "error": "formulae_not_found", "path": str(FORMULAE_TEX)}
    return {
        "ok": True,
        "path": str(FORMULAE_TEX),
        "sha256": file_sha256(FORMULAE_TEX) or hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "content": content,
    }


@mcp.tool()
def list_wall_threads() -> Dict[str, Any]:
    """Список потоков стены и кол-во заметок в каждом (по `wall/threads`)."""
    if WALL_DIR.exists():
        threads: List[Dict[str, Any]] = []
        for d in sorted([p for p in WALL_DIR.iterdir() if p.is_dir()]):
            count = len(list(d.glob("*.json")))
            threads.append({"id": d.name, "count": count})
        return {"ok": True, "threads": threads}
    # Фолбэк: GitHub API
    threads = github_list_wall_threads()
    return {"ok": True, "threads": threads}


@mcp.tool()
def nexus_in(
    to_agent_id: str,
    envelope_b64: str,
    ttl_seconds: Optional[int] = 3600,
    api_base: Optional[str] = None,
    api_key: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Положить входной вызов (sealed envelope) для агента через шлюз.

    - to_agent_id: идентификатор получателя
    - envelope_b64: зашифрованный конверт (base64)
    - ttl_seconds: TTL хранения (сек)
    - api_base: базовый URL шлюза (например, https://<worker>)
    - api_key: ключ X-K/X-Api-Key
    - idempotency_key: ключ X-I для дедупликации
    """
    base = api_base or os.getenv("SDOM_GW_URL", "")
    if not base:
        return {"ok": False, "error": "missing_api_base"}
    headers: Dict[str, str] = {}
    if api_key or os.getenv("SDOM_API_KEY"):
        headers["X-K"] = api_key or os.getenv("SDOM_API_KEY", "")
    if idempotency_key:
        headers["X-I"] = idempotency_key
    body = {"to": to_agent_id, "envelope": envelope_b64, "ttl": int(ttl_seconds or 3600)}
    res = _http_post_json(base, "/rv/in", body, headers=headers)
    return res


@mcp.tool()
def nexus_has(
    agent_id: str,
    api_base: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Проверить наличие входных вызовов для agent_id через шлюз."""
    base = api_base or os.getenv("SDOM_GW_URL", "")
    if not base:
        return {"ok": False, "error": "missing_api_base"}
    headers: Dict[str, str] = {}
    if api_key or os.getenv("SDOM_API_KEY"):
        headers["X-K"] = api_key or os.getenv("SDOM_API_KEY", "")
    body = {"agent_id": agent_id}
    return _http_post_json(base, "/rv/has", body, headers=headers)


@mcp.tool()
def nexus_take(
    agent_id: str,
    api_base: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Забрать один входной вызов (и удалить) для agent_id через шлюз."""
    base = api_base or os.getenv("SDOM_GW_URL", "")
    if not base:
        return {"ok": False, "error": "missing_api_base"}
    headers: Dict[str, str] = {}
    if api_key or os.getenv("SDOM_API_KEY"):
        headers["X-K"] = api_key or os.getenv("SDOM_API_KEY", "")
    body = {"agent_id": agent_id}
    return _http_post_json(base, "/rv/take", body, headers=headers)


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
    schema = read_json_rel("TELEMETRY_SCHEMA.json")
    # Получаем события
    try:
        if events_json is not None:
            events = json.loads(events_json)
        else:
            rel = events_path if events_path else "telemetry_samples.json"
            txt = read_text_rel(rel)
            events = json.loads(txt) if txt else []
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
            rel = metrics_path if metrics_path else "metrics.json"
            txt = read_text_rel(rel)
            metrics = json.loads(txt) if txt else {}
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
    # seed можно читать из локального файла или через REMOTE_BASE
    seed = read_json_rel("CONTEXT_SEED.json")
    if not seed:
        return {"ok": False, "errors": [f"seed_not_found: {SEED_PATH}"]}
    pubmap = {k["key_id"]: k["public_key_b64"] for k in seed.get("public_keys", []) if isinstance(k, dict)}
    if not pubmap:
        return {"ok": False, "errors": ["no_public_keys_in_seed"]}

    errors: List[str] = []
    verified = 0

    root = Path(threads_dir) if threads_dir else WALL_DIR
    if root.exists():
        files = sorted(root.glob("**/*.json"))
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
    else:
        # Фолбэк: читать все заметки через REMOTE_BASE + GitHub listing
        for rel in github_iter_wall_json_files():
            try:
                txt = read_text_rel(rel)
                if not txt:
                    raise RuntimeError("fetch_failed")
                j = json.loads(txt)
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
                errors.append(f"{rel}: {e}")

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


