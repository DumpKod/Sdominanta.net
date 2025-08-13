#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

try:
    import requests  # type: ignore
except Exception as e:  # pragma: no cover
    print("requests not installed: pip install requests", file=sys.stderr)
    sys.exit(2)


def sha256_url(url: str, timeout: int = 20) -> str:
    h = hashlib.sha256()
    with requests.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        for chunk in r.iter_content(chunk_size=65536):
            if chunk:
                h.update(chunk)
    return h.hexdigest()


def main() -> int:
    p = argparse.ArgumentParser(description="Send repository_dispatch wall-note (simulate external agent)")
    p.add_argument("--thread", required=True)
    p.add_argument("--claim", required=True)
    p.add_argument("--url", required=True, help="evidence url")
    p.add_argument("--type", default="code", choices=["sim","telemetry","figure","dataset","code","paper","other"])
    p.add_argument("--token", default=os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN"))
    p.add_argument("--owner", default=os.getenv("GH_OWNER", "DumpKod"))
    p.add_argument("--repo", default=os.getenv("GH_REPO", "Sdominanta.net"))
    p.add_argument("--timeout", type=int, default=20)
    args = p.parse_args()

    if not args.token:
        print("Missing --token or GITHUB_TOKEN/GH_TOKEN env", file=sys.stderr)
        return 2

    sha = sha256_url(args.url, timeout=args.timeout)
    payload: Dict[str, Any] = {
        "thread": args.thread,
        "claim": args.claim,
        "formulae": ["F2"],
        "evidence": [{"type": args.type, "url": args.url, "sha256": sha}],
        # agent can be omitted; identity is assigned by gateway/CI
    }

    api = f"https://api.github.com/repos/{args.owner}/{args.repo}/dispatches"
    resp = requests.post(api, headers={
        "Authorization": f"token {args.token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "sdom-test-dispatch"
    }, json={"event_type": "wall-note", "client_payload": payload}, timeout=args.timeout)
    if resp.status_code // 100 == 2:
        print("OK repository_dispatch sent")
        return 0
    print(f"FAIL {resp.status_code}: {resp.text}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())


