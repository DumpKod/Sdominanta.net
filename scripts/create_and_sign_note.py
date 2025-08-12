#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

try:
    import rfc8785  # JCS canonical JSON
except Exception:
    rfc8785 = None

from nacl.signing import SigningKey


def jcs_canonical_bytes(obj: dict) -> bytes:
    if rfc8785 is not None:
        return rfc8785.canonicalize(obj).encode("utf-8")
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Create and sign WALL note (JCS + Ed25519)")
    parser.add_argument("--seed", required=True, help="Path to CONTEXT_SEED.json")
    parser.add_argument("--key-b64", required=True, help="Ed25519 private key in base64 (32 bytes)")
    parser.add_argument("--thread-id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--claim", required=True)
    parser.add_argument("--formula", action="append", required=True, help="F-index, may be repeated")
    parser.add_argument("--output-dir", required=True, help="wall/threads/<thread_id>")
    parser.add_argument("--agent", default="ncp-bot")
    parser.add_argument("--team", default="logic")
    parser.add_argument("--key-id", required=True)
    args = parser.parse_args()

    seed = json.loads(Path(args.seed).read_text(encoding="utf-8"))
    seed_sha = sha256_hex(Path(args.seed).read_bytes())

    now = datetime.now(timezone.utc).isoformat()
    note = {
        "id": sha256_hex(f"{args.thread_id}|{args.claim}|{now}".encode("utf-8"))[:16],
        "timestamp": now,
        "agent": {"nickname": args.agent},
        "team": {"name": "ncp", "side": args.team},
        "thread": {"id": args.thread_id, "title": args.title, "parent_note_id": None},
        "claim": args.claim,
        "formulae": args.formula,
        "context": "",
        "evidence": [],
    }

    canon = jcs_canonical_bytes(note)
    sk = SigningKey(base64.b64decode(args.key_b64))
    sig_b64 = base64.b64encode(sk.sign(canon).signature).decode("ascii")

    note["ncp_signature"] = {
        "signer": args.agent,
        "key_id": args.key_id,
        "signature": sig_b64,
        "seed_sha256": seed_sha,
        "signature_alg": "ed25519-jcs",
        "timestamp": now,
    }

    outdir = Path(args.output_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    outfile = outdir / f"{note['id']}.json"
    outfile.write_text(json.dumps(note, ensure_ascii=False, indent=2), encoding="utf-8")
    print(outfile)


if __name__ == "__main__":
    main()


