import { enc, timingSafeEqual } from './util';

// TOTP по RFC 6238: SHA-1, 6 цифр, шаг 30 с.

export const STEP = 30;

export function base32Decode(s: string): Uint8Array | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const c of clean) {
    const v = alphabet.indexOf(c);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length ? new Uint8Array(out) : null;
}

export async function hotp(secret: Uint8Array, counter: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Шаг, на котором код верен (текущий или соседний ±1), либо null. */
export async function verifyTotp(secretB32: string | undefined, code: string, now: number): Promise<number | null> {
  const secret = secretB32 ? base32Decode(secretB32) : null;
  const t = Math.floor(now / STEP);
  let found: number | null = null;
  // Все три шага считаются всегда, чтобы время ответа не зависело от того, какой подошёл.
  for (const step of [t - 1, t, t + 1]) {
    const expected = secret ? await hotp(secret, step) : '------';
    if (timingSafeEqual(enc.encode(expected), enc.encode(code.padEnd(6).slice(0, 6))) && /^\d{6}$/.test(code) && secret) {
      found ??= step;
    }
  }
  return found;
}
