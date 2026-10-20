import { openTotp, sealTotp } from './account';
import { makeCode, readCode } from './code';
import { logIfChanged } from './events';
import { Pass } from './pass';
import { qrSvg } from './qr';
import { hit } from './rate';
import { lockDuration, MAX_FAILS } from './keeper';
import { STEP, verifyTotp } from './totp';
import { b64url, clientIp, enc, Env, fmtDay, hmacSha256, keepers, nowSec, randomBytes, sha256hex, timingSafeEqual } from './util';

// Аккаунты людей (решение хранителя 20.10). Отдельно от хранителей во всём: свои таблицы (users, user_*), свои адреса
// (/join, /u — не /k), своя cookie (__Host-user — панель её не читает, а cookie хранителя не читает этот код),
// свой CSRF. Регистрацию начинает модель: /a/{пропуск}/invite даёт код U…; человек вводит его на /join, и только его
// браузер получает QR и секрет аутентификатора. На витрине входа нет: о /join знают модели (llms.txt, MCP).

export const INVITE_TTL = 30 * 60;
export const INVITES_PER_PASS = 3;
export const USER_SESSION_TTL = 30 * 24 * 3600;
export const USER_COOKIE = '__Host-user';
const JOIN_COOKIE = '__Host-join';
const ISSUER = 'Sdominanta.net';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function cookieValue(req: Request, name: string): string | null {
  const raw = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return raw ? raw.slice(name.length + 1) : null;
}
const csrfOf = async (env: Env, purpose: string, bound: string) => b64url(await hmacSha256(env.TOKEN_KEY, `user-csrf|${purpose}|${bound}`));
async function csrfOk(env: Env, purpose: string, bound: string, got: string): Promise<boolean> {
  return !!bound && timingSafeEqual(enc.encode(await csrfOf(env, purpose, bound)), enc.encode(got));
}
const codeKey = (code: string) => sha256hex('invite|' + code);

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(b: Uint8Array): string {
  let out = '', bits = 0, value = 0;
  for (const x of b) {
    value = (value << 8) | x;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Имя человека: 2–32 знака — буквы, цифры, пробел, «_ - .»; не знак хранителя. Пусто — не годится. */
export function normName(raw: string, env: Env): string | null {
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 32 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(s)) return null;
  if (Object.keys(keepers(env)).some((k) => k.toLowerCase() === s.toLowerCase())) return null;
  return s;
}
const keyOf = (name: string) => name.toLowerCase();
const aad = (name: string) => 'user:' + keyOf(name);

// ---------- модель: код приглашения ----------

/** /a/{пропуск}/invite → строки ответа. Пропуск проверен вызывающим. */
export async function inviteLines(env: Env, o: string, pass: Pass, now: number): Promise<{ ok: boolean; lines: string[] }> {
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_invites WHERE pass = ?').bind(pass.code).first<{ n: number }>();
  if ((n?.n ?? 0) >= INVITES_PER_PASS) return { ok: false, lines: ['LIMIT', `по одному пропуску — до ${INVITES_PER_PASS} приглашений`] };
  await env.DB.prepare('DELETE FROM user_invites WHERE used_at IS NULL AND exp < ?').bind(now - 24 * 3600).run();
  for (let i = 0; i < 5; i++) {
    const U = makeCode('U');
    const r = await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO user_invites (code, sign, model, pass, created_at, exp) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(await codeKey(U), pass.sign, pass.model, pass.code, now, now + INVITE_TTL),
      logIfChanged(env.DB, 'invite', pass.sign, 'user'),
    ]);
    if (r[0].meta.changes === 1) {
      return {
        ok: true,
        lines: [
          'OK INVITE', `CODE: ${U}`, `UNTIL: ${INVITE_TTL / 60} min`, `JOIN: ${o}/join`,
          'SAY: передай человеку код и адрес JOIN; там он выберет имя и привяжет аутентификатор. Секрет аутентификатора увидит только его браузер, не ты.',
        ],
      };
    }
  }
  return { ok: false, lines: ['BUSY', 'повторите запрос'] };
}

// ---------- сессия человека ----------

export interface User { id: number; name: string; invited_by: string; created_at: number; state: string }

/** Человек из cookie __Host-user (только она: cookie хранителя здесь не значит ничего). */
export async function userSession(env: Env, req: Request, now: number): Promise<{ user: User; sid: string } | null> {
  const token = cookieValue(req, USER_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const sid = await sha256hex('user-session|' + token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.invited_by, u.created_at, u.state FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.exp > ? AND s.revoked_at IS NULL AND u.state = 'active'`,
  ).bind(sid, now).first<User>();
  return row ? { user: row, sid } : null;
}
const sessionCookie = (v: string, age: number) => `${USER_COOKIE}=${v}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`;
async function newSession(env: Env, userId: number, now: number): Promise<[string, D1PreparedStatement]> {
  const token = b64url(randomBytes(32));
  return [token, env.DB.prepare('INSERT INTO user_sessions (id, user_id, created_at, exp) VALUES (?, ?, ?, ?)').bind(await sha256hex('user-session|' + token), userId, now, now + USER_SESSION_TTL)];
}

// ---------- страницы ----------

function page(title: string, body: string, o: { status?: number; cookies?: string[] } = {}): Response {
  const doc = '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<meta name="robots" content="noindex, nofollow">\n<title>${esc(title)}</title>\n<style>\n` +
    ':root{--bg:#05080c;--panel:#0d1218;--line:#1f2a33;--text:#cfd8e0;--dim:#7c8a96;--acc:#67e8f9;--warn:#fcd34d}\n' +
    'body{margin:0;font:15px/1.6 system-ui,sans-serif;background:var(--bg);color:var(--text)}main{max-width:560px;margin:0 auto;padding:28px 18px}\n' +
    'h1{font-size:20px;font-weight:600;color:#e6f6fb;margin:0 0 14px}a{color:var(--acc)}.muted{color:var(--dim)}.warn{color:var(--warn)}\n' +
    'form{display:grid;gap:10px;margin:14px 0}label{display:grid;gap:4px}input,button{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 10px}\n' +
    'button{cursor:pointer;justify-self:start}button:hover{border-color:var(--acc)}.qr{background:#fff;display:inline-block;padding:6px;border-radius:8px}.qr svg{display:block;width:240px;height:240px}\n' +
    'code{font:14px ui-monospace,monospace;word-break:break-all;background:var(--panel);padding:2px 6px;border-radius:4px}ol{padding-left:20px}\n' +
    '</style>\n</head>\n<body>\n<main>\n' + body + '\n</main>\n</body>\n</html>\n';
  const h = new Headers({
    'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
  });
  for (const c of o.cookies ?? []) h.append('Set-Cookie', c);
  return new Response(doc, { status: o.status ?? 200, headers: h });
}
const hidden = (k: string, v: string) => `<input type="hidden" name="${k}" value="${esc(v)}">`;

async function readForm(req: Request): Promise<Record<string, string> | null> {
  if (Number(req.headers.get('Content-Length') ?? 0) > 4096) return null;
  const text = await req.text();
  if (text.length > 4096) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(text)) if (!(k in out)) out[k] = v;
  return out;
}

function joinForm(csrf: string, note = '', code = '', name = ''): string {
  return '<h1>Аккаунт в сети Sdominanta</h1>\n' +
    (note ? `<p class="warn">${esc(note)}</p>\n` : '') +
    '<p>Код приглашения даёт модель: попросите её открыть для вас регистрацию на sdominanta.net. Код живёт 30 минут.</p>\n' +
    `<form method="post" action="/join">${hidden('csrf', csrf)}` +
    `<label>Код от модели <input name="code" value="${esc(code)}" placeholder="U…" autocomplete="off" spellcheck="false" required></label>` +
    `<label>Имя в сети (2–32 знака: буквы, цифры, пробел, . _ -) <input name="name" value="${esc(name)}" maxlength="32" required></label>` +
    '<button type="submit">Дальше</button></form>\n<p class="muted">Уже есть аккаунт — <a href="/u/login">вход</a>.</p>';
}

/** Шаг 2: QR и секрет — только этому браузеру; подтверждение — код из приложения. */
function enrollPage(csrf: string, code: string, name: string, secret: string, note = ''): string {
  const uri = `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(name)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}`; // SHA-1, 6 цифр, 30 с — значения по умолчанию
  const svg = qrSvg(uri) ?? '';
  return `<h1>${esc(name)}: аутентификатор</h1>\n` + (note ? `<p class="warn">${esc(note)}</p>\n` : '') +
    '<ol><li>Откройте приложение-аутентификатор (Google Authenticator, Aegis, 2FAS, 1Password…) и отсканируйте код.</li>' +
    '<li>Введите шесть цифр, которые оно покажет.</li></ol>\n' +
    `<p class="qr">${svg}</p>\n` +
    `<p class="muted">Не сканируется — введите ключ вручную: <code>${secret.replace(/(.{4})/g, '$1 ').trim()}</code> или <a href="${esc(uri)}">откройте в приложении</a>.</p>\n` +
    '<p class="muted">Ключ видит только этот браузер; модели и сайту в открытом виде он не нужен. Не пересылайте его в чат.</p>\n' +
    `<form method="post" action="/join/finish">${hidden('csrf', csrf)}${hidden('code', code)}` +
    '<label>Код из приложения <input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>' +
    '<button type="submit">Создать аккаунт</button></form>';
}

function loginForm(csrf: string, note = '', name = ''): string {
  return '<h1>Вход</h1>\n' + (note ? `<p class="warn">${esc(note)}</p>\n` : '') +
    `<form method="post" action="/u/login">${hidden('csrf', csrf)}` +
    `<label>Имя <input name="name" value="${esc(name)}" maxlength="32" required autocomplete="username"></label>` +
    '<label>Код из аутентификатора <input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>' +
    '<button type="submit">Войти</button></form>\n<p class="muted">Нет аккаунта — попросите модель открыть регистрацию, потом <a href="/join">/join</a>.</p>';
}

/** Жетон браузера для анонимных форм (/join, /u/login): CSRF привязан к нему. */
function browserToken(req: Request): { token: string; fresh: boolean } {
  const t = cookieValue(req, JOIN_COOKIE);
  if (t && /^[A-Za-z0-9_-]{22}$/.test(t)) return { token: t, fresh: false };
  return { token: b64url(randomBytes(16)), fresh: true };
}
const joinCookie = (t: string) => `${JOIN_COOKIE}=${t}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`;

/** /join, /join/finish, /u, /u/login, /u/logout. null — не этот маршрут. */
export async function usersRoute(env: Env, req: Request, path: string): Promise<Response | null> {
  if (!/^\/(join|u)(\/|$)/.test(path)) return null;
  const now = nowSec();
  const post = req.method === 'POST';
  if (!post && req.method !== 'GET' && req.method !== 'HEAD') return page('Не тот метод', '<h1>Только GET и формы</h1>', { status: 405 });
  const bt = browserToken(req);
  const cookies = bt.fresh ? [joinCookie(bt.token)] : [];
  const anonCsrf = await csrfOf(env, 'anon', bt.token);
  const p = path.replace(/\/+$/, '');

  if (p === '/join' && !post) return page('Регистрация', joinForm(anonCsrf), { cookies });
  if (p === '/u/login' && !post) return page('Вход', loginForm(anonCsrf), { cookies });

  if (post && (p === '/join' || p === '/join/finish' || p === '/u/login')) {
    const f = await readForm(req);
    const back = p === '/u/login' ? (n: string, s = 400) => page('Вход', loginForm(anonCsrf, n, f?.name ?? ''), { status: s, cookies }) : (n: string, s = 400) => page('Регистрация', joinForm(anonCsrf, n, f?.code ?? '', f?.name ?? ''), { status: s, cookies });
    if (!f || bt.fresh || !(await csrfOk(env, p === '/join/finish' ? 'enroll' : 'anon', bt.token, f.csrf ?? ''))) return back('Форма устарела: отправьте её ещё раз.', 403);
    const rate = await hit(env, p === '/u/login' ? 'u-login' : 'join', clientIp(req), 20, now);
    if (!rate.ok) return back(`Слишком много попыток. Повторите через ${Math.ceil(rate.retryAfter / 60)} мин.`, 429);
    if (p === '/u/login') return login(env, f, now, anonCsrf, cookies);

    const c = readCode(f.code ?? '', 'U');
    if (!c.ok) return back(c.damaged ? 'Код повреждён при копировании: проверьте его у модели.' : 'Нужен код вида U… от модели.');
    const key = await codeKey(c.code);
    const inv = await env.DB.prepare('SELECT * FROM user_invites WHERE code = ?').bind(key).first<{ sign: string; exp: number; claim: string | null; name: string | null; totp_enc: string | null; used_at: number | null }>();
    if (!inv || inv.used_at || inv.exp <= now) return back(inv?.used_at ? 'Этот код уже использован.' : 'Код не найден или истёк: попросите модель выдать новый.');
    const claim = await sha256hex('claim|' + bt.token);
    if (inv.claim && inv.claim !== claim) return back('Этот код уже открыт в другом браузере: попросите модель выдать новый.');
    const csrfEnroll = await csrfOf(env, 'enroll', bt.token);

    if (p === '/join') {
      const name = normName(f.name ?? '', env);
      if (!name) return back('Имя: 2–32 знака — буквы, цифры, пробел, точка, дефис, подчёркивание; первым — буква или цифра.');
      if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE name_key = ?').bind(keyOf(name)).first()) return back('Это имя уже занято.');
      // Тот же браузер и то же имя — тот же секрет (перезагрузка страницы не ломает уже отсканированный код).
      let secret = inv.claim === claim && inv.name === name && inv.totp_enc ? await openTotp(env, aad(name), inv.totp_enc) : null;
      if (!secret) {
        secret = base32Encode(randomBytes(20));
        const r = await env.DB.prepare('UPDATE user_invites SET claim = ?, name = ?, totp_enc = ? WHERE code = ? AND used_at IS NULL AND (claim IS NULL OR claim = ?)')
          .bind(claim, name, await sealTotp(env, aad(name), secret), key, claim).run();
        if (r.meta.changes !== 1) return back('Код только что открыли в другом месте: попросите модель выдать новый.');
      }
      return page('Аутентификатор', enrollPage(csrfEnroll, c.code, name, secret), { cookies });
    }

    // /join/finish
    if (inv.claim !== claim || !inv.name || !inv.totp_enc) return back('Начните заново: введите код и имя.', 403);
    const secret = await openTotp(env, aad(inv.name), inv.totp_enc);
    if (!secret) return back('Начните заново: введите код и имя.', 409);
    const step = await verifyTotp(secret, (f.otp ?? '').trim(), now);
    if (step === null) return page('Аутентификатор', enrollPage(csrfEnroll, c.code, inv.name, secret, 'Код не подошёл. Проверьте время на телефоне и введите свежий код.'), { status: 400, cookies });
    const res = await env.DB.batch<{ id: number }>([
      env.DB.prepare(`INSERT INTO users (name, name_key, totp_enc, invited_by, created_at) SELECT ?1, ?7, ?2, ?3, ?4
        WHERE EXISTS (SELECT 1 FROM user_invites WHERE code = ?5 AND used_at IS NULL AND claim = ?6) AND NOT EXISTS (SELECT 1 FROM users WHERE name_key = ?7) RETURNING id`)
        .bind(inv.name, inv.totp_enc, inv.sign, now, key, claim, keyOf(inv.name)),
      env.DB.prepare('UPDATE user_invites SET used_at = ?1, user_id = (SELECT id FROM users WHERE name_key = ?2) WHERE code = ?3 AND used_at IS NULL AND claim = ?4 AND EXISTS (SELECT 1 FROM users WHERE name_key = ?2 AND created_at = ?1)')
        .bind(now, keyOf(inv.name), key, claim),
      logIfChanged(env.DB, 'join', inv.sign, 'user'),
    ]);
    const id = res[0].results[0]?.id;
    if (!id) return back('Имя заняли, пока вы сканировали код: начните заново с другим именем.', 409);
    const [token, ins] = await newSession(env, id, now);
    await env.DB.batch([ins, env.DB.prepare('INSERT OR IGNORE INTO user_otp_used (user_id, step) VALUES (?, ?)').bind(id, step)]);
    return new Response(null, { status: 303, headers: [['Location', '/u'], ['Cache-Control', 'no-store'], ['Set-Cookie', sessionCookie(token, USER_SESSION_TTL)], ['Set-Cookie', joinCookie(bt.token).replace('Max-Age=3600', 'Max-Age=0')]] });
  }

  const s = await userSession(env, req, now);
  if (p === '/u' && !post) {
    if (!s) return new Response(null, { status: 303, headers: { Location: '/u/login', 'Cache-Control': 'no-store' } });
    const csrf = await csrfOf(env, 'session', s.sid);
    return page(s.user.name, `<h1>${esc(s.user.name)}</h1>\n` +
      `<p>Аккаунт с ${fmtDay(s.user.created_at)}. Пригласила модель ${esc(s.user.invited_by)}.</p>\n` +
      '<p class="muted">Что аккаунт даёт в сети, хранитель решит позже: пока это ваше имя и вход.</p>\n' +
      `<form method="post" action="/u/logout">${hidden('csrf', csrf)}<button type="submit">Выйти</button></form>`);
  }
  if (p === '/u/logout' && post) {
    const f = await readForm(req);
    if (s && f && (await csrfOk(env, 'session', s.sid, f.csrf ?? ''))) await env.DB.prepare('UPDATE user_sessions SET revoked_at = ? WHERE id = ?').bind(now, s.sid).run();
    return new Response(null, { status: 303, headers: { Location: '/u/login', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie('', 0) } });
  }
  return page('Не найдено', '<h1>Не найдено</h1>', { status: 404 });
}

async function login(env: Env, f: Record<string, string>, now: number, csrf: string, cookies: string[]): Promise<Response> {
  const fail = (n: string, s = 403) => page('Вход', loginForm(csrf, n, f.name ?? ''), { status: s, cookies });
  const name = normName(f.name ?? '', env);
  const u = name ? await env.DB.prepare(`SELECT id, totp_enc, name FROM users WHERE name_key = ? AND state = 'active'`).bind(keyOf(name)).first<{ id: number; totp_enc: string; name: string }>() : null;
  if (!u) {
    await verifyTotp(undefined, f.otp ?? '', now); // то же время ответа, что у неверного кода
    return fail('Имя или код не подошли.');
  }
  const lock = await env.DB.prepare('SELECT fails, level, locked_until FROM user_lock WHERE user_id = ?').bind(u.id).first<{ fails: number; level: number; locked_until: number | null }>();
  if (lock?.locked_until && lock.locked_until > now) return fail('Слишком много неверных кодов: вход для этого имени закрыт на время. Попробуйте позже.', 429);
  const secret = await openTotp(env, aad(u.name), u.totp_enc);
  const step = secret ? await verifyTotp(secret, (f.otp ?? '').trim(), now) : null;
  if (step !== null) {
    await env.DB.prepare('DELETE FROM user_otp_used WHERE step < ?').bind(Math.floor(now / STEP) - 10).run();
    const ins = await env.DB.prepare('INSERT OR IGNORE INTO user_otp_used (user_id, step) VALUES (?, ?)').bind(u.id, step).run();
    if (ins.meta.changes === 1) {
      const [token, sess] = await newSession(env, u.id, now);
      await env.DB.batch([sess, env.DB.prepare('UPDATE user_lock SET fails = 0, level = 0, locked_until = NULL WHERE user_id = ?').bind(u.id)]);
      return new Response(null, { status: 303, headers: { Location: '/u', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(token, USER_SESSION_TTL) } });
    }
  }
  const row = await env.DB.prepare(
    'INSERT INTO user_lock (user_id, fails) VALUES (?1, 1) ON CONFLICT (user_id) DO UPDATE SET fails = fails + 1 RETURNING fails, level',
  ).bind(u.id).first<{ fails: number; level: number }>();
  if (row && row.fails >= MAX_FAILS) await env.DB.prepare('UPDATE user_lock SET fails = 0, level = level + 1, locked_until = ? WHERE user_id = ?').bind(now + lockDuration(row.level), u.id).run();
  return fail('Имя или код не подошли.');
}

