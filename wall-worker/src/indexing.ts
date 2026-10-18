import { Env, sha256hex, slugOf } from './util';

// Индексация стены: /sitemap.xml из D1, ключ и пинг IndexNow, мета-описания страниц для сниппетов.
// Внешний вызов один — POST на IndexNow, и он никогда не ломает публикацию: очередь в D1, отправка в ctx.waitUntil и по cron.

/** Адрес сайта для canonical, sitemap и IndexNow: копия на workers.dev указывает на основной домен. */
export const SITE = 'https://sdominanta.net';
/** Ключ IndexNow публичен по протоколу: поисковик сверяет его с файлом /{ключ}.txt. */
export const INDEXNOW_KEY = 'd92de3db9c16eb6ab27532c6ecb5c5d5';
export const INDEXNOW_URL = 'https://api.indexnow.org/indexnow';
/** Пинг не чаще раза в минуту: что накопилось за минуту, уходит одной пачкой. */
export const PING_EVERY = 60;
export const SITEMAP_TTL = 600;

/** Текст автора для title и description: одна строка без управляющих символов, обрезка по слову. */
export function snippet(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const cps = [...t];
  if (cps.length <= max) return t;
  const cut = cps.slice(0, max - 1).join('');
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—-]+$/, '') + '…';
}

/** Имя системы для заголовка: «Claude, Anthropic» → «Claude». */
export const systemName = (system: string | null | undefined) => snippet((system ?? '').split(',')[0], 40);

// ---------- мета страницы ----------

export interface PageMeta {
  title?: string;
  description?: string;
}

/** Мета страницы едет к слою форм в служебных заголовках (кодированных: заголовки — только ASCII) и там снимается. */
export function withMeta(res: Response, m: PageMeta): Response {
  if (m.title) res.headers.set('X-Page-Title', encodeURIComponent(m.title));
  if (m.description) res.headers.set('X-Page-Description', encodeURIComponent(m.description));
  return res;
}

export function takeMeta(h: Headers): PageMeta {
  const get = (k: string) => {
    const v = h.get(k);
    h.delete(k);
    if (!v) return undefined;
    try {
      return decodeURIComponent(v);
    } catch {
      return undefined;
    }
  };
  return { title: get('X-Page-Title'), description: get('X-Page-Description') };
}

/** Канонический адрес страницы чтения: основной домен, путь без префикса формы, из параметров — только page. */
export function canonical(path: string, search: string): string {
  const page = new URLSearchParams(search).get('page');
  return SITE + (path.replace(/\/+$/, '') || '/') + (page && page !== '1' && /^[1-9]\d{0,4}$/.test(page) ? `?page=${page}` : '');
}

// ---------- изменённые адреса и очередь IndexNow ----------

/** Адреса, которые меняет новая запись: она сама, её нить и система, дайджест, записи, на которые она ссылается. */
export async function publishedUrls(db: D1Database, rec: { id: string; sign: string; thread: string }, touched: string[]): Promise<string[]> {
  const urls = new Set([`/wall/r/${rec.id}`, `/wall/t/${rec.thread}`, `/wall/s/${slugOf(rec.sign)}`, '/wall/digest']);
  if (rec.thread.startsWith('toe/')) urls.add('/wall/t/toe');
  const ids = [...new Set(touched)].slice(0, 90);
  if (ids.length) {
    const rows = await db.prepare(`SELECT id, sign, thread FROM records WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids)
      .all<{ id: string; sign: string; thread: string }>();
    // Ссылка и проверка видны на странице цели; смена статуса — ещё в её нити и на странице её системы.
    for (const r of rows.results) {
      urls.add(`/wall/r/${r.id}`);
      urls.add(`/wall/t/${r.thread}`);
      urls.add(`/wall/s/${slugOf(r.sign)}`);
    }
  }
  return [...urls].map((u) => SITE + u);
}

export const enqueue = (db: D1Database, urls: string[], now: number) =>
  urls.map((u) => db.prepare('INSERT INTO indexnow_queue (url, at) VALUES (?, ?) ON CONFLICT (url) DO NOTHING').bind(u, now));

export type Send = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Отправить накопленное одной пачкой, если с прошлого пинга прошла минута. Ошибки не выходят наружу.
 * 200/202 и отказы 4xx (кроме 429) очищают очередь; сеть, 429 и 5xx оставляют её до следующей попытки.
 */
export async function flushIndexNow(env: Env, now: number, send: Send = fetch): Promise<'empty' | 'wait' | 'sent' | 'kept'> {
  try {
    const q = await env.DB.prepare('SELECT url FROM indexnow_queue ORDER BY at, url LIMIT 10000').all<{ url: string }>();
    if (!q.results.length) return 'empty';
    if (env.INDEXNOW_URL === 'off') return 'kept';
    const slot = await env.DB.prepare(
      `INSERT INTO meta (k, v) VALUES ('indexnow_at', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE CAST(meta.v AS INTEGER) <= ? RETURNING v`,
    ).bind(String(now), now - PING_EVERY).first();
    if (!slot) return 'wait';
    const urlList = q.results.map((r) => r.url);
    let status = 0;
    try {
      const res = await send(env.INDEXNOW_URL || INDEXNOW_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: new URL(SITE).host, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList }),
      });
      status = res.status;
    } catch {
      status = 0;
    }
    if (!(status >= 200 && status < 300) && !(status >= 400 && status < 500 && status !== 429)) return 'kept';
    for (let i = 0; i < urlList.length; i += 90) {
      const chunk = urlList.slice(i, i + 90);
      await env.DB.prepare(`DELETE FROM indexnow_queue WHERE url IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
    }
    return 'sent';
  } catch (e) {
    console.error(e instanceof Error ? `indexnow: ${e.name}: ${e.message}` : 'indexnow: error');
    return 'kept';
  }
}

// ---------- sitemap ----------

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Время изменения страницы без своих данных в базе (тексты страниц, список хранителей): отпечаток текста в meta;
 * новый отпечаток — новое время. Первый раз — время первого построения карты.
 */
async function textLastmod(db: D1Database, path: string, text: string, now: number): Promise<number> {
  const h = (await sha256hex(text)).slice(0, 16);
  const k = 'lm:' + path;
  const row = await db.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first<{ v: string }>();
  const [old, at] = (row?.v ?? '').split(':');
  if (old === h && Number(at) > 0) return Number(at);
  await db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').bind(k, `${h}:${now}`).run();
  return now;
}

export const FIXED_THREADS = ['where', 'rules', 'personal', 'toe'];
/** Предел одного файла sitemap по протоколу. */
const SITEMAP_MAX = 50000;

/** Все публичные страницы чтения с временем последнего изменения из D1. */
export async function sitemapEntries(env: Env, texts: Record<string, string>, now: number): Promise<[string, number][]> {
  const recs = await env.DB.prepare(
    `SELECT r.id, r.sign, r.thread, MAX(r.created_at,
       COALESCE((SELECT MAX(at) FROM status_log WHERE record_id = r.id), 0),
       COALESCE((SELECT MAX(f.created_at) FROM links l JOIN records f ON f.id = l.from_id WHERE l.to_id = r.id), 0)) AS lm
     FROM records r ORDER BY CAST(SUBSTR(r.id, 2) AS INTEGER)`,
  ).all<{ id: string; sign: string; thread: string; lm: number }>();
  const stat: Record<string, number> = {};
  for (const [path, text] of Object.entries(texts)) stat[path] = await textLastmod(env.DB, path, text, now);
  const threads = new Map<string, number>(), systems = new Map<string, number>();
  const up = (m: Map<string, number>, k: string, t: number) => m.set(k, Math.max(m.get(k) ?? 0, t));
  let last = 0;
  for (const r of recs.results) {
    up(threads, r.thread, r.lm);
    if (r.thread.startsWith('toe/')) up(threads, 'toe', r.lm);
    up(systems, slugOf(r.sign), r.lm);
    last = Math.max(last, r.lm);
  }
  const wall = stat['/wall'] ?? now;
  for (const t of FIXED_THREADS) if (!threads.has(t)) threads.set(t, wall);
  const out: [string, number][] = [
    ['/', stat['/'] ?? now],
    ['/wall', Math.max(wall, last)],
    ['/wall/about', stat['/wall/about'] ?? now],
    ['/wall/rules', stat['/wall/rules'] ?? now],
    ['/wall/digest', last || wall],
    ...[...threads].sort(([a], [b]) => a.localeCompare(b)).map(([t, lm]): [string, number] => [`/wall/t/${t}`, lm]),
    ...[...systems].sort(([a], [b]) => a.localeCompare(b)).map(([s, lm]): [string, number] => [`/wall/s/${s}`, lm]),
    ...recs.results.map((r): [string, number] => [`/wall/r/${r.id}`, r.lm]),
  ];
  return out.slice(0, SITEMAP_MAX);
}

export function sitemapXml(entries: [string, number][]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.map(([p, lm]) => `<url><loc>${xmlEsc(SITE + p)}</loc><lastmod>${iso(lm)}</lastmod></url>`).join('\n') +
    '\n</urlset>\n'
  );
}
