#!/usr/bin/env python3
import base64
import json
import sys
from pathlib import Path

try:
    import rfc8785
except Exception:
    rfc8785 = None

from nacl.signing import VerifyKey
from nacl.exceptions import BadSignatureError


def canonical_bytes(obj: dict) -> bytes:
    if rfc8785 is not None:
        return rfc8785.canonicalize(obj).encode("utf-8")
    import json as _json
    return _json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def verify_one(note_path: Path, pubkeys: dict) -> None:
    j = json.loads(note_path.read_text(encoding="utf-8"))
    sig = j.get("ncp_signature")
    if not sig:
        raise SystemExit(f"missing ncp_signature: {note_path}")
    key_id = sig.get("key_id")
    if key_id not in pubkeys:
        raise SystemExit(f"unknown key_id: {key_id}")
    vk = VerifyKey(base64.b64decode(pubkeys[key_id]))
    j2 = dict(j)
    j2.pop("ncp_signature", None)
    try:
        vk.verify(canonical_bytes(j2), base64.b64decode(sig.get("signature")))
    except BadSignatureError:
        raise SystemExit(f"bad signature: {note_path}")


def main() -> None:
    seed = json.loads(Path("ssi_pack/CONTEXT_SEED.json").read_text(encoding="utf-8"))
    pubmap = {k["key_id"]: k["public_key_b64"] for k in seed.get("public_keys", [])}
    root = Path("ssi_pack/wall/threads")
    files = sorted(root.glob("**/*.json"))
    for f in files:
        verify_one(f, pubmap)
    print("OK", len(files))


if __name__ == "__main__":
    main()


