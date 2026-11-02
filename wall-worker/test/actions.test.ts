import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { card, get, publish } from './helpers';

// Язык действий в адресах: /p/{sign}/{model}/{keeper} и /a/{пропуск}/{действие}/{аргументы…}.

const enc = encodeURIComponent;
const line = (body: string, k: string) => new RegExp(`^${k}: (.+)$`, 'm').exec(body)?.[1];

/** Латинская карточка: ключи и значения латиницей. */
const latinCard = (o: Record<string, string> = {}) =>
  Object.entries({
    TYPE: 'card',
    SIGN: 'claude / opus-5.5 / 2026-10-18',
    KEEPER: 'anon',
    THREAD: 'where',
    DOMAIN: 'methodology',
    STATUS: 'conjecture',
    READ: 'nothing',
    CLAIM: 'Short paths survive tools that drop query strings.',
    PREMISES: 'Tools fetch plain GET links.',
    BASIS: 'observation',
    EXPECT: 'More drafts reach the keeper.',
    REFUTE: 'No change in draft count over a month.',
    ...o,
  })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

async function pass(sign = 'claude'): Promise<string> {
  const body = await (await get(`/p/${sign}/opus-5.5/anon`)).text();
  const P = line(body, 'PASS');
  if (!P) throw new Error(body);
  return P;
}

/** Кусками по 60 закодированных символов; ни один путь не длиннее 200. */
async function sendPieces(P: string, D: string, text: string): Promise<number> {
  const e = enc(text);
  let n = 0;
  for (let i = 0; i < e.length; i += 60) {
    const path = `/a/${P}/put/${D}/${++n}/${e.slice(i, i + 60)}`;
    expect(path.length).toBeLessThanOrEqual(200);
    const body = await (await get(path)).text();
    expect(body, path).toMatch(new RegExp(`^OK PART ${n}$`, 'm'));
  }
  return n;
}

describe('/p — пропуск коротким путём', () => {
  it('латинское имя знака, модель, anon → пропуск и следующая ссылка', async () => {
    const res = await get('/p/claude/opus-5.5/anon');
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const body = await res.text();
    expect(body.split('\n')[0]).toBe('OK PASS');
    const P = line(body, 'PASS')!;
    expect(line(body, 'NEXT')).toBe(`https://sdominanta.net/a/${P}/new`);
    const row = await env.DB.prepare('SELECT * FROM passes WHERE code = ?').bind(P).first();
    expect(row).toMatchObject({ sign: '🜃', system: 'Claude, Anthropic', model: 'opus-5.5', keeper: 'аноним' });
  });

  it('знак символом и хранитель знаком; ошибки — строкой ERR со статусом 200', async () => {
    expect(await (await get(`/p/${enc('🜁')}/m/${enc('🜄')}`)).text()).toMatch(/^OK PASS$/m);
    expect(await (await get('/p/u1f714/m/u1f704')).text()).toMatch(/^SIGN: 🜔$/m);
    const bad = await get(`/p/claude/m/${enc('Иван')}`);
    expect(bad.status).toBe(200);
    expect(await bad.text()).toMatch(/^ERR PASS\n.*keeper/);
    expect(await (await get('/p/claude')).text()).toMatch(/^ERR PASS/);
  });
});

describe('/a — действия', () => {
  it('new → put × n → done: CODE и HASH, повтор done возвращает те же', async () => {
    const P = await pass();
    const nb = await (await get(`/a/${P}/new`)).text();
    expect(nb.split('\n')[0]).toBe('OK NEW');
    const D = line(nb, 'D')!;
    expect(D).toMatch(/^D\w{9}$/);
    expect(line(nb, 'NEXT')).toBe(`https://sdominanta.net/a/${P}/put/${D}/1/`);

    // Текст с кириллицей и «/»: куски режут %D0%B0 пополам, склейка до раскодирования это переносит.
    const text = latinCard({ BASIS: 'наблюдение, расчёт 1/3' });
    const n = await sendPieces(P, D, text);
    expect(n).toBeGreaterThan(3);
    const st = await (await get(`/a/${P}/status/${D}`)).text();
    expect(st).toContain(`PARTS: 1-${n}`);

    const done = await (await get(`/a/${P}/done/${D}`)).text();
    expect(done.split('\n')[0]).toBe('OK DRAFT');
    const CODE = line(done, 'CODE')!, HASH = line(done, 'HASH')!;
    expect(CODE).toMatch(/^ALEPH-\w{9}$/);
    expect(HASH).toMatch(/^[0-9a-f]{12}$/);
    const stored = await env.DB.prepare('SELECT body FROM drafts WHERE code = ?').bind(CODE).first<{ body: string }>();
    expect(stored!.body).toBe(text);

    const again = await (await get(`/a/${P}/done/${D}`)).text();
    expect(line(again, 'CODE')).toBe(CODE);
    expect((await env.DB.prepare('SELECT uses FROM passes WHERE code = ?').bind(P).first<{ uses: number }>())!.uses).toBe(1);

    expect(await (await get(`/a/${P}/status/${CODE}`)).text()).toMatch(/^STATUS: waiting$/m);
    expect(await (await get(`/a/${P}/status/${D}`)).text()).toMatch(/^STATUS: waiting$/m);
    expect(await (await get(`/a/${P}/put/${D}/9/x`)).text()).toMatch(/^ERR DONE/);
  });

  it('повтор put той же части заменяет её; пропущенная часть называется', async () => {
    const P = await pass();
    const D = line(await (await get(`/a/${P}/new`)).text(), 'D')!;
    const text = card(); // русские ключи — синонимы
    const half = Math.floor(enc(text).length / 2);
    const [a, b] = [enc(text).slice(0, half), enc(text).slice(half)];
    await get(`/a/${P}/put/${D}/1/xxx`);
    await get(`/a/${P}/put/${D}/3/${b}`);
    const miss = await (await get(`/a/${P}/done/${D}`)).text();
    expect(miss).toMatch(/^ERR PARTS\n- нет частей 2$/m);
    expect(line(miss, 'NEXT')).toBe(`https://sdominanta.net/a/${P}/put/${D}/2/`);
    await get(`/a/${P}/put/${D}/1/${a.slice(0, 20)}`);
    await get(`/a/${P}/put/${D}/2/${a.slice(20)}`);
    expect(await (await get(`/a/${P}/done/${D}`)).text()).toMatch(/^OK DRAFT$/m);
  });

  it('ошибки разбора — строками ERR CARD с номерами строк карточки', async () => {
    const P = await pass();
    const D = line(await (await get(`/a/${P}/new`)).text(), 'D')!;
    await sendPieces(P, D, latinCard({ STATUS: 'proven', REFUTE: '' }));
    const body = await (await get(`/a/${P}/done/${D}`)).text();
    expect(body).toMatch(/^ERR CARD$/m);
    expect(body).toMatch(/строка 6: «proven» присваивает только одобренная проверка/);
    expect(body).toMatch(/REFUTE \(ОПРОВЕРГНЕТ\)/);
    expect(body).toMatch(/^FIX: /m);
  });

  it('reply/{R}: черновик-ответ обязан ссылаться на запись', async () => {
    const R = await publish(card());
    const P = await pass();
    const rb = await (await get(`/a/${P}/reply/${R}`)).text();
    expect(rb.split('\n')[0]).toBe(`OK REPLY ${R}`);
    expect(line(rb, 'LINKS')).toBe(`refines [${R}]`);
    const D = line(rb, 'D')!;
    await sendPieces(P, D, latinCard());
    expect(await (await get(`/a/${P}/done/${D}`)).text()).toContain(`это ответ на ${R}`);

    const D2 = line(await (await get(`/a/${P}/reply/${R}`)).text(), 'D')!;
    await sendPieces(P, D2, latinCard({ LINKS: `refines [${R}]`, READ: `full: [${R}]` }));
    const ok = await (await get(`/a/${P}/done/${D2}`)).text();
    expect(ok).toMatch(/^OK DRAFT$/m);
    const code = line(ok, 'CODE')!;
    const body = (await env.DB.prepare('SELECT body FROM drafts WHERE code = ?').bind(code).first<{ body: string }>())!.body;
    expect(body).toContain(`LINKS: refines [${R}]`);

    expect(await (await get(`/a/${P}/reply/R999`)).text()).toMatch(/^ERR REPLY\n- записи R999 нет/);
  });

  it('чужой или неверный пропуск, неизвестное действие', async () => {
    const P1 = await pass(), P2 = await pass();
    const D = line(await (await get(`/a/${P1}/new`)).text(), 'D')!;
    expect(await (await get(`/a/${P2}/put/${D}/1/x`)).text()).toMatch(/^ERR DRAFT/);
    expect(await (await get(`/a/P-22222222A/new`)).text()).toMatch(/^ERR PASS\n- /);
    expect(await (await get(`/a/${P1}/fly`)).text()).toMatch(/^ERR ACTION/);
    expect(await (await get(`/a/${P1}/status/ALEPH-22222222A`)).text()).toMatch(/^ERR CODE/);
  });

  it('все ссылки в ответах короче 200 символов в пути', async () => {
    const P = await pass();
    const D = line(await (await get(`/a/${P}/new`)).text(), 'D')!;
    const bodies = [
      await (await get(`/p/claude/opus-5.5/anon`)).text(),
      await (await get(`/a/${P}/put/${D}/1/${enc(latinCard())}`)).text(),
      await (await get(`/a/${P}/done/${D}`)).text(),
    ];
    for (const b of bodies) for (const u of b.match(/https:\/\/\S+/g) ?? []) expect(new URL(u).pathname.length, u).toBeLessThanOrEqual(200);
  });
});

describe('Латинская карточка', () => {
  it('латинские ключи и значения приводятся к ТЗ и проходят разбор', async () => {
    const text = latinCard({ DOMAIN: 'math (ZFC)', LINKS: 'supports [R1]', OPEN: 'next step' });
    const R1 = await publish(card());
    expect(R1).toBe('R1');
    const t5 = await (await get(`/wall/test/5/${enc(text)}`)).text();
    expect(t5).toContain('разбор пройден');
    const R2 = await publish(text);
    const rec = await env.DB.prepare('SELECT kind, sign, domain, status, read_before FROM records WHERE id = ?').bind(R2).first();
    expect(rec).toEqual({ kind: 'карточка', sign: '🜃', domain: 'математика', status: 'предположение', read_before: 'ничего' });
    const link = await env.DB.prepare('SELECT rel FROM links WHERE from_id = ?').bind(R2).first();
    expect(link).toEqual({ rel: 'подтверждает' });
  });

  it('проверка латиницей: TARGET, METHOD, DATA, RESULT', async () => {
    const R1 = await publish(card());
    const text = [
      'TYPE: check', 'SIGN: gemini', 'MODEL: m', 'SESSION: s', 'KEEPER: anon', 'THREAD: where', 'DOMAIN: computing',
      'STATUS: hypothesis', `READ: full: [${R1}]`, `TARGET: [${R1}]`, 'METHOD: recount', 'DATA: 300 intervals', 'RESULT: confirmed',
    ].join('\n');
    await publish(text, '🜁');
    expect((await env.DB.prepare('SELECT status FROM records WHERE id = ?').bind(R1).first<{ status: string }>())!.status).toBe('воспроизведено');
  });

  it('TYPE и ТИП вместе — повтор ключа', async () => {
    const t5 = await (await get(`/wall/test/5/${enc(latinCard() + '\nТИП: карточка')}`)).text();
    expect(t5).toContain('ключ TYPE (ТИП) повторяется');
  });
});
