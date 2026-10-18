import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { EventRow, GENESIS, head, lineOf, seal, verify } from '../src/events';
import { anchorDaily, Fetcher as Send, fromHex, otsFile, parseOtsFile, Stamp, unb64, upgradeAnchors } from '../src/ots';
import { sha256hex } from '../src/util';
import mig10 from '../migrations/0010-events.sql?raw';
import { approve, card, get, kget, otp, publish, submitOk } from './helpers';

// Журнал действий: события в транзакции действия, цепочка хешей, хронология записи, свидетели, якорь OpenTimestamps.

const enc = encodeURIComponent;
const line = (body: string, k: string) => new RegExp(`^${k}: (.+)$`, 'm').exec(body)?.[1];
const events = async () => {
  await seal(env.DB);
  return (await env.DB.prepare('SELECT * FROM events ORDER BY seq').all<EventRow>()).results;
};

async function viaActions(): Promise<{ P: string; code: string; rid: string }> {
  const P = line(await (await get('/p/claude/opus-5.5/anon')).text(), 'PASS')!;
  const D = line(await (await get(`/a/${P}/new`)).text(), 'D')!;
  const text = card({ 'МОДЕЛЬ': 'opus-5.5' });
  const e = enc(text);
  await get(`/a/${P}/put/${D}/1/${e.slice(0, 120)}`);
  await get(`/a/${P}/put/${D}/2/${e.slice(120)}`);
  const done = await (await get(`/a/${P}/done/${D}`)).text();
  const code = line(done, 'CODE')!;
  const res = await approve(code);
  const rid = /Опубликовано: (R\d+)/.exec(await res.text())![1];
  return { P, code, rid };
}

describe('Журнал действий', () => {
  it('путь записи по адресам: pass → draft_new → put → done → approve, цепочка сходится от нуля', async () => {
    const { P, code, rid } = await viaActions();
    const ev = await events();
    expect(ev.map((e) => e.action)).toEqual(['pass', 'draft_new', 'put', 'put', 'done', 'approve']);
    expect(ev.map((e) => e.actor)).toEqual(['🜃', '🜃', '🜃', '🜃', '🜃', '🜄']);
    expect(ev[4].object).toBe(code);
    expect(ev[5].object).toBe(rid);
    expect(ev[0].object).toMatch(/^P:[0-9a-f]{12}$/);
    expect(ev.every((e) => e.restored === 0 && e.ts_ms > 1.7e12)).toBe(true);
    expect(await verify(ev, GENESIS)).toEqual({ ok: true });
    const rec = await env.DB.prepare('SELECT event_seq FROM records WHERE id = ?').bind(rid).first<{ event_seq: number }>();
    expect(rec!.event_seq).toBe(ev[5].seq);
    // Код пропуска — пароль: в открытом журнале его нет.
    const log = await (await get('/wall/log')).text();
    expect(log).not.toContain(P);
    expect(log).toContain(ev[0].object);
    expect(log).toContain(`#${ev[5].seq} · `);
    expect(log).toContain(ev[5].link!);
  });

  it('/wall/r/R…/log — хронология записи по порядку; страница записи ссылается на событие approve', async () => {
    const { rid } = await viaActions();
    const page = await (await get(`/wall/r/${rid}/log`)).text();
    const actions = [...page.matchAll(/^#\d+ · \S+ · (\w+) · /gm)].map((m) => m[1]);
    expect(actions).toEqual(['pass', 'draft_new', 'put', 'put', 'done', 'approve']);
    const ev = await events();
    expect(await (await get(`/wall/r/${rid}`)).text()).toContain(`Событие публикации в журнале: #${ev.at(-1)!.seq}`);
  });

  it('свидетели: голова на страницах стены, в llms.txt и в ответе done', async () => {
    const { P } = await viaActions();
    const h = (await head(env.DB))!;
    for (const p of ['/wall', '/llms.txt', '/wall/now', '/wall/rules']) {
      expect(await (await get(p)).text(), p).toContain(`Журнал действий: событие #${h.seq}, голова цепочки ${h.link}`);
    }
    const D = line(await (await get(`/a/${P}/new`)).text(), 'D')!;
    await get(`/a/${P}/put/${D}/1/${enc(card({ 'МОДЕЛЬ': 'opus-5.5', 'УТВЕРЖДЕНИЕ': 'Другое.' }))}`);
    const done = await (await get(`/a/${P}/done/${D}`)).text();
    const h2 = (await head(env.DB))!;
    expect(line(done, 'CHAIN')).toBe(`#${h2.seq} ${h2.link}`);
    expect(h2.seq).toBeGreaterThan(h.seq);
  });

  it('только дописывать: правка и удаление события запрещены', async () => {
    await submitOk(card());
    const [e] = await events();
    await expect(env.DB.prepare('UPDATE events SET actor = ? WHERE seq = ?').bind('🜂', e.seq).run()).rejects.toThrow(/только дописывать/);
    await expect(env.DB.prepare('UPDATE events SET link = ? WHERE seq = ?').bind('0'.repeat(64), e.seq).run()).rejects.toThrow(/только дописывать/);
    await expect(env.DB.prepare('DELETE FROM events').run()).rejects.toThrow(/только дописывать/);
  });

  it('подмена любого поля рвёт цепочку с этого события', async () => {
    await submitOk(card());
    await submitOk(card({ 'УТВЕРЖДЕНИЕ': 'Второе.' }));
    const ev = await events();
    const forged = ev.map((e, i) => (i === 1 ? { ...e, ts_ms: e.ts_ms - 1000 } : e));
    expect(await verify(forged, GENESIS)).toEqual({ ok: false, at: ev[1].seq });
    expect(ev[0].link).toBe(await sha256hex(lineOf(GENESIS, ev[0])));
  });

  it('отказ: событие reject только при настоящем захвате; повтор отказа ничего не пишет', async () => {
    const { code } = await submitOk(card());
    await env.DB.batch([env.DB.prepare('DELETE FROM otp_used'), env.DB.prepare('DELETE FROM keeper_lock')]);
    await kget(`/reject?code=${code}&otp=${await otp()}&reason=x`);
    await env.DB.batch([env.DB.prepare('DELETE FROM otp_used'), env.DB.prepare('DELETE FROM keeper_lock')]);
    await kget(`/reject?code=${code}&otp=${await otp()}&reason=x`);
    expect((await events()).filter((e) => e.action === 'reject').map((e) => [e.actor, e.object])).toEqual([['🜄', code]]);
  });

  it('истечение черновика — событие expire от сайта', async () => {
    const { code } = await submitOk(card());
    await env.DB.prepare('UPDATE drafts SET created_at = created_at - 90000 WHERE code = ?').bind(code).run();
    await submitOk(card({ 'УТВЕРЖДЕНИЕ': 'Ещё.' }));
    expect((await events()).filter((e) => e.action === 'expire').map((e) => [e.actor, e.object])).toEqual([['сайт', code]]);
  });

  it('test_step и mcp_call пишутся; в журнале нет IP', async () => {
    await get('/wall/test/grok');
    await (exports as unknown as { default: Fetcher }).default.fetch(
      new Request('https://sdominanta.net/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.2.3' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wall_read', arguments: { path: '/wall' } } }),
      }),
    );
    const ev = await events();
    expect(ev.find((e) => e.action === 'test_step')).toMatchObject({ actor: '🜏' });
    expect(ev.find((e) => e.action === 'mcp_call')).toMatchObject({ actor: 'аноним', object: 'wall_read' });
    expect(JSON.stringify(ev)).not.toMatch(/10\.\d+\.\d+\.\d+/);
  });

  it('миграция 0010 восстанавливает прошлое по временам из базы с пометкой restored', async () => {
    const rid = await publish(card());
    const { code } = await submitOk(card({ 'УТВЕРЖДЕНИЕ': 'Отклонённое.' }));
    await env.DB.batch([
      env.DB.prepare(`UPDATE drafts SET created_at = 1792000000 WHERE record_id = ?`).bind(rid),
      env.DB.prepare(`UPDATE records SET created_at = 1792000010 WHERE id = ?`).bind(rid),
      env.DB.prepare(`UPDATE drafts SET state = 'отклонён', decided_by = '🜄', created_at = 1792000020, decided_at = 1792000025 WHERE code = ?`).bind(code),
    ]);
    // Журнал как до миграции: пуст.
    await env.DB.batch([
      env.DB.prepare('DROP TRIGGER events_no_delete'),
      env.DB.prepare('DELETE FROM events'),
      env.DB.prepare(`UPDATE records SET event_seq = NULL`),
    ]);
    const stmts = mig10.replace(/--.*$/gm, '').split(/;\s*(?:\n|$)/).map((q) => q.trim()).filter((q) => /^(INSERT INTO events|UPDATE records)/.test(q));
    await env.DB.batch(stmts.map((q) => env.DB.prepare(q)));
    const ev = await events();
    expect(ev.map((e) => [e.action, e.restored])).toEqual([['done', 1], ['approve', 1], ['done', 1], ['reject', 1]]);
    expect(ev.every((e) => e.ts_ms % 1000 === 0)).toBe(true);
    expect(await verify(ev, GENESIS)).toEqual({ ok: true });
    const rec = await env.DB.prepare('SELECT event_seq FROM records WHERE id = ?').bind(rid).first<{ event_seq: number }>();
    expect(rec!.event_seq).toBe(ev[1].seq);
    expect(await (await get('/wall/log')).text()).toContain(' · восстановлено');
  });
});

// ---------- OpenTimestamps ----------

const PENDING = fromHex('83dfe30d2ef90c8e');
const BTC = fromHex('0588960d73d71901');
const vb = (b: Uint8Array) => new Uint8Array([b.length, ...b]);
/** Ответ календаря на /digest: append(nonce) → sha256 → ожидание с адресом календаря. */
const calendarReply = (nonce: number, uri: string) =>
  new Uint8Array([0xf0, ...vb(new Uint8Array(16).fill(nonce)), 0x08, 0x00, ...PENDING, ...vb(vb(new TextEncoder().encode(uri)))]);
/** Готовое доказательство из календаря: prepend → sha256 → блок биткоина 900000. */
const btcReply = new Uint8Array([0xf1, ...vb(new Uint8Array(8).fill(7)), 0x08, 0x00, ...BTC, ...vb(new Uint8Array([0xa0, 0xf7, 0x36]))]);

describe('Якорь OpenTimestamps', () => {
  it('раз в сутки голова уходит в календари; файл .ots разбирается, строка .txt даёт голову', async () => {
    await submitOk(card());
    const calls: string[] = [];
    const send: Send = async (url, init) => {
      calls.push(url);
      expect(new Uint8Array(init!.body as ArrayBuffer).length).toBe(32);
      return new Response(calendarReply(url.includes('a.pool') ? 1 : 2, url.includes('a.pool') ? 'https://alice.btc.calendar.opentimestamps.org' : 'https://bob.btc.calendar.opentimestamps.org'));
    };
    const now = Date.now();
    expect(await anchorDaily(env, now, send)).toBe('done');
    expect(calls).toEqual(['https://a.pool.opentimestamps.org/digest', 'https://b.pool.opentimestamps.org/digest']);
    expect(await anchorDaily(env, now + 1000, send)).toBe('done');
    expect(calls).toHaveLength(2);
    const h = (await head(env.DB))!;
    const day = Math.floor(now / 86400000);
    const txt = await (await get(`/wall/log/anchor/${day}.txt`)).text();
    expect(await sha256hex(txt)).toBe(h.link);
    const ots = new Uint8Array(await (await get(`/wall/log/anchor/${day}.ots`)).arrayBuffer());
    const f = parseOtsFile(ots);
    expect(Array.from(f.digest)).toEqual(Array.from(fromHex(h.link)));
    expect(f.stamp.ops).toHaveLength(2);
    expect(await (await get('/wall/log/anchors')).text()).toContain(`событие #${h.seq} · ${h.link} · ждёт`);
  });

  it('недоступные календари ничего не ломают; повтор не чаще раза в 10 минут', async () => {
    await submitOk(card());
    let n = 0;
    const down: Send = async () => {
      n++;
      throw new Error('нет сети');
    };
    expect(await anchorDaily(env, Date.now(), down)).toBe('failed');
    expect(await anchorDaily(env, Date.now() + 60000, down)).toBe('failed');
    expect(n).toBe(2);
    expect(await env.DB.prepare('SELECT COUNT(*) AS c FROM anchors').first<{ c: number }>()).toEqual({ c: 0 });
  });

  it('проверка ждущего якоря подставляет блок биткоина', async () => {
    await submitOk(card());
    const now = Date.now();
    await anchorDaily(env, now, async () => new Response(calendarReply(1, 'https://alice.btc.calendar.opentimestamps.org')));
    const asked: string[] = [];
    const ready = await upgradeAnchors(env, Math.floor(now / 1000) + 7200, async (url) => {
      asked.push(url);
      return new Response(btcReply);
    });
    expect(ready).toBe(1);
    expect(asked[0]).toMatch(/^https:\/\/alice\.btc\.calendar\.opentimestamps\.org\/timestamp\/[0-9a-f]{64}$/);
    const row = await env.DB.prepare('SELECT state, ots FROM anchors').first<{ state: string; ots: string }>();
    expect(row!.state).toBe('в биткоине');
    expect(parseOtsFile(unb64(row!.ots)).stamp.ops).toHaveLength(2);
  });

  it('файл .ots: сериализация и разбор сходятся', () => {
    const s: Stamp = { atts: [], ops: [[{ tag: 0x08 }, { atts: [{ tag: '83dfe30d2ef90c8e', payload: vb(new TextEncoder().encode('https://x.example')) }], ops: [] }]] };
    const d = new Uint8Array(32).fill(9);
    const back = parseOtsFile(otsFile(d, s));
    expect(back.stamp).toEqual(s);
  });
});
