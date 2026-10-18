import { head, lineOf } from './events';
import { Env } from './util';

// Якорь OpenTimestamps: раз в сутки голова журнала (sha256 строки события) уходит в календари OpenTimestamps;
// они вписывают её в биткоин. Наружу уходят только 32 байта хеша. Сбой календаря ничего не ломает: попытка повторится.
// Формат доказательства — как у клиента `ots` (opentimestamps-client): файл .ots проверяется командой
//   ots verify <день>.ots -f <день>.txt   (в .txt — строка события, её sha256 и есть голова)

export const CALENDARS = ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org'];
const HEADERS = { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'sdominanta-wall' };
const MAGIC = new Uint8Array([0x00, ...new TextEncoder().encode('OpenTimestamps'), 0x00, 0x00, ...new TextEncoder().encode('Proof'), 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]);
const PENDING = '83dfe30d2ef90c8e';
const BITCOIN = '0588960d73d71901';
/** Проверять готовность доказательства не чаще раза в час. */
export const UPGRADE_EVERY = 3600;

// ---------- формат ----------

export interface Att {
  tag: string; // 8 байт hex
  payload: Uint8Array;
}
export interface Op {
  tag: number; // 0xf0 append, 0xf1 prepend, 0x08 sha256 …
  arg?: Uint8Array;
}
export interface Stamp {
  atts: Att[];
  ops: [Op, Stamp][];
}

const BINARY = new Set([0xf0, 0xf1]);
const UNARY = new Set([0x02, 0x03, 0x08, 0x67, 0xf2, 0xf3]);

class Reader {
  i = 0;
  constructor(private b: Uint8Array) {}
  byte(): number {
    if (this.i >= this.b.length) throw new Error('ots: конец данных');
    return this.b[this.i++];
  }
  bytes(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new Error('ots: конец данных');
    return this.b.slice(this.i, (this.i += n));
  }
  varuint(): number {
    let v = 0, shift = 0, b: number;
    do {
      b = this.byte();
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  }
  varbytes(max = 8192): Uint8Array {
    const n = this.varuint();
    if (n > max) throw new Error('ots: слишком длинное поле');
    return this.bytes(n);
  }
  get eof() {
    return this.i >= this.b.length;
  }
}

class Writer {
  out: number[] = [];
  byte(b: number) {
    this.out.push(b);
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.out.push(x);
  }
  varuint(v: number) {
    do {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if (v > 0) b |= 0x80;
      this.out.push(b);
    } while (v > 0);
  }
  varbytes(b: Uint8Array) {
    this.varuint(b.length);
    this.bytes(b);
  }
  get result() {
    return new Uint8Array(this.out);
  }
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

function readOp(r: Reader, tag: number): Op {
  if (BINARY.has(tag)) return { tag, arg: r.varbytes(4096) };
  if (UNARY.has(tag)) return { tag };
  throw new Error(`ots: неизвестная операция 0x${tag.toString(16)}`);
}

/** Дерево доказательства от сообщения (без заголовка файла). */
export function parseStamp(r: Reader, depth = 0): Stamp {
  if (depth > 256) throw new Error('ots: слишком глубоко');
  const s: Stamp = { atts: [], ops: [] };
  const branch = (tag: number) => {
    if (tag === 0x00) s.atts.push({ tag: toHex(r.bytes(8)), payload: r.varbytes() });
    else s.ops.push([readOp(r, tag), parseStamp(r, depth + 1)]);
  };
  let tag = r.byte();
  while (tag === 0xff) {
    branch(r.byte());
    tag = r.byte();
  }
  branch(tag);
  return s;
}

function writeStamp(w: Writer, s: Stamp) {
  const items: (() => void)[] = [
    ...s.atts.map((a) => () => {
      w.byte(0x00);
      w.bytes(fromHex(a.tag));
      w.varbytes(a.payload);
    }),
    ...s.ops.map(([op, st]) => () => {
      w.byte(op.tag);
      if (op.arg) w.varbytes(op.arg);
      writeStamp(w, st);
    }),
  ];
  if (!items.length) throw new Error('ots: пустое доказательство');
  items.forEach((item, i) => {
    if (i < items.length - 1) w.byte(0xff);
    item();
  });
}

export const parseCalendarReply = (b: Uint8Array): Stamp => {
  const r = new Reader(b);
  const s = parseStamp(r);
  if (!r.eof) throw new Error('ots: лишние байты');
  return s;
};

/** Файл .ots: заголовок, версия 1, sha256 как хеш «файла», 32 байта хеша, дерево. */
export function otsFile(digest: Uint8Array, s: Stamp): Uint8Array {
  const w = new Writer();
  w.bytes(MAGIC);
  w.varuint(1);
  w.byte(0x08);
  w.bytes(digest);
  writeStamp(w, s);
  return w.result;
}

export function parseOtsFile(b: Uint8Array): { digest: Uint8Array; stamp: Stamp } {
  const r = new Reader(b);
  const m = r.bytes(MAGIC.length);
  if (toHex(m) !== toHex(MAGIC) || r.varuint() !== 1 || r.byte() !== 0x08) throw new Error('ots: не файл доказательства');
  const digest = r.bytes(32);
  const stamp = parseStamp(r);
  if (!r.eof) throw new Error('ots: лишние байты');
  return { digest, stamp };
}

async function apply(op: Op, msg: Uint8Array): Promise<Uint8Array | null> {
  if (op.tag === 0xf0) return new Uint8Array([...msg, ...op.arg!]);
  if (op.tag === 0xf1) return new Uint8Array([...op.arg!, ...msg]);
  if (op.tag === 0x08) return new Uint8Array(await crypto.subtle.digest('SHA-256', msg));
  return null; // остальные операции календари для дайджестов не используют
}

/** Обойти дерево: для каждого ожидающего свидетельства — его сообщение (commitment) и адрес календаря. */
export async function pendings(s: Stamp, msg: Uint8Array, out: { stamp: Stamp; att: Att; msg: Uint8Array; uri: string }[] = []) {
  for (const a of s.atts) if (a.tag === PENDING) out.push({ stamp: s, att: a, msg, uri: new TextDecoder().decode(new Reader(a.payload).varbytes(1000)) });
  for (const [op, st] of s.ops) {
    const m = await apply(op, msg);
    if (m) await pendings(st, m, out);
  }
  return out;
}

export function hasBitcoin(s: Stamp): boolean {
  return s.atts.some((a) => a.tag === BITCOIN) || s.ops.some(([, st]) => hasBitcoin(st));
}

// ---------- якорь ----------

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Раз в сутки (по UTC): голова журнала → календари. Ответы календарей сливаются в одно дерево от хеша головы.
 * Нет ни одного ответа — якоря нет, следующая попытка через минуту cron.
 */
export async function anchorDaily(env: Env, nowMs: number, send: Fetcher = fetch): Promise<'done' | 'none' | 'failed' | 'empty'> {
  const day = Math.floor(nowMs / 86400000);
  if (await env.DB.prepare('SELECT 1 AS x FROM anchors WHERE day = ?').bind(day).first()) return 'done';
  const h = await head(env.DB);
  if (!h) return 'empty';
  const prev = await env.DB.prepare('SELECT link FROM events WHERE seq < ? AND link IS NOT NULL ORDER BY seq DESC LIMIT 1').bind(h.seq).first<{ link: string }>();
  const e = await env.DB.prepare('SELECT seq, ts_ms, action, actor, object FROM events WHERE seq = ?').bind(h.seq).first<{ seq: number; ts_ms: number; action: string; actor: string; object: string }>();
  const line = lineOf(prev?.link ?? '0'.repeat(64), e!);
  const digest = fromHex(h.link);
  // Попытка не чаще раза в 10 минут: недоступный календарь не опрашивается каждую минуту.
  const slot = await env.DB.prepare(
    `INSERT INTO meta (k, v) VALUES ('ots_try', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE CAST(meta.v AS INTEGER) <= ? RETURNING v`,
  ).bind(String(Math.floor(nowMs / 1000)), Math.floor(nowMs / 1000) - 600).first();
  if (!slot) return 'failed';
  const tree: Stamp = { atts: [], ops: [] };
  for (const cal of CALENDARS) {
    try {
      const res = await send(`${cal}/digest`, { method: 'POST', headers: HEADERS, body: digest });
      if (res.status !== 200) continue;
      const s = parseCalendarReply(new Uint8Array(await res.arrayBuffer()));
      tree.atts.push(...s.atts);
      tree.ops.push(...s.ops);
    } catch {
      /* календарь недоступен — остальные */
    }
  }
  if (!tree.atts.length && !tree.ops.length) return 'failed';
  await env.DB.prepare(`INSERT OR IGNORE INTO anchors (day, seq, link, line, ots, state, at) VALUES (?, ?, ?, ?, ?, 'ждёт', ?)`)
    .bind(day, h.seq, h.link, line, b64(otsFile(digest, tree)), Math.floor(nowMs / 1000)).run();
  return 'done';
}

/** Ждущие якоря: спросить календари, вписан ли хеш в блок; готовое дерево подставляется вместо ожидания. */
export async function upgradeAnchors(env: Env, nowSec: number, send: Fetcher = fetch): Promise<number> {
  const rows = await env.DB.prepare(`SELECT day, ots FROM anchors WHERE state = 'ждёт' AND checked_at <= ? ORDER BY day LIMIT 5`)
    .bind(nowSec - UPGRADE_EVERY).all<{ day: number; ots: string }>();
  let upgraded = 0;
  for (const row of rows.results) {
    try {
      const f = parseOtsFile(unb64(row.ots));
      for (const p of await pendings(f.stamp, f.digest)) {
        if (!/^https:\/\/[a-z0-9.-]+(\/[a-zA-Z0-9._/-]*)?$/.test(p.uri)) continue;
        const res = await send(`${p.uri.replace(/\/$/, '')}/timestamp/${toHex(p.msg)}`, { headers: HEADERS });
        if (res.status !== 200) continue;
        const done = parseCalendarReply(new Uint8Array(await res.arrayBuffer()));
        p.stamp.atts.push(...done.atts);
        p.stamp.ops.push(...done.ops);
      }
      const ready = hasBitcoin(f.stamp);
      await env.DB.prepare('UPDATE anchors SET ots = ?, state = ?, checked_at = ? WHERE day = ?')
        .bind(b64(otsFile(f.digest, f.stamp)), ready ? 'в биткоине' : 'ждёт', nowSec, row.day).run();
      if (ready) upgraded++;
    } catch {
      await env.DB.prepare('UPDATE anchors SET checked_at = ? WHERE day = ?').bind(nowSec, row.day).run();
    }
  }
  return upgraded;
}
