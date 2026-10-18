import { approve, keeperLogin, reject, review, rules, submit, submitStatus } from './post';
import { wallTest } from './test-route';
import { Env, html, keepers, md, plain, render, signOf } from './util';
import { wallGuests, wallNow, wallOpen, wallRecord, wallRefuted, wallStats, wallSystem, wallThread } from './wall';
import aboutText from './pages/about.md';
import showcase from './pages/index.html';
import llmsText from './pages/llms.txt';
import wallText from './pages/wall.md';

const ROBOTS = `User-agent: *
Allow: /
Disallow: /submit
Disallow: /review
Disallow: /approve
Disallow: /reject
Disallow: /keeper
`;

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

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return plain('Только GET.\n', { status: 405, noStore: true, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(req.url);
  const o = url.origin;
  let p: string;
  try {
    p = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
  } catch {
    return md('# Неверный адрес\n', { status: 400 });
  }

  switch (p) {
    case '/':
      return wantsText(req) ? llms(o) : html(showcase, { headers: { Vary: 'Accept' } });
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
