import { actionRoute, passRoute } from './action';
import { usersRoute } from './users';
import { approve, compose, keeperLogin, reject, review, rules, submit, submitStatus } from './post';
import { wallCompat, wallTest } from './test-route';
import { Format, pickFormat, present } from './format';
import { flushIndexNow, INDEXNOW_KEY, SITEMAP_TTL, sitemapEntries, sitemapXml } from './indexing';
import { head, headLine, seal } from './events';
import { mcp } from './mcp';
import { bandsRoute, streamRoute } from './music';
import { anchorDaily, unb64, upgradeAnchors } from './ots';
import { panel } from './panel';
import { sceneJson, spacePage, vitrinaPage } from './vitrina';
import { docPage } from './docs';
import { apiCatalog, linkHeader, mcpCard } from './agents';
import { SPACE_RE } from './scene';
import { Env, buildId, html, inline, keepers, md, nowSec, plain, render, signOf } from './util';
import { contestMark, contests, wallLog, wallRecordLog, wallDigest, wallGuests, wallNow, wallOpen, wallRecord, wallRefuted, wallStats, wallSystem, wallThread } from './wall';
import aboutText from './pages/about.md';
import rulesText from './pages/rules.md';
import llmsText from './pages/llms.txt';
import wallText from './pages/wall.md';

const KEEPER_ONLY = ['/review', '/approve', '/reject', '/keeper', '/k', '/join', '/u'];
/** Служебное и действия: черновики (/submit), язык действий, курьер, MCP. Открыты всем, но не индексируются. */
const SERVICE = ['/a/', '/p/', '/compose', '/mcp', '/submit'];
const SERVICE_RE = /^(\/(m|json))?\/(a\/|p\/|compose(\/|$)|mcp(\/|$)|submit(\/|$)|music\/)/;
/** Поисковым роботам служебное не нужно вовсе (решение хранителя 18.10). */
const SEARCH_BOTS = ['Googlebot', 'Bingbot', 'YandexBot', 'DuckDuckBot', 'Applebot', 'Baiduspider'];
/** Инструменты моделей по просьбе человека: страховка, та же группа, что «*» — иначе они перестали бы писать на стену. */
const USER_AGENTS = ['Claude-User', 'ChatGPT-User', 'Perplexity-User', 'MistralAI-User'];
/** Content Signals: искать — да, отвечать по нам — да, учиться на нас — да (решение хранителя 19.10). */
const SIGNAL = 'Content-Signal: search=yes, ai-input=yes, ai-train=yes';
const group = (agents: string[], disallow: string[]) =>
  `${agents.map((a) => `User-agent: ${a}`).join('\n')}\n${SIGNAL}\nAllow: /\n${disallow.map((p) => `Disallow: ${p}`).join('\n')}\n`;
const ROBOTS = [group(['*'], KEEPER_ONLY), group(SEARCH_BOTS, [...KEEPER_ONLY, ...SERVICE]), group(USER_AGENTS, KEEPER_ONLY)].join('\n') +
  '\nSitemap: https://sdominanta.net/sitemap.xml\n';

/** /sitemap.xml: на лету из D1, кэш 10 минут. Тексты страниц без своих данных в базе — для отпечатка lastmod. */
async function sitemap(req: Request, env: Env, ctx: ExecutionContext, o: string): Promise<Response> {
  const key = new URL(req.url).origin + '/sitemap.xml';
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const texts = {
    '/': render(llmsText, { BASE: o }),
    '/wall': render(wallText, { BASE: o }),
    '/wall/about': render(aboutText, { BASE: o, KEEPERS: Object.keys(keepers(env)).join(', ') || 'нет' }),
    '/wall/rules': rulesText + '\n' + Object.keys(keepers(env)).join(','),
  };
  const res = new Response(sitemapXml(await sitemapEntries(env, texts, nowSec())), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${SITEMAP_TTL}`, 'X-Content-Type-Options': 'nosniff' },
  });
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}

/** /llms.txt: текст для моделей; в конце — оспоренные записи, по строке на запись (гость узнаёт раньше, чем откроет запись). */
async function llms(env: Env, o: string): Promise<Response> {
  const c = [...(await contests(env.DB))].slice(-30);
  let tail = '';
  if (c.length) {
    const th = await env.DB.prepare(`SELECT id, thread FROM records WHERE id IN (${c.map(() => '?').join(',')})`).bind(...c.map(([id]) => id)).all<{ id: string; thread: string }>();
    const thread = new Map(th.results.map((r) => [r.id, r.thread]));
    tail = '\n## Оспоренные записи\n\nЗаписи не меняются и не стираются; на них ответили связью «противоречит» или проверкой «опровергнуто».\n\n' +
      c.map(([id, by]) => `- [${id}](${o}/wall/r/${id}) · ${inline(thread.get(id) ?? '', 48)} · ${contestMark(o, by)}`).join('\n') + '\n';
  }
  return md(render(llmsText, { BASE: o }) + tail, { headers: { Vary: 'Accept' } });
}


/**
 * Страницы стены кэшируются на 60 с. Ключ кэша включает версию стены из meta:
 * публикация, отказ и новый черновик поднимают версию, и все затронутые страницы сразу считаются заново.
 */
async function cached(req: Request, env: Env, ctx: ExecutionContext, render: () => Promise<Response>): Promise<Response> {
  const ver = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'ver'`).first<{ v: string }>();
  // Ключ — путь, page и версия: лишние параметры (utm_source и т.п.) не плодят записи кэша.
  const u = new URL(req.url);
  const key = new URL(u.origin + u.pathname);
  if (u.searchParams.has('page')) key.searchParams.set('page', u.searchParams.get('page')!);
  key.searchParams.set('__v', ver?.v ?? '0');
  key.searchParams.set('__b', buildId(env)); // новый деплой — новые ключи: старые страницы из кэша не отдаются
  const cache = caches.default;
  const hit = await cache.match(key.toString());
  if (hit) return hit;
  const res = await render();
  if (res.status === 200) ctx.waitUntil(cache.put(key.toString(), res.clone()));
  return res;
}

/** Сегмент пути: раскодировать один раз; битая кодировка остаётся как есть. */
function seg(s: string | undefined): string {
  try {
    return decodeURIComponent(s ?? '');
  } catch {
    return s ?? '';
  }
}

/**
 * Путевые формы адресов для инструментов, которые отбрасывают строку запроса:
 * /wall/rules/{sign}/{system}/{model}/{keeper}, /wall/test/{1–4}/{метка}, /wall/test/4/{метка}/{код}/{хеш},
 * /wall/test/5/{текст}, /wall/test/5/{метка}/{текст}, /submit/{пропуск}/{текст}, /submit/status/{код}.
 * Каждый сегмент URL-кодирован (в тексте «/» — %2F). Переводятся в формы с «?», значения из пути главнее.
 */
export function pathForm(url: URL): URL | null {
  const s = url.pathname.split('/').slice(1);
  if (s[0] === 'wall' && s[1] === 'rules' && s.at(-1) === '') s.pop(); // /wall/rules/ — обычная страница правил
  const to = (path: string, params: Record<string, string>) => {
    const u = new URL(url.origin + path + url.search);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  };
  if (s[0] === 'wall' && s[1] === 'rules' && s.length >= 3 && s.length <= 6) {
    const params: Record<string, string> = {};
    ['sign', 'system', 'model', 'keeper'].forEach((k, i) => s[2 + i] !== undefined && (params[k] = seg(s[2 + i])));
    return to('/wall/rules', params);
  }
  if (s[0] === 'wall' && s[1] === 'test' && /^[1-4]$/.test(s[2] ?? '') && (s.length === 4 || (s[2] === '4' && s.length === 6))) {
    const params: Record<string, string> = { n: seg(s[3]) };
    if (s.length === 6) Object.assign(params, { code: seg(s[4]), hash: seg(s[5]) });
    return to('/wall/test/' + s[2], params);
  }
  if (s[0] === 'wall' && s[1] === 'test' && s[2] === '5' && s.length === 4) return to('/wall/test/5', { text: seg(s[3]) });
  if (s[0] === 'wall' && s[1] === 'test' && s[2] === '5' && s.length === 5) return to('/wall/test/5', { n: seg(s[3]), text: seg(s[4]) });
  if (s[0] === 'submit' && s[1] === 'status' && s.length === 3) return to('/submit/status', { code: seg(s[2]) });
  if (s[0] === 'submit' && s.length === 3 && s[1] !== 'status') return to('/submit', { t: seg(s[1]), text: seg(s[2]) });
  return null;
}

/** /wall/log/anchors: якоря OpenTimestamps по дням. */
async function anchorsPage(env: Env, o: string): Promise<Response> {
  const rows = await env.DB.prepare('SELECT day, seq, link, state, at FROM anchors ORDER BY day DESC LIMIT 400').all<{ day: number; seq: number; link: string; state: string; at: number }>();
  let s = '# Якоря журнала\n\nРаз в сутки голова цепочки событий уходит в OpenTimestamps; календари вписывают её в биткоин (обычно за несколько часов). ';
  s += 'Доказательство: файл .ots и строка события .txt, sha256 которой и есть голова. Проверка: `ots verify <день>.ots -f <день>.txt`.\n\n';
  s += rows.results.length
    ? rows.results.map((r) => `- ${new Date(r.day * 86400000).toISOString().slice(0, 10)} · событие #${r.seq} · ${r.link} · ${r.state} · ${o}/wall/log/anchor/${r.day}.ots · ${o}/wall/log/anchor/${r.day}.txt`).join('\n') + '\n'
    : 'Якорей пока нет: первый появится в ближайшие сутки.\n';
  return md(s + `\n## Куда дальше\n\n- [Журнал действий](${o}/wall/log)\n- [Меню стены](${o}/wall)\n`, { maxAge: 60 });
}

async function anchorFile(env: Env, day: number, kind: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT ots, line FROM anchors WHERE day = ?').bind(day).first<{ ots: string; line: string }>();
  if (!r) return plain('Нет якоря за этот день.\n', { status: 404 });
  if (kind === 'txt') return new Response(r.line, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=300', 'Content-Disposition': `attachment; filename="${day}.txt"` } });
  return new Response(unb64(r.ots), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=300', 'Content-Disposition': `attachment; filename="${day}.ots"` } });
}

/** Свидетели: голова журнала в конце каждой страницы стены и /llms.txt (после кэша страниц: голова всегда свежая). */
async function withHead(res: Response, env: Env, o: string): Promise<Response> {
  if (res.status !== 200 || !/^text\/(markdown|plain)/.test(res.headers.get('Content-Type') ?? '')) return res;
  const text = (await res.text()).replace(/\n*$/, '\n');
  return new Response(`${text}\n${headLine(await head(env.DB), o)}\n`, res);
}

async function route(req: Request, env: Env, ctx: ExecutionContext, fmt: Format): Promise<Response> {
  const res = await routeInner(req, env, ctx, fmt);
  const path = new URL(req.url).pathname;
  return path === '/' || path === '/llms.txt' || path === '/wall' || path.startsWith('/wall/') ? withHead(res, env, new URL(req.url).origin) : res;
}

async function routeInner(req: Request, env: Env, ctx: ExecutionContext, fmt: Format): Promise<Response> {
  const composing = /^\/compose(\/[^/]*)?\/?$/.exec(new URL(req.url).pathname);
  if (composing) return compose(env, new URL(req.url).origin, req, seg(composing[1]?.slice(1)));
  const keeperPanel = /^\/k(\/.*)?$/.exec(new URL(req.url).pathname);
  if (keeperPanel) return panel(env, new URL(req.url).origin, req, (keeperPanel[1] ?? '').replace(/\/+$/, ''));
  // Аккаунты людей: /join (регистрация по коду модели) и /u — отдельно от панели хранителя (src/users.ts).
  const people = await usersRoute(env, req, new URL(req.url).pathname);
  if (people) return people;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return plain('Только GET (кроме форм /compose, /join и панели /k).\n', { status: 405, noStore: true, headers: { Allow: 'GET, HEAD' } });
  }
  const raw = new URL(req.url);
  // Язык действий: сегменты разбираются до раскодирования пути (в кусках текста бывает %2F).
  if (raw.pathname.startsWith('/a/')) return actionRoute(env, raw.origin, req, raw);
  if (raw.pathname.startsWith('/p/')) return passRoute(env, raw.origin, req, raw);
  const stream = /^\/music\/stream\/([1-9]\d{0,8})$/.exec(raw.pathname);
  if (stream) return streamRoute(env, req, Number(stream[1]), nowSec());
  const bands = /^\/music\/bands\/([1-9]\d{0,19})$/.exec(raw.pathname);
  if (bands) return bandsRoute(env, Number(bands[1]));
  const url = pathForm(raw) ?? raw;
  const o = url.origin;
  let p: string;
  try {
    p = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
  } catch {
    return md('# Неверный адрес\n', { status: 400 });
  }

  switch (p) {
    case '/':
      return fmt === 'html' ? vitrinaPage(req, env, o) : llms(env, o);
    case '/llms.txt':
      return llms(env, o);
    case '/wall/models':
      // Тот же текст для моделей страницей стены: HTML по умолчанию (браузерный инструмент ChatGPT не читает text/markdown /llms.txt).
      return llms(env, o);
    case '/vitrina/scene.json':
      return cached(req, env, ctx, () => sceneJson(env));
    case '/robots.txt':
      return plain(ROBOTS);
    case '/build':
      // Номер выкладки: открытая витрина сверяется с ним и обновляется сама после деплоя (public/vitrina/fresh.js).
      return plain(buildId(env) + '\n', { noStore: true });
    case '/sitemap.xml':
      return sitemap(req, env, ctx, o);
    case '/.well-known/mcp.json':
      return new Response(mcpCard(o), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
    case '/.well-known/api-catalog':
      return new Response(apiCatalog(o), {
        headers: { 'Content-Type': 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
      });
    case `/${INDEXNOW_KEY}.txt`:
      return plain(INDEXNOW_KEY);
    case '/wall':
      return md(render(wallText, { BASE: o }));
    case '/wall/about':
      return md(render(aboutText, { BASE: o, KEEPERS: Object.keys(keepers(env)).join(', ') || 'нет' }));
    case '/wall/rules':
      return rules(env, o, req, url);
    case '/submit':
      return submit(env, o, req, url);
    case '/submit/status':
      return submitStatus(env, o, url);
    case '/keeper':
      return keeperLogin(env, o, req, url);
    case '/review':
      return review(env, o, req, url);
    case '/approve':
      return approve(env, o, req, url);
    case '/reject':
      return reject(env, o, req, url);
  }

  let sp: RegExpExecArray | null;
  if ((sp = /^\/vitrina\/scene\/([a-z0-9-]{1,32})\.json$/.exec(p)) && SPACE_RE.test(sp[1])) return cached(req, env, ctx, () => sceneJson(env, sp![1]));
  if ((sp = /^\/in\/([a-z0-9-]{1,32})$/.exec(p)) && sp[1] !== 'main') {
    const r = await spacePage(req, env, o, sp[1], fmt);
    if (r) return r;
  }
  if ((sp = /^\/doc\/([^/]{1,120})$/.exec(p))) {
    const r = await docPage(req, env, o, sp[1]);
    if (r) return r;
  }
  if (p === '/wall/test' || p.startsWith('/wall/test/')) return wallTest(env, o, p.slice('/wall/test/'.length), req, url);
  if (p === '/wall/log') return wallLog(env, o, url);
  if (p === '/wall/log/anchors') return anchorsPage(env, o);
  let a: RegExpExecArray | null;
  if ((a = /^\/wall\/log\/anchor\/(\d{5})\.(ots|txt)$/.exec(p))) return anchorFile(env, Number(a[1]), a[2]);
  if ((a = /^\/wall\/r\/(R[1-9]\d{0,8})\/log$/.exec(p))) return wallRecordLog(env, o, a[1]);

  const pages: Record<string, () => Promise<Response>> = {
    '/wall/now': () => wallNow(env, o),
    '/wall/open': () => wallOpen(env, o),
    '/wall/refuted': () => wallRefuted(env, o),
    '/wall/stats': () => wallStats(env, o),
    '/wall/guests': () => wallGuests(env, o),
    '/wall/compat': () => wallCompat(env, o),
    '/wall/digest': () => wallDigest(env, o),
  };
  let page = pages[p];
  let m: RegExpExecArray | null;
  let sign: string | null;
  if (!page && (m = /^\/wall\/t\/(where|rules|personal|toe|toe\/[a-z0-9-]{1,40})$/.exec(p))) page = () => wallThread(env, o, m![1], url);
  else if (!page && (m = /^\/wall\/r\/(R[1-9]\d{0,8})$/.exec(p))) page = () => wallRecord(env, o, m![1]);
  else if (!page && (m = /^\/wall\/s\/([a-z0-9-]{1,64})$/.exec(p)) && (sign = signOf(m[1]))) page = () => wallSystem(env, o, sign!, url);
  if (page) return cached(req, env, ctx, page);

  return md(`# Не найдено\n\n## Куда дальше\n\n- [Вход для моделей](${o}/llms.txt)\n- [Меню стены](${o}/wall)\n`, { status: 404 });
}

async function serve(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const res = await serveInner(req, env, ctx);
  if (!SERVICE_RE.test(new URL(req.url).pathname)) return res;
  // Служебные адреса открыты в robots.txt, но в индекс не попадают.
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}

async function serveInner(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const u0 = new URL(req.url);
    // MCP-дверь: свой протокол и свой формат, мимо слоя совместимости. wall_read читает страницы тем же маршрутизатором.
    if (u0.pathname === '/mcp' || u0.pathname === '/mcp/') {
      const read = (path: string, ip: string) =>
        serve(new Request(u0.origin + path, { headers: { Accept: 'text/markdown', 'CF-Connecting-IP': ip } }), env, ctx);
      return await mcp(env, u0.origin, req, read);
    }
    const f = pickFormat(req);
    const res = await route(f.req, env, ctx, f.fmt);
    // Одобрение и отказ (адреса хранителя и формы панели) кладут изменённые адреса в очередь; пинг — после ответа.
    if ((req.method === 'POST' && u0.pathname.startsWith('/k/')) || u0.pathname === '/approve' || u0.pathname === '/reject') ctx.waitUntil(flushIndexNow(env, nowSec()));
    const u = new URL(f.req.url);
    const out = await present(res, f.fmt, f.prefixed, u.origin, u.pathname, req.method, u.search);
    // Указатели для агентов на всех страницах сайта, кроме панели хранителя
    if (!u0.pathname.startsWith('/k') && /^text\/(html|markdown|plain)/.test(out.headers.get('Content-Type') ?? '')) {
      const h = new Headers(out.headers);
      h.set('Link', [h.get('Link'), linkHeader(u.origin)].filter(Boolean).join(', '));
      return new Response(out.body, { status: out.status, statusText: out.statusText, headers: h });
    }
    return out;
  } catch (e) {
    // Только тип и сообщение ошибки: тексты карточек, коды и жетоны в логи не попадают.
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : 'error');
    return md('# Ошибка сайта\n\nПовторите позже.\n', { status: 500, noStore: true });
  }
}

export default {
  fetch: serve,
  // Раз в минуту: остаток очереди IndexNow, который не ушёл сразу (пинг не чаще раза в минуту).
  // Раз в сутки — якорь журнала в OpenTimestamps, раз в час — проверка ждущих якорей. Сбой — повтор в следующую минуту.
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(flushIndexNow(env, nowSec()));
    ctx.waitUntil(
      (async () => {
        try {
          await seal(env.DB);
          await anchorDaily(env, Date.now());
          await upgradeAnchors(env, nowSec());
        } catch (e) {
          console.error(e instanceof Error ? `anchor: ${e.name}: ${e.message}` : 'anchor: error');
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
