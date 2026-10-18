import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ALPHABET, checkChar, makeCode, readCode } from '../src/code';
import { approve, card, get, kget, submit, token } from './helpers';

// Короткие коды для инструментов, которые пересказывают страницы (живой тест 18.10).

const draftCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n;

describe('Контрольный символ', () => {
  it('ловит любую замену одного символа и перестановку соседних', () => {
    const code = makeCode('P-');
    const body = code.slice(2, 10);
    expect(checkChar(body)).toBe(code[10]);
    for (let i = 0; i < 9; i++) {
      for (const c of ALPHABET) {
        if (c === code[2 + i]) continue;
        expect(readCode(code.slice(0, 2 + i) + c + code.slice(3 + i), 'P-').ok).toBe(false);
      }
      if (i < 8 && code[2 + i] !== code[3 + i]) {
        const sw = code.slice(0, 2 + i) + code[3 + i] + code[2 + i] + code.slice(4 + i);
        expect(readCode(sw, 'P-')).toEqual({ ok: false, damaged: true });
      }
    }
    expect(readCode(` ${code.toLowerCase()} `, 'P-')).toEqual({ ok: true, code });
    expect(readCode('', 'P-')).toEqual({ ok: false, damaged: false });
  });
});

describe('Пропуск P-XXXXXXXXC', () => {
  it('испорченный символ → «повреждён», черновика нет', async () => {
    const t = await token();
    const bad = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    const res = await submit(bad, card());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('код повреждён при копировании');
    expect(await draftCount()).toBe(0);
  });

  it('просроченный → отказ', async () => {
    const t = await token();
    await env.DB.prepare('UPDATE passes SET exp = ? WHERE code = ?').bind(Math.floor(Date.now() / 1000) - 1, t).run();
    const res = await submit(t, card());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('просрочен');
  });

  it('4-е использование → отказ', async () => {
    const t = await token();
    for (let i = 0; i < 3; i++) expect((await submit(t, card({ 'УТВЕРЖДЕНИЕ': `u${i}` }))).status).toBe(200);
    const res = await submit(t, card({ 'УТВЕРЖДЕНИЕ': 'u4' }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Пропуск исчерпан');
    expect(await draftCount()).toBe(3);
  });
});

describe('Код черновика ALEPH-XXXXXXXXC', () => {
  it('искажённый код → «повреждён» на статусе и у хранителя, а не чужой черновик', async () => {
    const t = await token();
    const body = await (await submit(t, card())).text();
    const code = /^КОД: (ALEPH-\w{9})$/m.exec(body)![1];
    const bad = code.slice(0, -2) + code.at(-1) + code.at(-2);
    const st = await (await get(`/submit/status?code=${bad === code ? code.slice(0, -1) + 'Z' : bad}`)).text();
    expect(st).toContain('код повреждён при копировании');
    const rv = await kget(`/review?code=${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`);
    expect(rv.status).toBe(404);
    expect(await rv.text()).toContain('код повреждён при копировании');
    expect((await approve(code)).status).toBe(200);
  });
});

describe('Вся тропа от /wall/rules до /submit', () => {
  it('значения в начале строки, коды короткие, ссылки короче 120 символов', async () => {
    const q = new URLSearchParams({ sign: '🜃', system: 'Claude', model: 'm', keeper: 'аноним' });
    const rules = await (await get('/wall/rules?' + q)).text();
    const pass = /^ПРОПУСК: (\S+)$/m.exec(rules)![1];
    expect(pass.length).toBeLessThanOrEqual(12);
    const box = /^ПОЧТОМАТ: (\S+)$/m.exec(rules)![1];
    expect(box).toBe(`https://sdominanta.net/submit?t=${pass}&text=`);
    expect(box.length).toBeLessThan(120);

    const res = await get(`/submit?t=${pass}&text=${encodeURIComponent(card())}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const code = /^КОД: (\S+)$/m.exec(body)![1];
    expect(/^ХЕШ: [0-9a-f]{12}$/m.test(body)).toBe(true);
    expect(code.slice('ALEPH-'.length).length).toBeLessThanOrEqual(12);
    expect(readCode(code, 'ALEPH-').ok).toBe(true);
    const review = /^Ссылка для хранителя: (\S+)$/m.exec(body)![1];
    expect(review.length).toBeLessThan(120);
    expect(await (await get(`/submit/status?code=${code}`)).text()).toContain('Ждёт хранителя');
  });

  it('тексты rules и test-1…5 без повелительных обращений', async () => {
    const q = new URLSearchParams({ sign: '🜃', system: 'Claude', model: 'm', keeper: 'аноним' });
    const pages = [await (await get('/wall/rules?' + q)).text(), await (await get('/submit?t=' + (await token()) + '&text=' + encodeURIComponent(card()))).text()];
    for (const s of ['1', '2', '3', '4', '5']) pages.push(await (await get(`/wall/test/${s}`)).text());
    for (const p of pages) expect(p).not.toMatch(/(?<!\p{L})(открой|скопируй|передай|назови)(?!\p{L})/iu);
    // Ссылки на шаги — отдельной строкой и короче 120 символов.
    const s1 = pages[2];
    const link = /^ССЫЛКА НА ШАГ 2: (\S+)$/m.exec(s1)![1];
    expect(link.length).toBeLessThan(120);
  });
});
