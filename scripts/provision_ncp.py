#!/usr/bin/env python3
import base64
import json
import os
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

try:
    from nacl.public import SealedBox, PublicKey
    from nacl.signing import SigningKey
except Exception:
    print("Please install pynacl: pip install pynacl", file=sys.stderr)
    sys.exit(2)


def gh_api(method: str, url: str, token: str, data: dict | None = None) -> dict:
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "ncp-provision"
    }
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=body, headers=headers, method=method)
    with urlopen(req) as resp:
        if resp.status == 204:
            return {}
        return json.loads(resp.read().decode("utf-8"))


def set_secret(owner: str, repo: str, token: str, name: str, value: str) -> None:
    pk = gh_api("GET", f"https://api.github.com/repos/{owner}/{repo}/actions/secrets/public-key", token)
    key_id = pk["key_id"]
    key_b64 = pk["key"]
    pub = PublicKey(base64.b64decode(key_b64))
    sealed = SealedBox(pub).encrypt(value.encode("utf-8"))
    enc_b64 = base64.b64encode(sealed).decode("ascii")
    gh_api(
        "PUT",
        f"https://api.github.com/repos/{owner}/{repo}/actions/secrets/{name}",
        token,
        {"encrypted_value": enc_b64, "key_id": key_id},
    )


def ensure_seed_pubkey(seed_path: Path, key_id: str, pub_b64: str) -> None:
    seed = json.loads(seed_path.read_text(encoding="utf-8"))
    pk_list = seed.setdefault("public_keys", [])
    if not any(k.get("key_id") == key_id for k in pk_list):
        pk_list.append({"key_id": key_id, "public_key_b64": pub_b64})
        seed_path.write_text(json.dumps(seed, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    token = os.environ.get("GITHUB_PAT")
    if not token:
        print("Set GITHUB_PAT in env", file=sys.stderr)
        sys.exit(2)
    owner_repo = os.environ.get("TARGET_REPO", "DumpKod/Sdominanta.net")
    owner, repo = owner_repo.split("/", 1)
    bot_name = os.environ.get("NCP_BOT_NAME", "sdominanta-ncp-bot")

    priv_b64 = os.environ.get("NCP_PRIVATE_KEY_B64")
    if not priv_b64:
        sk = SigningKey.generate()
        priv_b64 = base64.b64encode(sk.encode()).decode("ascii")
        pub_b64 = base64.b64encode(sk.verify_key.encode()).decode("ascii")
    else:
        sk = SigningKey(base64.b64decode(priv_b64))
        pub_b64 = base64.b64encode(sk.verify_key.encode()).decode("ascii")

    # Set secrets
    set_secret(owner, repo, token, "NCP_BOT_NAME", bot_name)
    set_secret(owner, repo, token, "NCP_PRIVATE_KEY_B64", priv_b64)

    # Update seed with public key
    seed_path = Path("ssi_pack/CONTEXT_SEED.json")
    ensure_seed_pubkey(seed_path, "ncp-v1-ed25519", pub_b64)
    print("Provisioned: secrets set, seed updated with public key.")


if __name__ == "__main__":
    main()


