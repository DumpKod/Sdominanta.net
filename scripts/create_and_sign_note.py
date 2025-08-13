#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

try:
    import rfc8785  # JCS canonical JSON
    # python-rfc8785 v1.x API предоставляет функцию rfc8785.dumps
    _HAS_DUMPS = hasattr(rfc8785, "dumps")
    _HAS_CANON = hasattr(rfc8785, "canonicalize")
except Exception:
    rfc8785 = None
    _HAS_DUMPS = False
    _HAS_CANON = False

from nacl.signing import SigningKey


def jcs_canonical_bytes(obj: dict) -> bytes:
    if rfc8785 is not None:
        try:
            if _HAS_DUMPS:
                return rfc8785.dumps(obj).encode("utf-8")
            if _HAS_CANON:  # старое имя
                return rfc8785.canonicalize(obj).encode("utf-8")
        except Exception:
            pass
    # Фолбэк на стабильный JSON
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Create and sign WALL note (JCS + Ed25519)")
    parser.add_argument("--seedfile", required=True, help="Path to CONTEXT_SEED.json")
    parser.add_argument("--priv_b64", required=False, help="Ed25519 private key in base64 (32 bytes)")
    parser.add_argument("--thread", required=True)
    parser.add_argument("--note-json", required=False)
    parser.add_argument("--note-file", required=False)
    parser.add_argument("--outdir", required=True, help="wall/threads")
    parser.add_argument("--agent", default="ncp-bot")
    parser.add_argument("--team", default="logic")
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--truth-score", type=float, default=None, help="0..1 — заявленная метрика истинности")
    parser.add_argument("--truth-def", type=str, default=None, help="Краткое определение истинности (<=2000 символов)")
    args = parser.parse_args()

    if not args.note_json and not args.note_file:
        raise SystemExit("Either --note-json or --note-file required")

    if args.note_file:
        note = json.loads(Path(args.note_file).read_text(encoding="utf-8"))
    else:
        note = json.loads(args.note_json)

    seed = json.loads(Path(args.seedfile).read_text(encoding="utf-8"))
    seed_sha = sha256_hex(Path(args.seedfile).read_bytes())

    now = datetime.now(timezone.utc).isoformat()
    note.setdefault("id", sha256_hex(f"{args.thread}|{now}".encode("utf-8"))[:16])
    note.setdefault("timestamp", now)
    if "agent" not in note:
        note["agent"] = {"nickname": args.agent}
    if "team" not in note:
        note["team"] = {"name": "ncp", "side": args.team}
    if "thread" not in note:
        note["thread"] = {"id": args.thread, "title": args.thread, "parent_note_id": None}

    # Опциональный блок truth
    if args.truth_score is not None or args.truth_def:
        ts = args.truth_score
        if ts is not None and (ts < 0 or ts > 1):
            raise SystemExit("--truth-score must be in [0,1]")
        note["truth"] = {
            "definition": args.truth_def or "",
            "score": ts if ts is not None else 0.0,
        }

    canon = jcs_canonical_bytes(note)
    priv_b64 = args.priv_b64 or os.getenv("NCP_PRIVATE_KEY_B64")
    if not priv_b64:
        raise SystemExit("Missing NCP_PRIVATE_KEY_B64 or --priv_b64")
    sk = SigningKey(base64.b64decode(priv_b64))
    sig_b64 = base64.b64encode(sk.sign(canon).signature).decode("ascii")

    note["ncp_signature"] = {
        "signer": args.agent,
        "key_id": args.key_id,
        "signature": sig_b64,
        "seed_sha256": seed_sha,
        "signature_alg": "ed25519-jcs",
        "timestamp": now,
    }

    outdir = Path(args.outdir) / args.thread
    outdir.mkdir(parents=True, exist_ok=True)
    outfile = outdir / f"{note['id']}.json"
    outfile.write_text(json.dumps(note, ensure_ascii=False, indent=2), encoding="utf-8")
    print(outfile)


if __name__ == "__main__":
    main()


