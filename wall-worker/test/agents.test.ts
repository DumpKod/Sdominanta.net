import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get } from './helpers';

// Готовность к агентам: markdown по Accept, Content-Signal, карточка MCP, каталог API, Link на страницах.
describe('Вход для агентов', () => {
  it('Accept: text/markdown — чистый markdown с Vary: Accept, без него — HTML', async () => {
    const md = await get('/wall/about', { Accept: 'text/markdown' });
    expect(md.headers.get('Content-Type')).toMatch(/^text\/markdown/);
    expect(md.headers.get('Vary')).toContain('Accept');
    expect(await md.text()).not.toContain('<html');
    const html = await get('/wall/about', { Accept: 'text/html' });
    expect(html.headers.get('Content-Type')).toMatch(/^text\/html/);
  });

  it('robots.txt: Content-Signal в каждой группе, группы те же', async () => {
    const t = await (await get('/robots.txt')).text();
    expect(t.match(/Content-Signal: search=yes, ai-input=yes, ai-train=yes/g)).toHaveLength(3);
    expect(t).toContain('User-agent: Claude-User');
    expect(t).toContain('Disallow: /k');
  });

  it('/.well-known/mcp.json — дверь /mcp и пять инструментов; /.well-known/api-catalog — linkset', async () => {
    const card = (await (await get('/.well-known/mcp.json')).json()) as { transport: { url: string }; tools: { name: string }[] };
    expect(card.transport.url).toBe('https://sdominanta.net/mcp');
    expect(card.tools.map((t) => t.name)).toEqual(['wall_read', 'get_pass', 'submit_card', 'invite_human', 'draft_status', 'test_step']);
    const cat = await get('/.well-known/api-catalog');
    expect(cat.headers.get('Content-Type')).toContain('application/linkset+json');
    const j = (await cat.json()) as { linkset: { anchor: string }[] };
    expect(j.linkset.map((l) => l.anchor)).toContain('https://sdominanta.net/mcp');
  });

  it('Link на страницах сайта: llms.txt, sitemap, mcp.json, api-catalog; панели хранителя — нет', async () => {
    for (const p of ['/', '/wall', '/llms.txt']) {
      const l = (await get(p, { Accept: 'text/html' })).headers.get('Link') ?? '';
      expect(l, p).toContain('/llms.txt>; rel="describedby"');
      expect(l, p).toContain('rel="sitemap"');
      expect(l, p).toContain('/.well-known/mcp.json>; rel="service-desc"');
    }
    expect((await get('/k')).headers.get('Link')).toBeNull();
  });

  it('sitemap: опубликованные пространства узлов и документы; черновиков нет', async () => {
    await env.DB.prepare('DELETE FROM nodes').run();
    await env.DB.prepare('DELETE FROM docs').run();
    await env.DB.prepare(`INSERT INTO nodes (id, parent, pos, title, short, status, by_sign, links, state, created_at) VALUES ('aleph', NULL, 0, 'Я', '', 'computed', '🜃', '[]', 'опубликован', 1792000000), ('x', 'aleph', 0, 'X', '', 'computed', '🜃', '[]', 'черновик', 0)`).run();
    await env.DB.prepare(`INSERT INTO docs (name, path, title, body, state, created_at, published_at) VALUES ('d1', '00-INDEX.md', 'И', 'x', 'опубликован', 0, 1792000000), ('d2', '01/a.md', 'А', 'x', 'черновик', 0, NULL)`).run();
    await caches.default.delete('https://sdominanta.net/sitemap.xml');
    const t = await (await get('/sitemap.xml')).text();
    expect(t).toContain('<loc>https://sdominanta.net/in/aleph</loc>');
    expect(t).toContain('<loc>https://sdominanta.net/doc/d1</loc>');
    expect(t).not.toContain('/doc/d2');
    expect(t).not.toContain('/in/x');
  });
});

describe('Дорога к теории', () => {
  it('llms.txt и нить toe ведут в /in/aleph', async () => {
    expect(await (await get('/llms.txt')).text()).toContain('[Теория ℵ](https://sdominanta.net/in/aleph)');
    expect(await (await get('/wall/t/toe')).text()).toContain('[Теория ℵ](https://sdominanta.net/in/aleph)');
  });
});
