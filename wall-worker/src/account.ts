import { b64url, enc, Env, fromB64url, keepers } from './util';

// Аккаунты хранителей: таблица accounts. TOTP-секрет хранится зашифрованным AES-GCM;
// ключ шифрования выводится из TOKEN_KEY через HKDF и нигде не хранится.
// Источник аккаунтов пока один — KEEPERS: отсутствующий аккаунт создаётся, изменённая запись KEEPERS
// (новый ключ или новый TOTP-секрет хранителя) обновляет аккаунт. Смена TOKEN_KEY тоже лечится так:
// старый шифртекст не расшифровывается, и аккаунт пересоздаётся из KEEPERS.

export interface Account {
  sign: string;
  role: string;
  totp: string;
  key_sha256: string;
}

interface AccountRow {
  sign: string;
  role: string;
  totp_enc: string;
  key_sha256: string;
}

async function aesKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(env.TOKEN_KEY), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('sdominanta accounts'), info: enc.encode('totp_enc v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Шифртекст секрета: base64url(iv ‖ AES-GCM), знак аккаунта — дополнительные данные (строку нельзя переставить другому). */
export async function sealTotp(env: Env, sign: string, totp: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(sign) }, await aesKey(env), enc.encode(totp)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64url(out);
}

export async function openTotp(env: Env, sign: string, sealed: string): Promise<string | null> {
  const raw = fromB64url(sealed);
  if (!raw || raw.length < 13) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(sign) }, await aesKey(env), raw.slice(12));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Аккаунт хранителя: из таблицы, при необходимости созданный или обновлённый из KEEPERS. Нет в KEEPERS — нет аккаунта. */
export async function keeperAccount(env: Env, sign: string, now: number): Promise<Account | null> {
  const k = keepers(env)[sign];
  if (!k) return null;
  const row = await env.DB.prepare('SELECT sign, role, totp_enc, key_sha256 FROM accounts WHERE sign = ?').bind(sign).first<AccountRow>();
  const totp = row ? await openTotp(env, sign, row.totp_enc) : null;
  if (row && totp === k.totp && row.key_sha256 === k.key_sha256) return { sign, role: row.role, totp, key_sha256: row.key_sha256 };
  const sealed = await sealTotp(env, sign, k.totp);
  await env.DB.prepare(
    `INSERT INTO accounts (sign, role, totp_enc, key_sha256, created_at) VALUES (?, 'keeper', ?, ?, ?)
     ON CONFLICT (sign) DO UPDATE SET totp_enc = excluded.totp_enc, key_sha256 = excluded.key_sha256`,
  ).bind(sign, sealed, k.key_sha256, now).run();
  return { sign, role: row?.role ?? 'keeper', totp: k.totp, key_sha256: k.key_sha256 };
}
