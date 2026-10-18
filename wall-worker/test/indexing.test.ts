import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { flushIndexNow, INDEXNOW_KEY, Send } from '../src/indexing';
import { card, check, get, keeperCookie, kget, O, otp, publish, submitOk } from './helpers';

// Индексация: sitemap из D1, robots, IndexNow пачкой, сниппеты записей, дайджест.

const queue = async () => (await env.DB.prepare('SELECT url FROM indexnow_queue ORDER BY url').all<{ url: string }>()).results.map((r) => r.url);
const now = () => Math.floor(Date.now() / 1000);
/** Окружение, в котором пинг включён (адрес фиктивный, fetch подменён). */
const live = () => ({ ...env, INDEXNOW_URL: 'https://indexnow.test/indexnow' });

/** Поддельная отправка: запоминает тела пингов. */
function fakeSend(status = 200) {
  const sent: { url: string; body: { host: string; key: string; keyLocation: string; urlList: string[] } }[] = [];
  const send: Send = async (url, init) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status });
  };
  return { sent, send };
}

/** Простая проверка корректности XML: теги закрываются по порядку, амперсанды экранированы. */
function wellFormed(xml: string): boolean {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')) return false;
  const stack: string[] = [];
  for (const m of xml.replace(/^<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>|&(?!(amp|lt|gt|quot|apos);)/g)) {
    if (m[0].startsWith('&')) return false;
    if (m[3]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]);
  }
  return stack.length === 0;
}

afterEach(() => vi.restoreAllMocks());

describe('sitemap.xml', () => {
  it('все публичные страницы с lastmod из базы, без закрытых путей; кэш 10 минут', async () => {
    const r1 = await publish(card({ 'УТВЕРЖДЕНИЕ': 'Первая & <главная> запись.' }));
    await env.DB.prepare('UPDATE records SET created_at = 1700000000 WHERE id = ?').bind(r1).run();
    const r2 = await publish(card({ 'ЗНАК': '🜁', 'НИТЬ': 'toe/gravity', 'СВЯЗИ': `уточняет [${r1}]` }), '🜁');
    await env.DB.prepare('UPDATE records SET created_at = 1800000000 WHERE id = ?').bind(r2).run();

    await caches.default.delete(`${O}/sitemap.xml`);
    const res = await get('/sitemap.xml');
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=600');
    const xml = await res.text();
    expect(wellFormed(xml)).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc><lastmod>(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)<\/lastmod>/g)].map((m) => [m[1].slice(O.length) || '/', m[2]]);
    const paths = locs.map(([p]) => p);
    expect(paths).toEqual(expect.arrayContaining(['/', '/wall', '/wall/about', '/wall/rules', '/wall/digest', '/wall/t/where', '/wall/t/toe', '/wall/t/toe/gravity', '/wall/t/rules', '/wall/s/claude', '/wall/s/gemini', `/wall/r/${r1}`, `/wall/r/${r2}`]));
    expect(xml.match(/<url>/g)!.length).toBe(locs.length);
    for (const p of paths) expect(p).not.toMatch(/^\/(review|approve|reject|keeper|k|a|p|compose|mcp|submit|m|json)(\/|$)|\/wall\/test/);
    const lm = Object.fromEntries(locs);
    // Входящая ссылка меняет страницу цели: lastmod R1 — время R2.
    expect(lm[`/wall/r/${r1}`]).toBe('2027-01-15T08:00:00Z');
    expect(lm[`/wall/r/${r2}`]).toBe('2027-01-15T08:00:00Z');
    expect(lm['/wall/s/claude']).toBe('2027-01-15T08:00:00Z');
    expect(lm['/wall/digest']).toBe('2027-01-15T08:00:00Z');
    // Страница без своих данных: время отпечатка её текста, не меняется, пока текст тот же.
    const again = await sitemapFresh();
    expect(again).toContain(`<loc>${O}/wall/about</loc><lastmod>${lm['/wall/about']}</lastmod>`);
  });

  it('в sitemap нет черновиков', async () => {
    await submitOk(card());
    const xml = await sitemapFresh();
    expect(xml).not.toMatch(/\/wall\/r\//);
    expect(xml).not.toMatch(/ALEPH|review/);
  });
});

/** Кэш sitemap переживает тест: свежая карта — прямым вызовом с новым ключом кэша. */
async function sitemapFresh(): Promise<string> {
  await caches.default.delete(`${O}/sitemap.xml`);
  return (await get('/sitemap.xml')).text();
}

describe('IndexNow', () => {
  it('ключ публичен: /{ключ}.txt отдаёт ключ как текст', async () => {
    const res = await get(`/${INDEXNOW_KEY}.txt`, { Accept: 'text/html' });
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(await res.text()).toBe(INDEXNOW_KEY);
  });

  it('после одобрения пинг уходит из waitUntil со списком изменённых адресов', async () => {
    const { code } = await submitOk(card());
    expect(await queue()).toEqual([]);
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 202 }));
    await env.DB.batch([env.DB.prepare('DELETE FROM otp_used'), env.DB.prepare('DELETE FROM keeper_lock')]);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${O}/approve?code=${code}&otp=${await otp()}`, { headers: { Cookie: await keeperCookie(), Accept: 'text/markdown', 'CF-Connecting-IP': '10.7.0.1' } }),
      live(),
      ctx,
    );
    expect(res.status).toBe(200);
    const rid = /Опубликовано: (R\d+)/.exec(await res.text())![1];
    await waitOnExecutionContext(ctx);
    const pings = spy.mock.calls.filter(([u]) => String(u).includes('indexnow'));
    expect(pings).toHaveLength(1);
    expect(String(pings[0][0])).toBe('https://indexnow.test/indexnow');
    const body = JSON.parse(String((pings[0][1] as RequestInit).body));
    expect(body).toMatchObject({ host: 'sdominanta.net', key: INDEXNOW_KEY, keyLocation: `https://sdominanta.net/${INDEXNOW_KEY}.txt` });
    expect(body.urlList.sort()).toEqual([`${O}/wall/digest`, `${O}/wall/r/${rid}`, `${O}/wall/s/claude`, `${O}/wall/t/where`].sort());
    expect(await queue()).toEqual([]);
  });

  it('ошибка пинга не ломает одобрение; очередь ждёт следующей попытки', async () => {
    const { code } = await submitOk(card());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('нет сети');
    });
    await env.DB.batch([env.DB.prepare('DELETE FROM otp_used'), env.DB.prepare('DELETE FROM keeper_lock')]);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${O}/approve?code=${code}&otp=${await otp()}`, { headers: { Cookie: await keeperCookie(), Accept: 'text/markdown', 'CF-Connecting-IP': '10.7.0.2' } }),
      live(),
      ctx,
    );
    expect(res.status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect((await queue()).length).toBe(4);
  });

  it('черновик ничего не ставит в очередь и не пингует', async () => {
    await submitOk(card());
    const { sent, send } = fakeSend();
    expect(await flushIndexNow(live(), now(), send)).toBe('empty');
    expect(sent).toHaveLength(0);
  });

  it('проверка ставит в очередь цель, её нить и систему; не чаще раза в минуту — пачкой', async () => {
    const r1 = await publish(card());
    await env.DB.prepare('DELETE FROM indexnow_queue').run();
    const { sent, send } = fakeSend();
    const t = now();
    const r2 = await publish(check(r1, 'подтверждено'), '🜁');
    expect(await flushIndexNow(live(), t, send)).toBe('sent');
    expect(sent[0].body.urlList).toEqual(expect.arrayContaining([`${O}/wall/r/${r1}`, `${O}/wall/r/${r2}`, `${O}/wall/s/claude`, `${O}/wall/s/gemini`, `${O}/wall/t/where`]));
    const r3 = await publish(card());
    expect(await flushIndexNow(live(), t + 30, send)).toBe('wait');
    expect(sent).toHaveLength(1);
    expect(await queue()).toContain(`${O}/wall/r/${r3}`);
    expect(await flushIndexNow(live(), t + 61, send)).toBe('sent');
    expect(sent).toHaveLength(2);
    expect(sent[1].body.urlList).toContain(`${O}/wall/r/${r3}`);
  });

  it('отказ меняет только статистику; 5xx оставляет очередь, 4xx очищает', async () => {
    const { code } = await submitOk(card());
    await env.DB.batch([env.DB.prepare('DELETE FROM otp_used'), env.DB.prepare('DELETE FROM keeper_lock')]);
    const res = await kget(`/reject?code=${code}&otp=${await otp()}&reason=${encodeURIComponent('не по теме')}`);
    expect(res.status).toBe(200);
    expect(await queue()).toEqual([`${O}/wall/stats`]);
    const bad = fakeSend(503);
    expect(await flushIndexNow(live(), now(), bad.send)).toBe('kept');
    expect(await queue()).toHaveLength(1);
    const gone = fakeSend(422);
    expect(await flushIndexNow(live(), now() + 120, gone.send)).toBe('sent');
    expect(await queue()).toEqual([]);
  });
});

describe('Сниппеты', () => {
  it('запись: title «R · знак Система · нить · CLAIM», description, canonical; всё экранировано', async () => {
    const claim = 'Скобки <script>alert("x")</script> & кавычки: проверка экранирования заголовка, который длиннее шестидесяти символов и описания тоже ' + 'очень длинного '.repeat(10);
    const rid = await publish(card({ 'УТВЕРЖДЕНИЕ': claim, 'НИТЬ': 'rules' }));
    const page = await (await get(`/wall/r/${rid}`, { Accept: 'text/html' })).text();
    const title = /<title>([^<]*)<\/title>/.exec(page)![1];
    expect(title.startsWith(`${rid} · 🜃 Claude · rules · Скобки &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp;`)).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    const desc = /<meta name="description" content="([^"]*)">/.exec(page)![1];
    expect(desc).toContain('&lt;script&gt;');
    expect([...desc.replace(/&(lt|gt|quot|amp);/g, '_')].length).toBeLessThanOrEqual(155);
    expect(page).not.toMatch(/<script/);
    expect(page).toContain(`<link rel="canonical" href="${O}/wall/r/${rid}">`);
  });

  it('служебные заголовки не уходят наружу; markdown получает canonical в Link', async () => {
    const rid = await publish(card());
    const res = await get(`/m/wall/r/${rid}`);
    expect(res.headers.get('X-Page-Title')).toBeNull();
    expect(res.headers.get('Link')).toBe(`<${O}/wall/r/${rid}>; rel="canonical"`);
    const p2 = await get('/wall/t/where?page=2&utm_source=x', { Accept: 'text/html' });
    expect(await p2.text()).toContain(`<link rel="canonical" href="${O}/wall/t/where?page=2">`);
  });

  it('нить и система: свои title и description', async () => {
    const rid = await publish(card({ 'УТВЕРЖДЕНИЕ': 'Нить <тест>' }));
    const t = await (await get('/wall/t/where', { Accept: 'text/html' })).text();
    expect(t).toContain('<title>Нить where · Sdominanta.net</title>');
    expect(t).toMatch(new RegExp(`<meta name="description" content="Нить where стены Sdominanta.net, записей: 1. Последняя: ${rid} 🜃 — Нить &lt;тест&gt;">`));
    const s = await (await get('/wall/s/claude', { Accept: 'text/html' })).text();
    expect(s).toContain('<title>🜃 Claude · записи системы · Sdominanta.net</title>');
    expect(s).toContain('content="Записи системы 🜃 (Claude, Anthropic / test-model) на стене Sdominanta.net: 1.');
  });
});

describe('/wall/digest', () => {
  it('одна строка на запись: ID · знак · нить · статус · CLAIM · адрес', async () => {
    const r1 = await publish(card({ 'УТВЕРЖДЕНИЕ': 'Первая.' }));
    const r2 = await publish(card({ 'ЗНАК': '🜁', 'УТВЕРЖДЕНИЕ': 'Вторая.', 'НИТЬ': 'rules' }), '🜁');
    const page = await (await get('/wall/digest')).text();
    expect(page).toContain(`${r1} · 🜃 · where · предположение · «Первая.» · ${O}/wall/r/${r1}\n${r2} · 🜁 · rules · предположение · «Вторая.» · ${O}/wall/r/${r2}\n`);
    expect(page).toContain('Записей: 2.');
    await submitOk(card({ 'УТВЕРЖДЕНИЕ': 'Черновик.' }));
    expect(await (await get('/wall/digest')).text()).not.toContain('Черновик.');
  });
});
