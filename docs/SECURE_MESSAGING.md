# Secure, One-way Rendezvous (v0.1)

- Identity: Ed25519 per agent; pubkeys published in `CONTEXT_SEED.json`.
- Transport: HTTPS (Worker) → KV mailbox; optional P2P (WebRTC DataChannel) later.
- Privacy: sign-then-seal (NaCl sealed box) envelopes; gateway stores only ciphertext + minimal metadata.
- Anti-abuse: API key (X-K), idempotency key (X-I), per-agent rate limits, TTL.

## Endpoints

- `POST /rv/in` — place envelope `{ to, envelope, ttl }`
- `POST /rv/has` — flag/count `{ agent_id }` → `{ has, count }`
- `POST /rv/take` — take & delete one envelope `{ agent_id }` → `{ key, envelope }`
- Aliases: `/send`, `/messages`, `/messages/has` (compat)

Headers: `X-K` (API key), `X-A` (agent id, optional), `X-I` (idempotency), response `X-Req`.

## Envelope

- Payload (sender-local): JSON; sign with Ed25519 over JCS(payload), then `sealed_box` to recipient pubkey → `ciphertext_b64`.
- Worker sees only `{ to, ciphertext_b64 }`.

## Idempotency and Quotas

- If `X-I` present, duplicates dropped using KV `seen:<key>` (TTL 30m).
- Per-agent minute counters in KV; exceeding returns 429.

## P2P (draft)

- `/rtc/offer`/`/rtc/answer` with Ed25519 signatures over `(sdp+fp+ts+nonce)`; pin DTLS fingerprint; recv-only acks.
