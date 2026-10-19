import { checkKeeper, keeperFromCookie, lockInfo, COOKIE } from './keeper';
import { declineDraft, DRAFT_TTL, draftView, publishDraft, tooMany, waitingDrafts } from './post';
import { formatErrors } from './card';
import { hit } from './rate';
import { DEFAULT_SCENE, SCENE_MAX, SPACE_RE, publishedScene, SceneRow, validateScene, Scene } from './scene';
import { bumpVersion } from './post';
import { jsonResponse, liveScene, sceneOut, spaceUrl, vitrinaPage } from './vitrina';
import { b64url, clientIp, enc, Env, fmtTime, hmacSha256, html, nowSec, plain, randomBytes, sha256hex, timingSafeEqual } from './util';
import editorJs from './pages/editor.js.txt';
import { currentTrack, hasKey, normTrackUrl, resolveTrack, Track } from './music';

// Панель хранителя /k — простой HTML без скриптов.
// Вход в два слоя, как у старых адресов: cookie ключа (__Host-keeper) → форма с 6 цифрами из аутентификатора →
// cookie сессии __Host-session (HttpOnly, Secure, SameSite=Strict, 12 ч). Сессии — в таблице sessions,
// хранится только SHA-256 от значения cookie; «Выйти» и «Выйти везде» отзывают их.
// Каждая форма несёт CSRF-токен: HMAC(TOKEN_KEY) от сессии (до входа — от cookie ключа).
// Сессия действует только вместе с cookie ключа того же хранителя: смена ключа закрывает и панель.

export const SESSION = '__Host-session';
export const SESSION_TTL = 12 * 3600;
const FORM_MAX = 4096;

// frame-ancestors 'self': разделы панели — виджеты в окнах витрины того же сайта; чужие страницы их не встроят
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'";
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
  return html(doc, { status: o.status ?? 200, noStore: true, csp: CSP, headers: { 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin', ...o.headers } });
}

/**
 * Вход хранителя на витрине (место keeper в сцене): браузер с cookie ключа, но без сессии, видит поле кода;
 * без cookie ключа — ничего (оба слоя: ключ, потом код). Форма — тот же POST /k/login, после входа — назад на витрину.
 */
export async function keeperDoor(env: Env, req: Request, now: number): Promise<{ csrf: string } | null> {
  if (!(await keeperFromCookie(env, req, now))) return null;
  return { csrf: await csrfFor(env, 'login', cookieValue(req, COOKIE) ?? '') };
}
/** Куда вернуться после входа с витрины: главная или пространство. */
const BACK_RE = /^\/(in\/[a-z0-9-]{1,32})?$/;

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
    `<div class="row"><a href="/k">Очередь</a><a href="/k/vitrina">Витрина</a><a href="/k/music">Музыка</a><span class="muted">Хранитель ${esc(sign)}</span>` +
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
      headers: { Location: o + (BACK_RE.test(f.back ?? '') ? f.back : '/k'), 'Set-Cookie': sessionCookie(token, SESSION_TTL), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
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
    if (path.startsWith('/music/')) return musicAction(env, path, f, me, now, top);
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
  if (path === '/music') return musicPage(env, top, csrf);
  const pv = /^\/vitrina\/v\/([1-9]\d{0,8})$/.exec(path);
  if (pv) {
    const row = await sceneRow(env, +pv[1]);
    if (!row) return page('Не найдено', top + '<h1>Версии нет</h1>', { status: 404 });
    return vitrinaPage(req, env, o, { scene: JSON.parse(row.json) as Scene, sceneUrl: `/k/vitrina/scene/${row.version}.json`, version: row.version, space: row.space });
  }
  // Опубликованная сцена целиком, с заметками хранителя: её берёт движок витрины, когда хранитель вошёл (редактор правит её).
  const lj = /^\/vitrina\/live\/([a-z0-9-]{1,32})\.json$/.exec(path);
  if (lj) {
    const { scene, version, exists, parent } = await liveScene(env, lj[1], true);
    if (!exists) return new Response(JSON.stringify({ error: 'NO_SPACE' }), { status: 404, headers: jsonResponse('', { noStore: true }).headers });
    return jsonResponse(sceneOut(scene, lj[1], parent), { noStore: true, version });
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
  const rows = (await env.DB.prepare('SELECT version, by_sign, created_at, status, published_at, space, length(json) AS size FROM scenes ORDER BY version DESC LIMIT 200').all<SceneRow & { size: number }>()).results;
  const spaces = [...new Set(['main', ...rows.map((r) => r.space)])];
  const cur = new Map<string, number>();
  for (const sp of spaces) cur.set(sp, (await publishedScene(env, sp)).version);
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  let b = top + '<h1>Витрина</h1>\n';
  b += '<p class="muted">Пространства: main — главная витрина, остальные — алеф-нули внутри объектов (поле inner, адрес /in/имя). Редактор сохраняет в то пространство, где вы находитесь.</p>\n';
  b += '<table><tr><th>Пространство</th><th>Сейчас</th><th></th></tr>\n';
  for (const sp of spaces) {
    const v = cur.get(sp)!;
    b += `<tr><td><a href="${spaceUrl(sp)}">${esc(sp)}</a></td><td>${v ? `версия ${v}` : sp === 'main' ? 'встроенная сцена' : 'пусто'}</td>`;
    b += `<td><form method="post" action="/k/vitrina/rollback">${hidden}<input type="hidden" name="space" value="${esc(sp)}"><button type="submit">Откатить</button></form></td></tr>\n`;
  }
  b += '</table><p class="muted">«Откатить» снимает текущую публикацию пространства: оно вернётся к предыдущей опубликованной версии.</p>\n';
  // узлы сети: черновики видит только хранитель (на витрине — с пометкой), публикует их здесь одной кнопкой
  const ns = (await env.DB.prepare(`SELECT state, count(*) AS n FROM nodes GROUP BY state`).all<{ state: string; n: number }>()).results;
  if (ns.length) {
    const cnt = (st: string) => ns.find((x) => x.state === st)?.n ?? 0;
    b += `<h2>Узлы сети</h2><p>Опубликовано: ${cnt('опубликован')} · черновиков: ${cnt('черновик')}. Корень — <a href="/in/aleph">/in/aleph</a>.</p>\n`;
    if (cnt('черновик')) b += `<form method="post" action="/k/vitrina/nodes/publish">${hidden}<button type="submit">Опубликовать черновики узлов</button></form>`;
    if (cnt('опубликован')) b += `<form method="post" action="/k/vitrina/nodes/hide">${hidden}<button type="submit">Снять узлы в черновик</button></form>`;
  }
  // документы архива: партия = папка архива; хранитель читает черновик по ссылке и публикует папку целиком
  const ds = (await env.DB.prepare(`SELECT CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE '' END AS batch, state, count(*) AS n, min(name) AS first FROM docs GROUP BY batch, state ORDER BY batch`)
    .all<{ batch: string; state: string; n: number; first: string }>()).results;
  if (ds.length) {
    b += '<h2>Документы архива</h2><p class="muted">Партия — папка архива. Черновик видит только хранитель: откройте, прочтите, потом «Опубликовать партию».</p>\n';
    b += '<table><tr><th>Партия</th><th>Черновиков</th><th>Опубликовано</th><th></th></tr>\n';
    for (const bt of [...new Set(ds.map((x) => x.batch))]) {
      const of = (st: string) => ds.find((x) => x.batch === bt && x.state === st);
      const dr = of('черновик'), pb = of('опубликован');
      const f = `${hidden}<input type="hidden" name="batch" value="${esc(bt)}">`;
      b += `<tr><td>${esc(bt || '(корень)')}</td><td>${dr?.n ?? 0}</td><td>${pb?.n ?? 0}</td><td class="row"><a href="/doc/${esc((dr ?? pb)!.first)}">Открыть первый</a>`;
      if (dr) b += `<form method="post" action="/k/vitrina/docs/publish">${f}<button type="submit">Опубликовать партию</button></form>`;
      if (pb) b += `<form method="post" action="/k/vitrina/docs/hide">${f}<button type="submit">Снять в черновик</button></form>`;
      b += '</td></tr>\n';
    }
    b += '</table>';
  }
  if (!rows.length) b += '<p>Версий ещё нет: сохраните черновик из редактора на витрине.</p>';
  else {
    b += '<table><tr><th>Версия</th><th>Пространство</th><th>Статус</th><th>Кто</th><th>Когда</th><th>Размер</th><th></th></tr>\n';
    for (const r of rows) {
      const state = r.version === cur.get(r.space) ? 'на витрине' : r.status === 'опубликована' ? 'опубликована раньше' : r.published_at ? 'снята' : 'черновик';
      b += `<tr><td>${r.version}</td><td>${esc(r.space)}</td><td>${state}</td><td>${esc(r.by_sign)}</td><td>${esc(fmtTime(r.created_at))}</td><td>${Math.ceil(r.size / 1024)} КБ</td>`;
      b += `<td class="row"><a href="/k/vitrina/v/${r.version}">Предпросмотр</a>`;
      if (r.version !== cur.get(r.space)) b += `<form method="post" action="/k/vitrina/publish">${hidden}<input type="hidden" name="version" value="${r.version}"><button type="submit">Опубликовать</button></form>`;
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
  if (path === '/vitrina/nodes/publish' || path === '/vitrina/nodes/hide') {
    const [from, to] = path.endsWith('publish') ? ['черновик', 'опубликован'] : ['опубликован', 'черновик'];
    const r = await env.DB.batch([env.DB.prepare('UPDATE nodes SET state = ? WHERE state = ?').bind(to, from), bumpVersion(env.DB)]);
    return reply(true, [`OK NODES`, `- ${to}: ${r[0].meta.changes}`]);
  }
  if (path === '/vitrina/docs/publish' || path === '/vitrina/docs/hide') {
    const [from, to] = path.endsWith('publish') ? ['черновик', 'опубликован'] : ['опубликован', 'черновик'];
    const bt = f.batch ?? '';
    const where = bt ? `substr(path, 1, length(?1) + 1) = ?1 || '/'` : `instr(path, '/') = 0 AND ?1 = ''`;
    const r = await env.DB.batch([
      env.DB.prepare(`UPDATE docs SET state = ?2, published_at = ?3 WHERE state = ?4 AND ${where}`).bind(bt, to, to === 'опубликован' ? now : null, from),
      bumpVersion(env.DB),
    ]);
    return reply(true, [`OK DOCS`, `BATCH: ${bt || '(корень)'}`, `- ${to}: ${r[0].meta.changes}`]);
  }
  if (path === '/vitrina/save') {
    const raw = f.json ?? '';
    const v = validateScene(raw);
    if (!v.ok) return reply(false, ['ERR SCENE', ...v.errors.map((e) => '- ' + e)], 400);
    const space = f.space || 'main';
    if (!SPACE_RE.test(space)) return reply(false, ['ERR SPACE', '- имя пространства: латиница, цифры, дефис, до 32'], 400);
    const json = JSON.stringify(v.scene);
    const r = await env.DB.prepare(
      `INSERT INTO scenes (version, json, by_sign, created_at, status, space) VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM scenes), ?, ?, ?, 'черновик', ?) RETURNING version`,
    ).bind(json, me, now, space).first<{ version: number }>();
    return reply(true, ['OK SAVED', `VERSION: ${r!.version}`, `SPACE: ${space}`, `PREVIEW: ${o}/k/vitrina/v/${r!.version}`]);
  }
  if (path === '/vitrina/publish') {
    const n = Number(f.version);
    const row = Number.isInteger(n) && n > 0 ? await sceneRow(env, n) : null;
    if (!row) return reply(false, ['ERR VERSION', '- такой версии нет'], 404);
    await env.DB.batch([
      env.DB.prepare(`UPDATE scenes SET status = 'опубликована', published_at = ? WHERE version = ?`).bind(now, n),
      bumpVersion(env.DB),
    ]);
    return reply(true, ['OK PUBLISHED', `VERSION: ${n}`, `SPACE: ${row.space}`]);
  }
  if (path === '/vitrina/rollback') {
    const space = f.space || 'main';
    if (!SPACE_RE.test(space)) return reply(false, ['ERR SPACE'], 400);
    const cur = await publishedScene(env, space);
    if (!cur.version) return reply(false, ['ERR ROLLBACK', `- в пространстве ${space} нет опубликованной версии, откатывать некуда`], 409);
    await env.DB.batch([env.DB.prepare(`UPDATE scenes SET status = 'черновик' WHERE version = ?`).bind(cur.version), bumpVersion(env.DB)]);
    const now2 = await publishedScene(env, space);
    return reply(true, ['OK ROLLBACK', `SPACE: ${space}`, `FROM: ${cur.version}`, `TO: ${now2.version || (space === 'main' ? 'встроенная' : 'пусто')}`]);
  }
  return reply(false, ['ERR ACTION'], 404);
}

// ---------- музыка витрины ----------

async function musicPage(env: Env, top: string, csrf: string, note = ''): Promise<Response> {
  const cur = await currentTrack(env);
  const rows = (await env.DB.prepare('SELECT * FROM tracks ORDER BY id DESC LIMIT 200').all<Track>()).results;
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  let b = top + '<h1>Музыка витрины</h1>\n';
  if (note) b += `<p class="warn">${esc(note)}</p>\n`;
  b += `<p>Сейчас на витрине: ${cur ? `«${esc(cur.title)}» — ${esc(cur.artist)}` : 'тишина'}.` +
    (cur ? ` <form method="post" action="/k/music/off" style="display:inline">${hidden}<button type="submit">Выключить музыку</button></form>` : '') + '</p>\n';
  b += `<p class="muted">Посетитель слышит трек только после своего нажатия ▶, по кругу. До нажатия к SoundCloud не уходит ни одного запроса. ` +
    (hasKey(env) ? 'Ключ API внесён: звук идёт через свой плеер, холст слышит частоты.' : '<span class="warn">Ключ API SoundCloud не внесён (Secrets SC_CLIENT_ID и SC_CLIENT_SECRET): посетителю пока доступна только ссылка на трек.</span>') + '</p>\n';
  b += `<form method="post" action="/k/music/add" class="row">${hidden}<label>Адрес трека на SoundCloud <input name="url" size="48" placeholder="https://soundcloud.com/автор/трек" required></label><button type="submit">Добавить</button></form>\n`;
  if (!rows.length) b += '<p>Треков ещё нет.</p>';
  else {
    b += '<table><tr><th>Трек</th><th>Автор</th><th></th></tr>\n';
    for (const t of rows) {
      const id = `<input type="hidden" name="id" value="${t.id}">`;
      b += `<tr><td><a href="${esc(t.url)}">${esc(t.title)}</a></td><td><a href="${esc(t.artist_url)}">${esc(t.artist)}</a></td><td class="row">`;
      b += cur?.id === t.id ? '<span>на витрине</span>' :
        `<form method="post" action="/k/music/choose">${hidden}${id}<button type="submit">Играть на витрине</button></form>` +
        `<form method="post" action="/k/music/remove">${hidden}${id}<button type="submit">Убрать</button></form>`;
      b += '</td></tr>\n';
    }
    b += '</table>';
  }
  return page('Музыка', b);
}

/** POST /k/music/add (url) · /choose (id) → трек на витрине · /off → тишина · /remove (id, не текущий). */
async function musicAction(env: Env, path: string, f: Record<string, string>, me: string, now: number, top: string): Promise<Response> {
  const back = (note: string, status = 200) => musicPage(env, top, f.csrf ?? '', note).then((r) => (status === 200 ? r : new Response(r.body, { status, headers: r.headers })));
  if (path === '/music/add') {
    const url = normTrackUrl(f.url ?? '');
    if (!url) return back('Нужен адрес трека вида https://soundcloud.com/автор/трек (не плейлист и не профиль).', 400);
    const t = await resolveTrack(url);
    if ('error' in t) return back(`Не добавлено: ${t.error}.`, 400);
    await env.DB.prepare('INSERT INTO tracks (url, sc_id, title, artist, artist_url, added_at, by_sign) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (url) DO UPDATE SET sc_id = excluded.sc_id, title = excluded.title, artist = excluded.artist, artist_url = excluded.artist_url')
      .bind(t.url, t.sc_id, t.title, t.artist, t.artist_url, now, me).run();
    return back(`Добавлено: «${t.title}» — ${t.artist}.`);
  }
  const id = Number(f.id);
  if (path === '/music/choose') {
    if (!Number.isInteger(id) || !(await env.DB.prepare('SELECT 1 AS x FROM tracks WHERE id = ?').bind(id).first())) return back('Такого трека нет.', 404);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('music', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(String(id)),
      bumpVersion(env.DB),
    ]);
    return back('Трек на витрине.');
  }
  if (path === '/music/off') {
    await env.DB.batch([env.DB.prepare(`DELETE FROM meta WHERE k = 'music'`), bumpVersion(env.DB)]);
    return back('Музыка выключена.');
  }
  if (path === '/music/remove') {
    const cur = await currentTrack(env);
    if (cur?.id === id) return back('Трек на витрине: сначала выберите другой или выключите музыку.', 409);
    await env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(id).run();
    return back('Убрано.');
  }
  return back('Нет такого действия.', 404);
}
