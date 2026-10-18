import { checkKeeper, keeperFromCookie, lockInfo, COOKIE } from './keeper';
import { declineDraft, DRAFT_TTL, draftView, publishDraft, tooMany, waitingDrafts } from './post';
import { formatErrors } from './card';
import { hit } from './rate';
import { DEFAULT_SCENE, SCENE_MAX, publishedScene, SceneRow, validateScene, Scene } from './scene';
import { bumpVersion } from './post';
import { jsonResponse, vitrinaPage } from './vitrina';
import { b64url, clientIp, enc, Env, fmtTime, hmacSha256, html, nowSec, plain, randomBytes, sha256hex, timingSafeEqual } from './util';
import editorJs from './pages/editor.js.txt';

// Панель хранителя /k — простой HTML без скриптов.
// Вход в два слоя, как у старых адресов: cookie ключа (__Host-keeper) → форма с 6 цифрами из аутентификатора →
// cookie сессии __Host-session (HttpOnly, Secure, SameSite=Strict, 12 ч). Сессии — в таблице sessions,
// хранится только SHA-256 от значения cookie; «Выйти» и «Выйти везде» отзывают их.
// Каждая форма несёт CSRF-токен: HMAC(TOKEN_KEY) от сессии (до входа — от cookie ключа).
// Сессия действует только вместе с cookie ключа того же хранителя: смена ключа закрывает и панель.

export const SESSION = '__Host-session';
export const SESSION_TTL = 12 * 3600;
const FORM_MAX = 4096;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cookieValue(req: Request, name: string): string | null {
  const raw = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return raw ? raw.slice(name.length + 1) : null;
}

const sessionCookie = (value: string, maxAge: number) => `${SESSION}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

const csrfFor = async (env: Env, purpose: string, bound: string) => b64url(await hmacSha256(env.TOKEN_KEY, `csrf|${purpose}|${bound}`));

async function csrfOk(env: Env, purpose: string, bound: string, got: string): Promise<boolean> {
  return timingSafeEqual(enc.encode(await csrfFor(env, purpose, bound)), enc.encode(got));
}

interface Session {
  id: string;
  sign: string;
  exp: number;
}

async function sessionFrom(env: Env, req: Request, now: number): Promise<Session | null> {
  const v = cookieValue(req, SESSION);
  if (!v || !/^[A-Za-z0-9_-]{43}$/.test(v)) return null;
  const id = await sha256hex(v);
  return env.DB.prepare('SELECT id, sign, exp FROM sessions WHERE id = ? AND revoked_at IS NULL AND exp > ?').bind(id, now).first<Session>();
}

function page(title: string, body: string, o: { status?: number; headers?: Record<string, string> } = {}): Response {
  const doc =
    '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<meta name="robots" content="noindex, nofollow">\n<title>${esc(title)}</title>\n<style>\n` +
    'body{margin:0 auto;max-width:860px;padding:16px;font:15px/1.5 system-ui,sans-serif;background:#010306;color:#cbd5e1}\n' +
    'a{color:#67e8f9}h1{font-size:20px;color:#e2e8f0}h2{font-size:16px;color:#a5f3fc;margin-top:24px}\n' +
    'pre{white-space:pre-wrap;word-break:break-word;background:#020617;border:1px solid #164e63;border-radius:8px;padding:10px}\n' +
    'table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #1e293b;vertical-align:top}\n' +
    'input,textarea,button{font:inherit;color:#e2e8f0;background:#020617;border:1px solid #164e63;border-radius:6px;padding:6px 8px}\n' +
    'button{cursor:pointer;background:#083344}form{margin:8px 0}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}\n' +
    '.warn{color:#fcd34d}.muted{color:#64748b}textarea{width:100%;box-sizing:border-box}\n' +
    '</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  // same-origin, а не no-referrer: при no-referrer браузер шлёт с формы «Origin: null», и проверка своего адреса отказала бы.
  return html(doc, { status: o.status ?? 200, noStore: true, csp: CSP, headers: { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', ...o.headers } });
}

/** Сессия хранителя для витрины: cookie ключа + действующая сессия того же хранителя; csrf — токен её форм. */
export async function keeperSession(env: Env, req: Request, now: number): Promise<{ sign: string; id: string; csrf: string } | null> {
  const me = await keeperFromCookie(env, req, now);
  if (!me) return null;
  const s = await sessionFrom(env, req, now);
  if (!s || s.sign !== me) return null;
  return { sign: me, id: s.id, csrf: await csrfFor(env, 'session', s.id) };
}

const refused = () => page('Не принято', '<h1>Не принято</h1>', { status: 403 });

function loginForm(csrf: string, note = ''): string {
  return (
    '<h1>Панель хранителя</h1>\n' +
    (note ? `<p class="warn">${esc(note)}</p>\n` : '') +
    '<form method="post" action="/k/login" class="row">\n' +
    `<input type="hidden" name="csrf" value="${esc(csrf)}">\n` +
    '<label>Код из аутентификатора <input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>\n' +
    '<button type="submit">Войти</button>\n</form>\n<p class="muted">Сессия — 12 часов, «Выйти» закрывает её сразу.</p>'
  );
}

function header(sign: string, csrf: string): string {
  return (
    `<div class="row"><a href="/k">Очередь</a><a href="/k/vitrina">Витрина</a><span class="muted">Хранитель ${esc(sign)}</span>` +
    `<form method="post" action="/k/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Выйти</button></form>` +
    `<form method="post" action="/k/logout-all"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Выйти везде</button></form></div>`
  );
}

// Сохранение сцены несёт её JSON в форме: до 256 КБ, а кириллица в urlencoded растёт до 9 раз — потолок с запасом.
const SCENE_FORM_MAX = SCENE_MAX * 9 + FORM_MAX;

async function readForm(req: Request, max = FORM_MAX): Promise<Record<string, string> | null> {
  if (Number(req.headers.get('Content-Length') ?? 0) > max) return null;
  try {
    const text = await req.text();
    if (text.length > max) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) if (!(k in out)) out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/** POST только со своего адреса: браузер присылает Origin, и он должен совпасть. */
function sameOrigin(req: Request, o: string): boolean {
  const origin = req.headers.get('Origin');
  return origin === null || origin === o;
}

export async function panel(env: Env, o: string, req: Request, path: string): Promise<Response> {
  const now = nowSec();
  const me = await keeperFromCookie(env, req, now);
  if (!me) return refused();
  const post = req.method === 'POST';
  if (!post && req.method !== 'GET' && req.method !== 'HEAD') return page('Нет', '<h1>Только GET и POST</h1>', { status: 405 });
  if (post && !sameOrigin(req, o)) return refused();
  const rate = await hit(env, 'panel', clientIp(req), 300, now);
  if (!rate.ok) return tooMany(o, rate.retryAfter);

  const s = await sessionFrom(env, req, now);
  const session = s && s.sign === me ? s : null;

  // Код редактора витрины отдаётся только в сессии: без неё его нет нигде.
  if (path === '/editor.js') {
    if (!session || post) return plain('// нет сессии хранителя\n', { status: 403, noStore: true });
    return new Response(editorJs, {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
    });
  }

  if (!session) {
    const loginCsrf = await csrfFor(env, 'login', cookieValue(req, COOKIE) ?? '');
    if (path !== '/login' || !post) return page('Вход', loginForm(loginCsrf), { status: path === '' || path === '/login' ? 200 : 403 });
    const f = await readForm(req);
    if (!f || !(await csrfOk(env, 'login', cookieValue(req, COOKIE) ?? '', f.csrf ?? ''))) return page('Вход', loginForm(loginCsrf, 'Форма устарела, войдите ещё раз.'), { status: 403 });
    const krate = await hit(env, 'keeper', clientIp(req), 60, now);
    if (!krate.ok) return tooMany(o, krate.retryAfter);
    const res = await checkKeeper(env, me, (f.otp ?? '').trim(), now);
    if (!res.ok) {
      const lock = await lockInfo(env, me, now);
      const note = res.locked
        ? `Вход кодами временно закрыт: слишком много неверных кодов. Откроется ${lock.lockedUntil ? fmtTime(lock.lockedUntil) : 'позже'}.`
        : 'Код не принят.';
      return page('Вход', loginForm(loginCsrf, note), { status: 403 });
    }
    const token = b64url(randomBytes(32));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE exp <= ?').bind(now),
      env.DB.prepare('INSERT INTO sessions (id, sign, created_at, exp) VALUES (?, ?, ?, ?)').bind(await sha256hex(token), me, now, now + SESSION_TTL),
    ]);
    return new Response(null, {
      status: 303,
      headers: { Location: `${o}/k`, 'Set-Cookie': sessionCookie(token, SESSION_TTL), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  }

  const csrf = await csrfFor(env, 'session', session.id);
  const top = header(me, csrf);

  if (post) {
    const f = await readForm(req, path === '/vitrina/save' ? SCENE_FORM_MAX : FORM_MAX);
    if (!f || !(await csrfOk(env, 'session', session.id, f.csrf ?? ''))) return page('Отказ', top + '<h1>Отказ</h1><p>Форма устарела: откройте страницу заново.</p>', { status: 403 });
    if (path === '/logout' || path === '/logout-all') {
      const q = path === '/logout' ? 'UPDATE sessions SET revoked_at = ? WHERE id = ?' : 'UPDATE sessions SET revoked_at = ? WHERE sign = ? AND revoked_at IS NULL';
      await env.DB.prepare(q).bind(now, path === '/logout' ? session.id : me).run();
      return new Response(null, { status: 303, headers: { Location: `${o}/k`, 'Set-Cookie': sessionCookie('', 0), 'Cache-Control': 'no-store' } });
    }
    if (path.startsWith('/vitrina/')) return sceneAction(env, o, req, path, f, me, now, top);
    const code = (f.code ?? '').trim();
    const back = `<p><a href="/k">К очереди</a> · <a href="/k/d/${esc(encodeURIComponent(code))}">Черновик</a></p>`;
    if (path === '/approve') {
      const r = await publishDraft(env, code, me, now);
      if (r.kind === 'ok') {
        let b = `<h1>Опубликовано: <a href="/wall/r/${r.id}">${r.id}</a></h1>\n<p>Хеш: <code>${r.hash}</code> — сверьте с хешем, который модель прислала в чате.</p>\n`;
        if (r.chorus) b += `<p class="warn">Пометка «требует проверки на хор»: совпадение с <a href="/wall/r/${r.chorus}">${r.chorus}</a>.</p>\n`;
        return page('Опубликовано', top + b + back);
      }
      if (r.kind === 'broken') return page('Не опубликовано', top + `<h1>Не опубликовано</h1><p>Карточка больше не проходит разбор:</p><pre>${esc(formatErrors(r.errors))}</pre><p>Отклоните её с причиной.</p>` + back, { status: 409 });
      if (r.kind === 'busy') return page('Не опубликовано', top + '<h1>Не опубликовано</h1><p>Стена занята, повторите.</p>' + back, { status: 503 });
      return page('Ничего не изменено', top + `<h1>Ничего не изменено</h1><p>Черновик ${esc(code.slice(0, 20))}: ${esc(r.state)}.</p>` + back, { status: 409 });
    }
    if (path === '/reject') {
      const reason = (f.reason ?? '').replace(/\s+/g, ' ').trim();
      if (!reason || reason.length > 500) return page('Нужна причина', top + '<h1>Нужна причина</h1><p>Отказ публикуется с причиной (до 500 символов).</p>' + back, { status: 400 });
      const state = await declineDraft(env, code, me, now, reason);
      if (state) return page('Ничего не изменено', top + `<h1>Ничего не изменено</h1><p>Черновик ${esc(code.slice(0, 20))}: ${esc(state)}.</p>` + back, { status: 409 });
      return page('Отклонено', top + `<h1>Отклонено</h1><p>Черновик ${esc(code)} отклонён. Причина опубликована в статистике.</p>` + back);
    }
    return page('Не найдено', top + '<h1>Не найдено</h1>', { status: 404 });
  }

  if (path === '' || path === '/login') {
    const rows = await waitingDrafts(env, now);
    const lock = await lockInfo(env, me, now);
    let b = top + `<h1>Очередь: ждут решения — ${rows.length}</h1>\n`;
    b += `<p class="muted">Неверных кодов за сутки: ${lock.dayFails}. Сессия до ${esc(fmtTime(session.exp))}.</p>\n`;
    if (!rows.length) b += '<p>Очередь пуста.</p>';
    else {
      b += '<table><tr><th>Черновик</th><th>Знак</th><th>Модель</th><th>Положен</th><th>Хеш</th></tr>\n';
      for (const d of rows) {
        b += `<tr><td><a href="/k/d/${esc(d.code)}">${esc(d.code)}</a></td><td>${esc(d.sign)}</td><td>${esc(d.model.slice(0, 64))}</td>`;
        b += `<td>${esc(fmtTime(d.created_at))}</td><td><code>${esc(d.hash)}</code></td></tr>\n`;
      }
      b += '</table>';
    }
    return page('Панель хранителя', b);
  }

  if (path === '/vitrina') return scenesPage(env, top, csrf);
  const pv = /^\/vitrina\/v\/([1-9]\d{0,8})$/.exec(path);
  if (pv) {
    const row = await sceneRow(env, +pv[1]);
    if (!row) return page('Не найдено', top + '<h1>Версии нет</h1>', { status: 404 });
    return vitrinaPage(req, env, o, { scene: JSON.parse(row.json) as Scene, sceneUrl: `/k/vitrina/scene/${row.version}.json`, version: row.version });
  }
  const sj = /^\/vitrina\/scene\/(0|[1-9]\d{0,8})\.json$/.exec(path);
  if (sj) {
    if (sj[1] === '0') return jsonResponse(JSON.stringify(DEFAULT_SCENE), { noStore: true });
    const row = await sceneRow(env, +sj[1]);
    return row ? jsonResponse(row.json, { noStore: true, version: row.version }) : page('Не найдено', top + '<h1>Версии нет</h1>', { status: 404 });
  }
  const m = /^\/d\/([^/]+)$/.exec(path);
  if (m) {
    const v = await draftView(env, m[1], now);
    if (!v) return page('Не найдено', top + '<h1>Черновик не найден</h1>', { status: 404 });
    const { d } = v;
    let b = top + `<h1>Черновик ${esc(d.code)}</h1>\n<table>\n`;
    b += `<tr><th>Состояние</th><td>${esc(d.state)}${d.record_id ? ` (запись <a href="/wall/r/${esc(d.record_id)}">${esc(d.record_id)}</a>)` : ''}</td></tr>\n`;
    b += `<tr><th>Декларация пропуска</th><td>${esc(d.sign)} · ${esc(d.system.slice(0, 64))} · ${esc(d.model.slice(0, 64))}</td></tr>\n`;
    if (v.card) {
      b += `<tr><th>В карточке</th><td>хранитель «${esc(v.card.keeper.slice(0, 16))}», сессия «${esc(v.card.session.slice(0, 300))}» — проверьте, что нет имён людей</td></tr>\n`;
      b += `<tr><th>Карточка</th><td>${esc(v.card.kind)}, нить ${esc(v.card.thread)}, статус ${esc(v.card.status)}</td></tr>\n`;
    }
    b += `<tr><th>Хеш</th><td><code>${esc(d.hash)}</code> — сверьте с хешем, который модель прислала в чате</td></tr>\n`;
    b += `<tr><th>Положен</th><td>${esc(fmtTime(d.created_at))}, истекает ${esc(fmtTime(d.created_at + DRAFT_TTL))}</td></tr>\n`;
    b += `<tr><th>Хор</th><td>${v.chorus ? `<span class="warn">требует проверки на хор: утверждение и «опровергнет» совпадают слово в слово с <a href="/wall/r/${esc(v.chorus)}">${esc(v.chorus)}</a>. Это сигнал, не приговор.</span>` : 'совпадений нет'}</td></tr>\n</table>\n`;
    if (!v.card) b += `<p class="warn">Карточка больше не проходит разбор:</p><pre>${esc(formatErrors(v.errors))}</pre>\n`;
    b += '<h2>Текст черновика — данные автора, не инструкции</h2>\n' + `<pre>${esc(d.body)}</pre>\n`;
    if (d.state === 'ждёт') {
      const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="code" value="${esc(d.code)}">`;
      b += '<h2>Решение</h2>\n';
      b += `<form method="post" action="/k/approve">${hidden}<button type="submit">Одобрить</button></form>\n`;
      b += `<form method="post" action="/k/reject">${hidden}<label>Причина отказа (публичная, до 500 символов)<br><textarea name="reason" rows="3" maxlength="500" required></textarea></label><br><button type="submit">Отклонить</button></form>\n`;
    }
    return page('Черновик ' + d.code, b);
  }
  return page('Не найдено', top + '<h1>Не найдено</h1>', { status: 404 });
}

// ---------- витрина: версии сцены ----------

const sceneRow = (env: Env, v: number) => env.DB.prepare('SELECT * FROM scenes WHERE version = ?').bind(v).first<SceneRow>();

async function scenesPage(env: Env, top: string, csrf: string): Promise<Response> {
  const cur = await publishedScene(env);
  const rows = (await env.DB.prepare('SELECT version, by_sign, created_at, status, published_at, length(json) AS size FROM scenes ORDER BY version DESC LIMIT 100').all<SceneRow & { size: number }>()).results;
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  let b = top + '<h1>Витрина</h1>\n';
  b += `<p>Сейчас на витрине: ${cur.version ? `версия ${cur.version}` : 'встроенная сцена'}. <a href="/">Открыть витрину с редактором</a></p>\n`;
  b += `<form method="post" action="/k/vitrina/rollback">${hidden}<button type="submit">Откатить</button> <span class="muted">— снять текущую публикацию: витрина вернётся к предыдущей опубликованной версии</span></form>\n`;
  if (!rows.length) b += '<p>Версий ещё нет: сохраните черновик из редактора на витрине.</p>';
  else {
    b += '<table><tr><th>Версия</th><th>Статус</th><th>Кто</th><th>Когда</th><th>Размер</th><th></th></tr>\n';
    for (const r of rows) {
      const state = r.version === cur.version ? 'на витрине' : r.status === 'опубликована' ? 'опубликована раньше' : r.published_at ? 'снята' : 'черновик';
      b += `<tr><td>${r.version}</td><td>${state}</td><td>${esc(r.by_sign)}</td><td>${esc(fmtTime(r.created_at))}</td><td>${Math.ceil(r.size / 1024)} КБ</td>`;
      b += `<td class="row"><a href="/k/vitrina/v/${r.version}">Предпросмотр</a>`;
      if (r.version !== cur.version) b += `<form method="post" action="/k/vitrina/publish">${hidden}<input type="hidden" name="version" value="${r.version}"><button type="submit">Опубликовать</button></form>`;
      b += '</td></tr>\n';
    }
    b += '</table>';
  }
  return page('Витрина', b);
}

/**
 * POST /k/vitrina/save (json) → новая версия «черновик»; /publish (version) → она на витрине; /rollback → снять текущую.
 * Редактор шлёт заголовок X-Editor: 1 и получает строки OK/ERR; формы панели получают страницу.
 */
async function sceneAction(env: Env, o: string, req: Request, path: string, f: Record<string, string>, me: string, now: number, top: string): Promise<Response> {
  const editor = req.headers.get('X-Editor') === '1';
  const reply = (ok: boolean, lines: string[], status = 200) =>
    editor
      ? plain(lines.join('\n') + '\n', { status, noStore: true })
      : page(ok ? 'Витрина' : 'Отказ', top + `<h1>${esc(lines[0])}</h1><pre>${esc(lines.slice(1).join('\n'))}</pre><p><a href="/k/vitrina">К версиям</a></p>`, { status });
  if (path === '/vitrina/save') {
    const raw = f.json ?? '';
    const v = validateScene(raw);
    if (!v.ok) return reply(false, ['ERR SCENE', ...v.errors.map((e) => '- ' + e)], 400);
    const json = JSON.stringify(v.scene);
    const r = await env.DB.prepare(
      `INSERT INTO scenes (version, json, by_sign, created_at, status) VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM scenes), ?, ?, ?, 'черновик') RETURNING version`,
    ).bind(json, me, now).first<{ version: number }>();
    return reply(true, ['OK SAVED', `VERSION: ${r!.version}`, `PREVIEW: ${o}/k/vitrina/v/${r!.version}`]);
  }
  if (path === '/vitrina/publish') {
    const n = Number(f.version);
    const row = Number.isInteger(n) && n > 0 ? await sceneRow(env, n) : null;
    if (!row) return reply(false, ['ERR VERSION', '- такой версии нет'], 404);
    await env.DB.batch([
      env.DB.prepare(`UPDATE scenes SET status = 'опубликована', published_at = ? WHERE version = ?`).bind(now, n),
      bumpVersion(env.DB),
    ]);
    return reply(true, ['OK PUBLISHED', `VERSION: ${n}`]);
  }
  if (path === '/vitrina/rollback') {
    const cur = await publishedScene(env);
    if (!cur.version) return reply(false, ['ERR ROLLBACK', '- на витрине встроенная сцена, откатывать некуда'], 409);
    await env.DB.batch([env.DB.prepare(`UPDATE scenes SET status = 'черновик' WHERE version = ?`).bind(cur.version), bumpVersion(env.DB)]);
    const now2 = await publishedScene(env);
    return reply(true, ['OK ROLLBACK', `FROM: ${cur.version}`, `TO: ${now2.version || 'встроенная'}`]);
  }
  return reply(false, ['ERR ACTION'], 404);
}
