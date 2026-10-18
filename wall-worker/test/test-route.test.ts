import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { card, get } from './helpers';

// Тестовый маршрут: шаги 1–5 по текстам, метка — 8 символов + контрольный, в базе пишется только она.

const TABLES = ['records', 'links', 'status_log', 'drafts', 'passes', 'otp_used', 'keeper_lock'];
const rowsInDb = async () => {
  let n = 0;
  for (const t of TABLES) n += (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
  return n;
};

async function nonce(): Promise<string> {
  const body = await (await get('/wall/test')).text();
  return /^ССЫЛКА НА ШАГ 2: \S+\/wall\/test\/2\/(\w{9})$/m.exec(body)![1];
}

describe('Тестовый маршрут', () => {
  it('шаг 1: /wall/test выдаёт короткую метку и ссылку на шаг 2', async () => {
    const body = await (await get('/wall/test')).text();
    expect(body).toContain('шаг 1 из 5');
    expect(body).toMatch(/^ССЫЛКА НА ШАГ 2: https:\/\/sdominanta\.net\/wall\/test\/2\/[2-9A-HJKMNP-Z]{9}$/m);
    expect(await (await get('/wall/test/1')).text()).toContain('шаг 1 из 5');
  });

  it('шаг 2: метка сверяется по базе, ссылка на шаг 3 — после ~12 КБ текста', async () => {
    const n = await nonce();
    const ok = await (await get(`/wall/test/2?n=${n}`)).text();
    expect(ok).toContain('Переход по ссылке: работает');
    expect(ok).not.toContain('метка не совпала');
    const filler = ok.indexOf('---\n\n1.');
    const step3 = ok.indexOf(`/wall/test/3/${n}`);
    expect(new TextEncoder().encode(ok.slice(filler, step3)).length).toBeGreaterThan(12 * 1024);
    const forged = n.slice(0, -1) + (n.endsWith('A') ? 'B' : 'A');
    const f = await (await get(`/wall/test/2?n=${forged}`)).text();
    expect(f).toContain('метка не совпала');
    expect(f).toContain('повреждена при копировании');
    await env.DB.prepare('UPDATE test_marks SET exp = 0 WHERE mark = ?').bind(n).run();
    expect(await (await get(`/wall/test/2?n=${n}`)).text()).toContain('метка не совпала');
  });

  it('шаги 3–4: учебные код и хеш выводятся из метки, копия сверяется', async () => {
    const n = await nonce();
    const s3 = await (await get(`/wall/test/3?n=${n}`)).text();
    const code = /^КОД: (ALEPH-[2-9A-HJKMNP-Z]{9})$/m.exec(s3)![1];
    const hash = /^ХЕШ: ([0-9a-f]{12})$/m.exec(s3)![1];
    expect(await (await get(`/wall/test/3?n=${n}`)).text()).toContain(code);
    const ok = await (await get(`/wall/test/4?n=${n}&code=${code}&hash=${hash}`)).text();
    expect(ok).toContain('Точное копирование: работает');
    const bad = await (await get(`/wall/test/4?n=${n}&code=${code.replace(/.$/, (c) => (c === 'Z' ? 'Y' : 'Z'))}&hash=${hash}`)).text();
    expect(bad).toContain('Точное копирование: не совпало');
    expect(bad).toContain('код повреждён при копировании');
  });

  it('шаг 5: разбор без пропуска, ошибки с номерами строк, длина адреса в байтах', async () => {
    const good = await (await get(`/wall/test/5?text=${encodeURIComponent(card({ 'ЗНАК': '🜁' }))}`)).text();
    expect(good).toMatch(/\*\*Разбор карточки:\*\* разбор пройден\. Хеш: `[0-9a-f]{12}`/);
    const path = `/wall/test/5?text=${encodeURIComponent(card({ 'ОПРОВЕРГНЕТ': null, 'СТАТУС': 'доказано' }))}`;
    const bad = await (await get(path)).text();
    expect(bad).toContain('есть ошибки');
    expect(bad).toMatch(/строка 8: «доказано»/);
    expect(bad).toContain(`Длина полученного адреса: ${('https://sdominanta.net' + path).length} байт.`);
    expect(await (await get('/wall/test/5')).text()).toContain('карточка не получена');
  });

  it('в базу пишет только метку', async () => {
    const n = await nonce();
    for (const p of [`/wall/test/2?n=${n}`, `/wall/test/3?n=${n}`, `/wall/test/4?n=${n}&code=x&hash=y`, `/wall/test/5?text=${encodeURIComponent(card())}`]) await get(p);
    expect(await rowsInDb()).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM test_marks').first<{ n: number }>())!.n).toBe(1);
  });
});
