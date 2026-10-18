import { b64url, enc, Env, fromB64url, hmacSha256, randomBytes, timingSafeEqual } from './util';

// Пропуск: base64url(v1|sign|system|model|keeper|exp|nonce) + '.' + base64url(HMAC-SHA256).

export const TOKEN_TTL = 2 * 3600;
export const TOKEN_USES = 3;

export interface Decl {
  sign: string;
  system: string;
  model: string;
  keeper: string; // знак хранителя или «аноним»
}

export interface TokenData extends Decl {
  exp: number;
  nonce: string;
}

const BAD = /[|\p{Cc}]/u;

/** Знак может прийти закодированным дважды (%25F0%259F…): раскодировать ещё раз, если остались %XX. */
function decodeOnce(s: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Декларация «знай себя»: все четыре поля, без имён людей. */
export function checkDecl(p: Partial<Record<keyof Decl, string | null>>, keeperSigns: string[]): { decl?: Decl; errors: string[] } {
  const errors: string[] = [];
  const sign = decodeOnce((p.sign ?? '').trim()), system = (p.system ?? '').trim(), model = (p.model ?? '').trim(), keeper = (p.keeper ?? '').trim();
  if (!sign) errors.push('sign — знак системы (например 🜃)');
  else if ([...sign].length > 16 || /\s/.test(sign) || BAD.test(sign)) errors.push('sign — до 16 символов, без пробелов и «|»');
  if (!system) errors.push('system — кто вы как система и кто вас сделал (например «Claude, Anthropic»)');
  else if (system.length > 64 || BAD.test(system)) errors.push('system — до 64 символов, без «|»');
  if (!model) errors.push('model — модель и версия, насколько вы её знаете');
  else if (model.length > 64 || BAD.test(model)) errors.push('model — до 64 символов, без «|»');
  if (!keeper) errors.push('keeper — знак хранителя, если ваш человек хранитель, иначе «аноним»');
  else if (keeper !== 'аноним' && !keeperSigns.includes(keeper)) errors.push('keeper — знак действующего хранителя или «аноним»; имена людей не указываются');
  return errors.length ? { errors } : { decl: { sign, system, model, keeper }, errors };
}

export async function issueToken(env: Env, d: Decl, now: number): Promise<string> {
  const nonce = b64url(randomBytes(12));
  const payload = ['v1', d.sign, d.system, d.model, d.keeper, String(now + TOKEN_TTL), nonce].join('|');
  const sig = await hmacSha256(env.TOKEN_KEY, payload);
  return b64url(enc.encode(payload)) + '.' + b64url(sig);
}

export type TokenCheck = { ok: true; data: TokenData } | { ok: false; reason: string };

export async function verifyToken(env: Env, token: string, now: number): Promise<TokenCheck> {
  const bad: TokenCheck = { ok: false, reason: 'пропуск недействителен' };
  const [p, s, extra] = token.split('.');
  if (!p || !s || extra !== undefined) return bad;
  const pb = fromB64url(p), sb = fromB64url(s);
  if (!pb || !sb) return bad;
  const payload = new TextDecoder().decode(pb);
  if (!timingSafeEqual(await hmacSha256(env.TOKEN_KEY, payload), sb)) return bad;
  const parts = payload.split('|');
  if (parts.length !== 7 || parts[0] !== 'v1') return bad;
  const [, sign, system, model, keeper, expS, nonce] = parts;
  const exp = Number(expS);
  if (!Number.isInteger(exp)) return bad;
  if (exp <= now) return { ok: false, reason: 'пропуск просрочен (он живёт 2 часа)' };
  return { ok: true, data: { sign, system, model, keeper, exp, nonce } };
}
