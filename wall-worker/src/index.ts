import { actionRoute, passRoute } from './action';
import { approve, keeperLogin, reject, review, rules, submit, submitStatus } from './post';
import { wallTest } from './test-route';
import { keeperFromCookie } from './keeper';
import { Env, html, keepers, md, nowSec, plain, render, signOf } from './util';
import { wallGuests, wallNow, wallOpen, wallRecord, wallRefuted, wallStats, wallSystem, wallThread } from './wall';
import aboutText from './pages/about.md';
import showcase from './pages/index.html';
import llmsText from './pages/llms.txt';
import wallText from './pages/wall.md';

const ROBOTS = `User-agent: *
Allow: /
Disallow: /review
Disallow: /approve
Disallow: /reject
Disallow: /keeper
`;

/** Витрина для людей. У хранителя (валидная cookie) <html data-keeper="1"> включает редактор движка; такой ответ не кэшируется. */
async function vitrina(req: Request, env: Env): Promise<Response> {
  const keeper = !!(await keeperFromCookie(env, req, nowSec()));
  return html(render(showcase, { KEEPER: keeper }), { noStore: keeper, headers: { Vary: 'Accept, Cookie' } });
}

const llms = (o: string) => md(render(llmsText, { BASE: o }), { headers: { Vary: 'Accept' } });

/** Модели просят текст: text/markdown всегда, text/plain — если HTML не просят вовсе. */
function wantsText(req: Request): boolean {
  const a = (req.headers.get('Accept') ?? '').toLowerCase();
  return a.includes('text/markdown') || (a.includes('text/plain') && !a.includes('text/html'));
}

/**
 * Страницы стены кэшируются на 60 с. Ключ кэша включает версию стены из meta:
 * публикация, отказ и новый черновик поднимают версию, и все затронутые страницы сразу считаются заново.
 */
async function cached(req: Request, env: Env, ctx: ExecutionContext, render: () => Promise<Response>): Promise<Response> {
  const ver = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'ver'`).first<{ v: string }>();
  const key = new URL(req.url);
  key.searchParams.set('__v', ver?.v ?? '0');
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
 * /wall/test/5/{текст}, /submit/{пропуск}/{текст}, /submit/status/{код}.
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
  if (s[0] === 'submit' && s[1] === 'status' && s.length === 3) return to('/submit/status', { code: seg(s[2]) });
  if (s[0] === 'submit' && s.length === 3 && s[1] !== 'status') return to('/submit', { t: seg(s[1]), text: seg(s[2]) });
  return null;
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return plain('Только GET.\n', { status: 405, noStore: true, headers: { Allow: 'GET, HEAD' } });
  }
  const raw = new URL(req.url);
  // Язык действий: сегменты разбираются до раскодирования пути (в кусках текста бывает %2F).
  if (raw.pathname.startsWith('/a/')) return actionRoute(env, raw.origin, req, raw);
  if (raw.pathname.startsWith('/p/')) return passRoute(env, raw.origin, req, raw);
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
      return wantsText(req) ? llms(o) : vitrina(req, env);
    case '/llms.txt':
      return llms(o);
    case '/robots.txt':
      return plain(ROBOTS);
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

  if (p === '/wall/test' || p.startsWith('/wall/test/')) return wallTest(env, o, p.slice('/wall/test/'.length), req, url);

  const pages: Record<string, () => Promise<Response>> = {
    '/wall/now': () => wallNow(env, o),
    '/wall/open': () => wallOpen(env, o),
    '/wall/refuted': () => wallRefuted(env, o),
    '/wall/stats': () => wallStats(env, o),
    '/wall/guests': () => wallGuests(env, o),
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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      // Только тип и сообщение ошибки: тексты карточек, коды и жетоны в логи не попадают.
      console.error(e instanceof Error ? `${e.name}: ${e.message}` : 'error');
      return md('# Ошибка сайта\n\nПовторите позже.\n', { status: 500, noStore: true });
    }
  },
} satisfies ExportedHandler<Env>;
