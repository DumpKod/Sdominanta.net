import { keeperAccount } from './account';
import { verifyTotp, STEP } from './totp';
import { b64url, enc, Env, fromB64url, hmacSha256, keepers, sha256hex, timingSafeEqual } from './util';

// Хранитель входит в два слоя.
// Слой 1: ключ хранителя → cookie __Host-keeper. Без неё /review, /approve, /reject отвечают 403
//         и не трогают ни TOTP, ни счётчики: посторонний не может ни подбирать код, ни заблокировать хранителя.
// Слой 2: TOTP — на вход в панель /k (сессия) или на каждое решение старыми адресами; 5 неверных подряд — блокировка, каждая следующая вдвое длиннее
//         (15 мин → … → 24 ч); уровень сбрасывается только верным кодом.

export const COOKIE = '__Host-keeper';
export const COOKIE_TTL = 30 * 24 * 3600;
export const MAX_FAILS = 5;
export const LOCK_SEC = 15 * 60;
export const MAX_LOCK_SEC = 24 * 3600;
const DAY = 24 * 3600;

// ---------- слой 1: ключ и cookie ----------

/** Знак хранителя, чей ключ подошёл, или null. Сравниваются все отпечатки, за постоянное время каждый. */
export async function keeperByKey(env: Env, key: string): Promise<string | null> {
  const got = enc.encode(await sha256hex(key));
  let found: string | null = null;
  for (const [sign, k] of Object.entries(keepers(env))) {
    if (timingSafeEqual(got, enc.encode(k.key_sha256)) && key) found ??= sign;
  }
  return found;
}

const cookieSig = async (env: Env, payload: string) => b64url(await hmacSha256(env.TOKEN_KEY, 'keeper|' + payload));

/** Первые 8 знаков отпечатка ключа: смена ключа хранителя отзывает только его cookie. */
const keyTag = (env: Env, sign: string) => keepers(env)[sign]?.key_sha256.slice(0, 8) ?? '';

/** Нагрузка cookie: знак|exp|первые 8 знаков отпечатка ключа, подпись TOKEN_KEY. */
export async function issueKeeperCookie(env: Env, sign: string, now: number): Promise<string> {
  const payload = `${sign}|${now + COOKIE_TTL}|${keyTag(env, sign)}`;
  return b64url(enc.encode(payload)) + '.' + (await cookieSig(env, payload));
}

export function cookieHeader(value: string): string {
  return `${COOKIE}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_TTL}`;
}

/** Знак хранителя из валидной cookie: подпись верна, срок не истёк, хранитель действующий, ключ не менялся. */
export async function keeperFromCookie(env: Env, req: Request, now: number): Promise<string | null> {
  const raw = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [p, s, extra] = raw.slice(COOKIE.length + 1).split('.');
  if (!p || !s || extra !== undefined) return null;
  const pb = fromB64url(p);
  if (!pb) return null;
  const payload = new TextDecoder().decode(pb);
  if (!timingSafeEqual(enc.encode(await cookieSig(env, payload)), enc.encode(s))) return null;
  const [sign, expS, tag, more] = payload.split('|');
  const exp = Number(expS);
  if (more !== undefined || !Number.isInteger(exp) || exp <= now) return null;
  const current = keyTag(env, sign);
  return current && tag === current ? sign : null;
}

// ---------- слой 2: TOTP и нарастающая блокировка ----------

export type KeeperCheck = { ok: true } | { ok: false; locked: boolean };

interface LockRow {
  fails: number;
  locked_until: number | null;
  level: number;
  day_start: number;
  day_fails: number;
}

export async function checkKeeper(env: Env, keeper: string, otp: string, now: number): Promise<KeeperCheck> {
  // Сюда приходят только из-за cookie, но строки блокировок создаются лишь для существующих хранителей.
  // Секрет — из аккаунта (таблица accounts, зашифрован), аккаунт создаётся из KEEPERS при первом обращении.
  const k = await keeperAccount(env, keeper, now);
  if (!k) return { ok: false, locked: false };
  const db = env.DB;
  const lock = await db.prepare('SELECT * FROM keeper_lock WHERE keeper = ?').bind(keeper).first<LockRow>();
  if (lock?.locked_until && lock.locked_until > now) return { ok: false, locked: true };

  const step = await verifyTotp(k.totp, otp, now);
  if (step !== null) {
    await db.prepare('DELETE FROM otp_used WHERE step < ?').bind(Math.floor(now / STEP) - 10).run();
    // Вставка с первичным ключом атомарна: повтор того же кода (в том числе одновременный) не пройдёт.
    const ins = await db.prepare('INSERT OR IGNORE INTO otp_used (keeper, step) VALUES (?, ?)').bind(keeper, step).run();
    if (ins.meta.changes === 1) {
      await db.prepare('UPDATE keeper_lock SET fails = 0, level = 0, locked_until = NULL WHERE keeper = ?').bind(keeper).run();
      return { ok: true };
    }
  }

  const row = await db
    .prepare(
      `INSERT INTO keeper_lock (keeper, fails, day_start, day_fails) VALUES (?1, 1, ?2, 1)
       ON CONFLICT (keeper) DO UPDATE SET
         fails = fails + 1,
         day_fails = CASE WHEN ?2 - day_start >= ${DAY} THEN 1 ELSE day_fails + 1 END,
         day_start = CASE WHEN ?2 - day_start >= ${DAY} THEN ?2 ELSE day_start END
       RETURNING fails, level`,
    )
    .bind(keeper, now)
    .first<{ fails: number; level: number }>();
  if (row && row.fails >= MAX_FAILS) {
    await db
      .prepare('UPDATE keeper_lock SET fails = 0, level = level + 1, locked_until = ? WHERE keeper = ?')
      .bind(now + lockDuration(row.level), keeper)
      .run();
    return { ok: false, locked: true };
  }
  return { ok: false, locked: false };
}

/** Длительность блокировки на уровне n: 15 мин · 2ⁿ, не больше суток. */
export function lockDuration(level: number): number {
  return Math.min(LOCK_SEC * 2 ** Math.min(level, 20), MAX_LOCK_SEC);
}

/** Для /review: неверные коды за сутки и текущая блокировка. */
export async function lockInfo(env: Env, keeper: string, now: number): Promise<{ dayFails: number; lockedUntil: number | null; level: number }> {
  const r = await env.DB.prepare('SELECT * FROM keeper_lock WHERE keeper = ?').bind(keeper).first<LockRow>();
  return {
    dayFails: r && now - r.day_start < DAY ? r.day_fails : 0,
    lockedUntil: r?.locked_until && r.locked_until > now ? r.locked_until : null,
    level: r?.level ?? 0,
  };
}
