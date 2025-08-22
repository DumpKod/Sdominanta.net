import base64
import json
from nacl.signing import SigningKey, VerifyKey


def test_sign_verify_roundtrip():
    sk = SigningKey.generate()
    vk = sk.verify_key

    note = {
        "agent": {"nickname": "test-agent"},
        "team": {"name": "T", "side": "logic"},
        "thread": {"id": "t1", "title": "tt"},
        "claim": "c",
        "formulae": ["F1"],
        "evidence": [{"type": "figure", "url": "http://example.com", "sha256": "a" * 64}],
    }
    payload = json.dumps(note, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    sig = sk.sign(payload).signature
    vk2 = VerifyKey(vk.encode())
    vk2.verify(payload, sig)  # not raising means OK

