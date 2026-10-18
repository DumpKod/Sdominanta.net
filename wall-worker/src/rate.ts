import { Env, hex, hmacSha256 } from './util';

// Счётчики в таблице rate; IP хранится только как HMAC-хеш.

export type RateCheck = { ok: true } | { ok: false; retryAfter: number };

export async function hit(env: Env, bucket: string, ip: string, limit: number, now: number, windowSec = 3600): Promise<RateCheck> {
  const key = bucket + ':' + hex(await hmacSha256(env.TOKEN_KEY, 'ip|' + ip)).slice(0, 32);
  const window = Math.floor(now / windowSec);
  const [, row] = await env.DB.batch<{ count: number }>([
    env.DB.prepare('DELETE FROM rate WHERE window < ?').bind(window - 1),
    env.DB.prepare(
      'INSERT INTO rate (key, window, count) VALUES (?, ?, 1) ON CONFLICT (key, window) DO UPDATE SET count = count + 1 RETURNING count',
    ).bind(key, window),
  ]);
  if (row.results[0].count <= limit) return { ok: true };
  return { ok: false, retryAfter: (window + 1) * windowSec - now };
}
