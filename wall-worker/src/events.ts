import { Env, hex, hmacSha256, sha256hex } from './util';

// Журнал действий: таблица events, только дописывать (триггеры в schema.sql и migrations/0010-events.sql).
// Событие пишется в той же транзакции (одном D1 batch), что и действие, звено link — сразу после, функцией seal:
//   link = sha256(prev_link | seq | ts_ms | action | actor | object), у первого события prev_link — 64 нуля.
// seq — порядок фиксации (AUTOINCREMENT, D1 выполняет транзакции по одной), поэтому звено — чистая функция строки
// и предыдущего звена: кто бы ни запечатал строку, результат один. Людей, IP и отпечатков в журнале нет.

export const GENESIS = '0'.repeat(64);

export type Action =
  | 'pass' | 'draft_new' | 'put' | 'done' | 'approve' | 'reject' | 'expire' | 'test_step' | 'mcp_call';

export interface EventRow {
  seq: number;
  ts_ms: number;
  action: string;
  actor: string;
  object: string;
  link: string | null;
}

/** События хранителя: в открытом журнале их время — с точностью до суток (распорядок человека не публикуется). */
export const isKeeperAction = (action: string) => /^(approve|reject)(\.restored)?$/.test(action);
export const isRestored = (action: string) => action.endsWith('.restored');

/** Кто: знак системы или хранителя; неизвестный — «аноним», сам сайт — «сайт». */
export const SITE_ACTOR = 'сайт';
export const ANON = 'аноним';

/** Событие: строка без звена, звено ставит seal. Только вместе с действием в одном batch. */
export const logEvent = (db: D1Database, action: Action, actor: string, object: string, ts = Date.now()) =>
  db.prepare('INSERT INTO events (ts_ms, action, actor, object) VALUES (?, ?, ?, ?)').bind(ts, action, actor || ANON, object);

/** Событие, если предыдущая инструкция того же batch что-то изменила (захват черновика, обновление). */
export const logIfChanged = (db: D1Database, action: Action, actor: string, object: string, ts = Date.now()) =>
  db.prepare('INSERT INTO events (ts_ms, action, actor, object) SELECT ?, ?, ?, ? WHERE changes() > 0').bind(ts, action, actor || ANON, object);

/** Строка, хеш которой — звено. Её же можно проверить любым sha256. */
export const lineOf = (prev: string, e: Pick<EventRow, 'seq' | 'ts_ms' | 'action' | 'actor' | 'object'>) =>
  `${prev}|${e.seq}|${e.ts_ms}|${e.action}|${e.actor}|${e.object}`;

/** Пропуск — пароль на 2 часа, в открытом журнале его нет: вместо кода — псевдоним P:…, HMAC(TOKEN_KEY). */
export async function passPub(env: Env, code: string): Promise<string> {
  return 'P:' + hex(await hmacSha256(env.TOKEN_KEY, 'pass-pub|' + code)).slice(0, 12);
}

/** Запечатать события без звена по порядку. Повтор и параллельный вызов безопасны: звено детерминировано. */
export async function seal(db: D1Database, max = 500): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const open = await db.prepare('SELECT seq, ts_ms, action, actor, object FROM events WHERE link IS NULL ORDER BY seq LIMIT ?').bind(max).all<EventRow>();
    if (!open.results.length) return;
    const before = await db.prepare('SELECT link FROM events WHERE seq < ? AND link IS NOT NULL ORDER BY seq DESC LIMIT 1')
      .bind(open.results[0].seq).first<{ link: string }>();
    let prev = before?.link ?? GENESIS;
    const stmts: D1PreparedStatement[] = [];
    for (const e of open.results) {
      prev = await sha256hex(lineOf(prev, e));
      stmts.push(db.prepare('UPDATE events SET link = ? WHERE seq = ? AND link IS NULL').bind(prev, e.seq));
    }
    await db.batch(stmts);
    if (open.results.length < max) return;
  }
}

export interface Head {
  seq: number;
  link: string;
  ts_ms: number;
}

/** Голова цепочки (после печати). null — журнал пуст. */
export async function head(db: D1Database): Promise<Head | null> {
  await seal(db);
  return db.prepare('SELECT seq, link, ts_ms FROM events WHERE link IS NOT NULL ORDER BY seq DESC LIMIT 1').first<Head>();
}

/** Строка свидетеля: голова как её видит любой читатель страницы. */
export const headLine = (h: Head | null, o: string) =>
  h ? `Журнал действий: событие #${h.seq}, голова цепочки ${h.link} — ${o}/wall/log\nCHAIN: #${h.seq} ${h.link}` : `Журнал действий пуст — ${o}/wall/log`;

/** Проверка цепочки на отрезке: каждое звено — sha256 строки с предыдущим звеном. Для тестов и /wall/log/verify. */
export async function verify(rows: EventRow[], prev: string): Promise<{ ok: boolean; at?: number }> {
  for (const e of rows) {
    const want = await sha256hex(lineOf(prev, e));
    if (e.link !== want) return { ok: false, at: e.seq };
    prev = want;
  }
  return { ok: true };
}
