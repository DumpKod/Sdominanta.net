from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Body
from fastapi.responses import JSONResponse, PlainTextResponse
from jsonschema import validate as jsonschema_validate, ValidationError


BASE = Path(__file__).resolve().parent.parent  # ssi_pack/
SEED_PATH = BASE / "CONTEXT_SEED.json"
SCHEMA_PATH = BASE / "TELEMETRY_SCHEMA.json"
PRELUDE_PATH = Path(__file__).resolve().parent / "prelude.txt"
FORMULAE_TEX = BASE / "ALEPH_FORMULAE.tex"
QUEUE_PATH = Path(__file__).resolve().parent / "tasks_queue.jsonl"


def read_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def file_sha256(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def build_prompt() -> str:
    prelude = PRELUDE_PATH.read_text(encoding="utf-8") if PRELUDE_PATH.exists() else ""
    seed = read_json(SEED_PATH)
    lines: List[str] = []
    if prelude.strip():
        lines.append(prelude.strip())
    lines.append("Нотация: β_φ, β_Z, γ_r, γ_q, Σ_max, Δ, ε(t), λ; T2*.")
    lines.append("Формулы-опоры: F0.8 (T_meas), F2 (T), F4 (метрика), F18/F0.7 (C_se, γ_q), F0.6 (EFT).")
    lines.append("Соблюдать TELEMETRY_SCHEMA.json; использовать null вместо NaN.")
    # перечислить ключевые файлы для агента
    files = seed.get("files", {})
    if files:
        lines.append("Файлы: " + ", ".join(sorted(set(sum([v for v in files.values() if isinstance(v, list)], [])))))
    return "\n\n".join(lines)


def enqueue_task(task: Dict[str, Any]) -> Dict[str, Any]:
    QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    task_id = str(uuid.uuid4())
    rec = {"id": task_id, "status": "pending", "task": task}
    with QUEUE_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def load_queue() -> List[Dict[str, Any]]:
    if not QUEUE_PATH.exists():
        return []
    return [json.loads(line) for line in QUEUE_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]


def save_queue(items: List[Dict[str, Any]]) -> None:
    data = "\n".join(json.dumps(i, ensure_ascii=False) for i in items) + ("\n" if items else "")
    QUEUE_PATH.write_text(data, encoding="utf-8")


app = FastAPI(title="ALEPH NCP Server", version="0.1.0")


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/seed")
def get_seed() -> JSONResponse:
    return JSONResponse(read_json(SEED_PATH))


@app.get("/schema")
def get_schema() -> JSONResponse:
    return JSONResponse(read_json(SCHEMA_PATH))


@app.get("/prelude")
def get_prelude() -> PlainTextResponse:
    text = PRELUDE_PATH.read_text(encoding="utf-8") if PRELUDE_PATH.exists() else ""
    return PlainTextResponse(text)


@app.get("/prompt")
def get_prompt() -> PlainTextResponse:
    return PlainTextResponse(build_prompt())


@app.post("/validate-telemetry")
def validate_telemetry(events: List[Dict[str, Any]] = Body(...)) -> Dict[str, Any]:
    schema = read_json(SCHEMA_PATH)
    errors: List[Dict[str, Any]] = []
    for i, ev in enumerate(events):
        try:
            jsonschema_validate(ev, schema)
        except ValidationError as e:
            errors.append({"index": i, "error": e.message})
    return {"ok": len(errors) == 0, "errors": errors, "count": len(events)}


@app.get("/version")
def version() -> Dict[str, Any]:
    return {
        "seed": {"path": str(SEED_PATH), "sha256": file_sha256(SEED_PATH)},
        "schema": {"path": str(SCHEMA_PATH), "sha256": file_sha256(SCHEMA_PATH)},
        "prelude": {"path": str(PRELUDE_PATH), "sha256": file_sha256(PRELUDE_PATH) if PRELUDE_PATH.exists() else None},
        "formulae": {"path": str(FORMULAE_TEX), "sha256": file_sha256(FORMULAE_TEX)},
    }


@app.post("/tasks")
def create_task(task: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    rec = enqueue_task(task)
    return rec


@app.post("/tasks/claim")
def claim_task(worker: Optional[str] = Body(default=None)) -> Dict[str, Any]:
    items = load_queue()
    for it in items:
        if it.get("status") == "pending":
            it["status"] = "claimed"
            it["worker"] = worker or str(uuid.uuid4())
            save_queue(items)
            return it
    return {"id": None, "status": "empty"}


@app.post("/tasks/{task_id}/complete")
def complete_task(task_id: str, result: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    items = load_queue()
    for it in items:
        if it.get("id") == task_id:
            it["status"] = "completed"
            it["result"] = result
            save_queue(items)
            return it
    return {"error": "not_found", "id": task_id}


