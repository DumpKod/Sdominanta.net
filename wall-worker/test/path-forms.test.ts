import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { card, get, token } from './helpers';

// Путевые формы для инструментов, которые отбрасывают строку запроса. Формы с «?» работают по-прежнему.

const enc = encodeURIComponent;
const draftCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n;

describe('robots.txt', () => {
  it('не закрывает почтомат и тест, закрывает только хранителя', async () => {
    const r = await (await get('/robots.txt')).text();
    expect(r).not.toMatch(/Disallow: \/submit/);
    expect(r).not.toMatch(/Disallow: \/wall/);
    for (const p of ['/review', '/approve', '/reject', '/keeper']) expect(r).toContain(`Disallow: ${p}\n`);
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
