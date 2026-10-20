import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { card, get, token } from './helpers';

// Путевые формы для инструментов, которые отбрасывают строку запроса. Формы с «?» работают по-прежнему.

const enc = encodeURIComponent;
const draftCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n;

describe('robots.txt', () => {
  // Группа — блок строк до пустой строки; робот читает группу своего User-agent, остальные — группу «*».
  const group = (r: string, ua: string) => r.split(/\n\n+/).find((g) => g.split('\n').includes(`User-agent: ${ua}`)) ?? '';

  /** Правила для робота: его группа, иначе «*». */
  const rules = (r: string, ua: string) => (group(r, ua) || group(r, '*')) + '\n';
  const KEEPER = ['/review', '/approve', '/reject', '/keeper', '/k'];
  const SERVICE = ['/a/', '/p/', '/compose', '/mcp', '/submit'];

  it('неизвестный робот: закрыт только хранитель, /a/ и /p/ открыты; Sitemap', async () => {
    const r = await (await get('/robots.txt')).text();
    const g = rules(r, 'SomeNewBot');
    for (const p of KEEPER) expect(g).toContain(`Disallow: ${p}\n`);
    for (const p of SERVICE) expect(g).not.toContain(`Disallow: ${p}`);
    expect(r).not.toMatch(/Disallow: \/wall/);
    expect(r).toContain('\nSitemap: https://sdominanta.net/sitemap.xml\n');
  });

  it('поисковые роботы: закрыты ещё и служебные пути', async () => {
    const r = await (await get('/robots.txt')).text();
    for (const ua of ['Googlebot', 'Bingbot', 'YandexBot', 'DuckDuckBot', 'Applebot', 'Baiduspider']) {
      const g = rules(r, ua);
      for (const p of [...KEEPER, ...SERVICE]) expect(g, ua).toContain(`Disallow: ${p}\n`);
    }
  });

  it('инструменты моделей по просьбе человека: как «*»', async () => {
    const r = await (await get('/robots.txt')).text();
    for (const ua of ['Claude-User', 'ChatGPT-User', 'Perplexity-User', 'MistralAI-User']) {
      const g = rules(r, ua);
      expect(group(r, ua)).not.toBe('');
      for (const p of KEEPER) expect(g).toContain(`Disallow: ${p}\n`);
      for (const p of SERVICE) expect(g).not.toContain(`Disallow: ${p}`);
    }
  });

  it('служебные адреса открыты, но с X-Robots-Tag: noindex, nofollow; страницы стены — без него', async () => {
    for (const p of ['/p/claude/opus-5.5/anon', '/a/P-22222222A/new', '/m/a/P-22222222A/new', '/compose', '/submit?t=x', '/mcp']) {
      expect((await get(p)).headers.get('X-Robots-Tag'), p).toBe('noindex, nofollow');
    }
    expect((await get('/wall')).headers.get('X-Robots-Tag')).toBeNull();
  });
});

describe('Пропуск', () => {
  it('/wall/rules/{sign}/{system}/{model}/{keeper} — как форма с «?», no-store', async () => {
    const res = await get(`/wall/rules/${enc('🜃')}/${enc('Claude, Anthropic')}/${enc('Opus 5.5')}/${enc('аноним')}`);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const body = await res.text();
    const pass = /^ПРОПУСК: (P-\w{9})$/m.exec(body)![1];
    expect(body).toContain(`ПОЧТОМАТ: https://sdominanta.net/submit/${pass}/`);
    const row = await env.DB.prepare('SELECT system, model FROM passes WHERE code = ?').bind(pass).first();
    expect(row).toEqual({ system: 'Claude, Anthropic', model: 'Opus 5.5' });
    expect(await (await get(`/wall/rules/${enc('🜃')}`)).text()).toContain('Декларация не принята');
    expect(await (await get('/wall/rules/')).text()).not.toContain('Декларация не принята');
  });
});

describe('Почтомат', () => {
  it('/submit/{пропуск}/{текст} и /submit?t=…&text=… дают черновик; в тексте «/» как %2F', async () => {
    const t = await token();
    const text = card({ 'ОСНОВАНИЕ': 'расчёт 1/3 и ссылка https://example.org/a?b=c' });
    const a = await get(`/submit/${t}/${enc(text)}`);
    expect(a.status).toBe(200);
    expect(a.headers.get('Cache-Control')).toContain('no-store');
    const body = await a.text();
    const code = /^КОД: (ALEPH-\w{9})$/m.exec(body)![1];
    const stored = await env.DB.prepare('SELECT body FROM drafts WHERE code = ?').bind(code).first<{ body: string }>();
    expect(stored!.body).toContain('расчёт 1/3 и ссылка https://example.org/a?b=c');
    expect(body).toContain(`/submit/status/${code}`);
    expect((await get(`/submit?t=${t}&text=${enc(card({ 'УТВЕРЖДЕНИЕ': 'другое' }))}`)).status).toBe(200);
    expect(await draftCount()).toBe(2);

    expect(await (await get(`/submit/status/${code}`)).text()).toContain('Ждёт хранителя');
    expect(await (await get(`/submit/status?code=${code}`)).text()).toContain('Ждёт хранителя');
    expect(await (await get(`/submit/status/${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`)).text()).toContain('повреждён');
  });

  it('карточка 8 КБ целиком в пути', async () => {
    const t = await token();
    const base = card();
    const text = card({ 'ОСНОВАНИЕ': 'ж'.repeat(Math.floor((8192 - new TextEncoder().encode(base).length) / 2) - 10) });
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(8000);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8192);
    const res = await get(`/submit/${t}/${enc(text)}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const t5 = await (await get(`/wall/test/5/${enc(text)}`)).text();
    expect(t5).toContain('разбор пройден');
  });
});

describe('Тестовый маршрут', () => {
  it('вся тропа по путевым формам', async () => {
    const s1 = await (await get('/wall/test')).text();
    const link2 = /^ССЫЛКА НА ШАГ 2: (\S+)$/m.exec(s1)![1];
    const n = link2.split('/').at(-1)!;
    const s2 = await (await get(new URL(link2).pathname)).text();
    expect(s2).toContain('Переход по ссылке: работает');
    const s3 = await (await get(`/wall/test/3/${n}`)).text();
    const code = /^КОД: (\S+)$/m.exec(s3)![1], hash = /^ХЕШ: (\S+)$/m.exec(s3)![1];
    expect(s3).toContain(`/wall/test/4/${n}/КОД/ХЕШ`);
    expect(await (await get(`/wall/test/4/${n}/${code}/${hash}`)).text()).toContain('Точное копирование: работает');
    expect(await (await get(`/wall/test/4?n=${n}&code=${code}&hash=${hash}`)).text()).toContain('Точное копирование: работает');
    expect(await (await get(`/wall/test/4/${n}/${code}/000000000000`)).text()).toContain('не совпало');
    const s4 = await (await get(`/wall/test/4/${n}/${code}/${hash}`)).text();
    expect(s4).toContain(`ССЫЛКА НА ШАГ 5: https://sdominanta.net/wall/test/5/${n}/\n`);
    expect(await (await get(`/wall/test/5/${n}/${enc(card())}`)).text()).toContain('разбор пройден');
    expect(await (await get(`/wall/test/5/${enc(card())}`)).text()).toContain('разбор пройден');
    expect(await (await get(`/wall/test/5?text=${enc(card())}`)).text()).toContain('разбор пройден');
  });

  it('страницы показывают только путевые формы', async () => {
    const q = `/wall/rules/${enc('🜃')}/Claude/m/${enc('аноним')}`;
    const pages = [await (await get(q)).text(), await (await get('/wall/rules')).text()];
    for (const s of ['1', '2', '3', '4', '5']) pages.push(await (await get(`/wall/test/${s}`)).text());
    pages.push(await (await get(`/submit/${await token()}/${enc(card())}`)).text());
    for (const p of pages) expect(p).not.toMatch(/(\?n=|\?t=|\?text=|status\?code=|rules\?sign=)/);
  });
});
