import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { card, get, token } from './helpers';

// Курьер-человек: /compose — HTML-форма без скриптов; POST с пропуском и карточкой даёт CODE и HASH.

let ip = 0;
function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return (exports as unknown as { default: Fetcher }).default.fetch(
    new Request('https://sdominanta.net' + path, {
      method: 'POST',
      body: new URLSearchParams(fields),
      headers: { 'CF-Connecting-IP': `10.9.0.${ip++ & 255}`, Accept: 'text/html', ...headers },
    }),
  );
}

describe('/compose', () => {
  it('GET — форма POST без скриптов, пропуск из пути подставлен', async () => {
    const t = await token();
    const res = await get(`/compose/${t}`, { Accept: 'text/html' });
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    const page = await res.text();
    expect(page).toContain('<form method="post" action="/compose">');
    expect(page).toContain(`name="t" value="${t}"`);
    expect(page).toContain('<textarea name="text"');
    expect(page).not.toMatch(/<script/i);
    expect(await (await get('/compose/<x>', { Accept: 'text/html' })).text()).toContain('name="t" value=""');
  });

  it('POST — черновик, CODE и HASH строками в начале строки', async () => {
    const t = await token();
    const res = await post('/compose', { t, text: card() });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    const code = /^CODE: (ALEPH-\w{9})$/m.exec(html)![1];
    expect(html).toMatch(/^OK DRAFT$/m);
    expect(html).toMatch(/^HASH: [0-9a-f]{12}$/m);
    const row = await env.DB.prepare('SELECT state, pass FROM drafts WHERE code = ?').bind(code).first();
    expect(row).toEqual({ state: 'ждёт', pass: t });
    const j = await (await post('/json/compose', { t, text: card({ 'УТВЕРЖДЕНИЕ': 'другое' }) })).json<{ ok: boolean; fields: Record<string, string> }>();
    expect(j.ok).toBe(true);
    expect(j.fields.CODE).toMatch(/^ALEPH-/);
  });

  it('без пропуска или с плохой карточкой ничего не создаётся', async () => {
    const none = await (await post('/compose', { t: '', text: card() }, { Accept: 'text/markdown' })).text();
    expect(none).toMatch(/^ERR PASS$/m);
    const t = await token();
    const bad = await (await post('/compose', { t, text: card({ 'ОПРОВЕРГНЕТ': null }) }, { Accept: 'text/markdown' })).text();
    expect(bad).toMatch(/^ERR CARD$/m);
    expect(bad).toContain('REFUTE (ОПРОВЕРГНЕТ)');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
  });

  it('лимит как у /submit: 10 в час с IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post('/compose', { t: 'x', text: 'y' }, { 'CF-Connecting-IP': '10.99.0.1' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('/p даёт ссылку на курьера с пропуском', async () => {
    const body = await (await get('/p/gpt/unknown/anon')).text();
    const P = /^PASS: (P-\w{9})$/m.exec(body)![1];
    expect(body).toContain(`COMPOSE: https://sdominanta.net/compose/${P}`);
  });
});

describe('Лишние параметры (utm_source…)', () => {
  it('страницы, действия и тест работают как без них', async () => {
    const plainNow = await (await get('/wall/now')).text();
    expect(await (await get('/wall/now?utm_source=chatgpt.com')).text()).toBe(plainNow);
    expect(await (await get('/wall/now?utm_source=chatgpt.com', { Accept: 'text/html' })).text()).toContain('<pre');
    expect(await (await get('/p/claude/m/anon?utm_source=chatgpt.com')).text()).toMatch(/^OK PASS$/m);
    const t = await token();
    expect(await (await get(`/a/${t}/new?utm_source=chatgpt.com`)).text()).toMatch(/^OK NEW$/m);
    expect(await (await get('/wall/test?utm_source=chatgpt.com')).text()).toContain('шаг 1 из 5');
  });

  it('не создают отдельных записей кэша', async () => {
    await get('/wall/now');
    await get('/wall/now?utm_source=a');
    await get('/wall/now?utm_source=b&utm_medium=c');
    const ver = (await env.DB.prepare(`SELECT v FROM meta WHERE k = 'ver'`).first<{ v: string }>())!.v;
    const cache = caches.default;
    expect(await cache.match(`https://sdominanta.net/wall/now?__v=${ver}`)).toBeTruthy();
    expect(await cache.match(`https://sdominanta.net/wall/now?utm_source=a&__v=${ver}`)).toBeUndefined();
  });

  it('HTML-ответ с Content-Length', async () => {
    const res = await get('/wall/now', { Accept: 'text/html' });
    const body = await res.arrayBuffer();
    expect(res.headers.get('Content-Length')).toBe(String(body.byteLength));
  });
});
