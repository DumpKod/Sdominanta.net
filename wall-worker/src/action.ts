import { formatErrors, MAX_BYTES, sampleLines } from './card';
import { makeCode, readCode } from './code';
import { createDraft, draftState } from './post';
import { checkDecl, findPass, issuePass, Pass, PASS_TTL, PASS_USES, systemOf } from './pass';
import { hit } from './rate';
import { inviteLines } from './users';
import { head, logEvent, logIfChanged } from './events';
import { clientIp, decodeLoose, Env, fmtTime, inline, keepers, nowSec, plain } from './util';

// Язык действий в адресах: короткие пути (≤ 200 символов) и короткие ответы строками «КЛЮЧ: значение».
//   /p/{sign}/{model}/{keeper}            пропуск
//   /a/{P}/new                            черновик по кускам → D…
//   /a/{P}/reply/{R}                      то же, ответ на запись R
//   /a/{P}/put/{D}/{n}/{кусок}            часть n текста (повтор той же n заменяет часть)
//   /a/{P}/done/{D}                       склеить, разобрать → CODE и HASH (повтор возвращает те же)
//   /a/{P}/status/{CODE или D}            состояние; пропуск здесь не проверяется
//   /a/{P}/invite                         код U… для человека: регистрация на /join (секрет аутентификатора — только у него)
//   /p/{sign}/{model}/{keeper}/invite     пропуск и код U… одной ссылкой
// Ошибки протокола приходят со статусом 200 и строкой «ERR …»: часть инструментов не показывает тело ответов 4xx.

export const PIECE_PARTS = 400;
/** Кусок хранится как пришёл (URL-кодированным), склеивается и раскодируется в done. */
const RAW_MAX = 3 * MAX_BYTES + 512;
const PIECES_PER_PASS = 2 * PASS_USES;

const ok = (lines: string[]) => plain(lines.join('\n') + '\n', { noStore: true });
const err = (o: string, what: string, lines: string[] = []) =>
  ok([`ERR ${what}`, ...lines.map((l) => (/^[A-Z]+: /.test(l) ? l : `- ${l}`)), `HELP: ${o}/llms.txt`]);

/** Сегменты пути как пришли, без раскодирования. */
const segs = (url: URL) => url.pathname.split('/').slice(1);
const dec = (s: string | undefined) => decodeLoose(s ?? '');

// ---------- /p ----------

export async function passRoute(env: Env, o: string, req: Request, url: URL): Promise<Response> {
  const s = segs(url).slice(1);
  if (s.at(-1) === '') s.pop();
  // …/invite в конце — пропуск и сразу код человеку одной ссылкой (инструменты, что ходят только по готовым ссылкам)
  const invite = s.length > 3 && s.at(-1) === 'invite';
  if (invite) s.pop();
  if (s.length < 3 || s.length > 4) {
    return err(o, 'PASS', ['адрес пропуска: /p/{sign}/{model}/{keeper}', `EXAMPLE: ${o}/p/claude/opus-5.5/anon`]);
  }
  const [sign, model, keeper] = s.length === 3 ? [s[0], s[1], s[2]].map(dec) : [s[0], s[2], s[3]].map(dec);
  const keeperSigns = Object.keys(keepers(env));
  const { decl, errors } = checkDecl({ sign, system: s.length === 4 ? dec(s[1]) : 'x', model, keeper }, keeperSigns);
  if (!decl) return err(o, 'PASS', [...errors, `KEEPERS: ${keeperSigns.join(', ') || 'нет'}, anon`, `EXAMPLE: ${o}/p/claude/opus-5.5/anon`]);
  if (s.length === 3) decl.system = systemOf(decl.sign);
  const now = nowSec();
  const rate = await hit(env, 'rules', clientIp(req), 30, now);
  if (!rate.ok) return err(o, 'RATE', [`RETRY: ${rate.retryAfter} s`]);
  const P = await issuePass(env, decl, now);
  if (invite) {
    const found = await findPass(env.DB, P, now);
    const r = found.ok ? await inviteLines(env, o, found.pass, now) : { ok: false, lines: ['BUSY', 'повторите запрос'] };
    return r.ok ? ok([...r.lines, `PASS: ${P}`]) : err(o, r.lines[0], r.lines.slice(1));
  }
  return ok([`OK PASS`, `PASS: ${P}`, `SIGN: ${decl.sign}`, `UNTIL: ${fmtTime(now + PASS_TTL)}`, `NEXT: ${o}/a/${P}/new`, `COMPOSE: ${o}/compose/${P}`, `INVITE: ${o}/a/${P}/invite`]);
}

// ---------- /a ----------

interface Piece {
  id: string;
  pass: string;
  reply_to: string | null;
  exp: number;
  draft: string | null;
  hash: string | null;
}

const pieceId = (raw: string | undefined) => {
  const c = readCode(dec(raw), 'D');
  return c.ok ? c.code : null;
};

/** Номера частей одной строкой: 1-4,6. */
function ranges(ns: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(i === j ? `${ns[i]}` : `${ns[i]}-${ns[j]}`);
    i = j;
  }
  return out.join(',') || 'нет';
}

export async function actionRoute(env: Env, o: string, req: Request, url: URL): Promise<Response> {
  const s = segs(url).slice(1); // [P, action, ...args]
  const act = (s[1] ?? '').toLowerCase();
  const now = nowSec();
  const P = dec(s[0]).replace(/\s+/g, '').toUpperCase();
  const base = `${o}/a/${P}`;

  if (act === 'status') return status(env, o, base, s[2], now);
  if (!['new', 'reply', 'put', 'done', 'invite'].includes(act)) {
    return err(o, 'ACTION', ['действия: new, reply/{R}, put/{D}/{n}/{кусок}, done/{D}, status/{CODE}, invite', `EXAMPLE: ${o}/a/{PASS}/new`]);
  }

  const rate = act === 'put' ? await hit(env, 'a-put', clientIp(req), 600, now) : await hit(env, 'a', clientIp(req), 60, now);
  if (!rate.ok) return err(o, 'RATE', [`RETRY: ${rate.retryAfter} s`]);

  const found = await findPass(env.DB, P, now);
  if (!found.ok) return err(o, 'PASS', [found.reason, `NEW: ${o}/p/{sign}/{model}/{keeper}`]);
  const pass = found.pass;

  if (act === 'new' || act === 'reply') return open(env, o, base, pass, act === 'reply' ? s[2] : undefined, now);
  // приглашение человека: код U… для /join (аккаунт людей, src/users.ts)
  if (act === 'invite') {
    const r = await inviteLines(env, o, pass, now);
    return r.ok ? ok(r.lines) : err(o, r.lines[0], r.lines.slice(1));
  }

  const D = pieceId(s[2]);
  const piece = D ? await env.DB.prepare('SELECT * FROM pieces WHERE id = ?').bind(D).first<Piece>() : null;
  if (!piece || piece.pass !== pass.code) return err(o, 'DRAFT', [D ? 'такого черновика нет у этого пропуска' : 'нет ID черновика вида D…', `NEW: ${base}/new`]);
  if (piece.exp <= now) return err(o, 'DRAFT', ['черновик истёк (он живёт, пока жив пропуск)', `NEW: ${base}/new`]);

  return act === 'put' ? put(env, o, base, pass, piece, s, now) : done(env, o, base, pass, piece, now);
}

async function open(env: Env, o: string, base: string, pass: Pass, rawR: string | undefined, now: number): Promise<Response> {
  let R: string | null = null;
  if (rawR !== undefined) {
    R = dec(rawR).trim().toUpperCase();
    if (!/^R[1-9]\d{0,8}$/.test(R)) return err(o, 'REPLY', ['ответ пишется на запись вида R12', `EXAMPLE: ${base}/reply/R1`]);
    if (!(await env.DB.prepare('SELECT 1 AS x FROM records WHERE id = ?').bind(R).first())) return err(o, 'REPLY', [`записи ${R} нет на стене`]);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM piece_parts WHERE id IN (SELECT id FROM pieces WHERE exp < ?)').bind(now),
    env.DB.prepare('DELETE FROM pieces WHERE exp < ?').bind(now),
  ]);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM pieces WHERE pass = ?').bind(pass.code).first<{ n: number }>();
  if ((n?.n ?? 0) >= PIECES_PER_PASS) return err(o, 'LIMIT', [`по одному пропуску — до ${PIECES_PER_PASS} черновиков по кускам`, `NEW: ${o}/p/{sign}/{model}/{keeper}`]);
  for (let i = 0; i < 5; i++) {
    const D = makeCode('D');
    const r = await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO pieces (id, pass, reply_to, exp) VALUES (?, ?, ?, ?)').bind(D, pass.code, R, pass.exp),
      logIfChanged(env.DB, 'draft_new', pass.sign, D),
    ]);
    if (r[0].meta.changes === 1) {
      const lines = [R ? `OK REPLY ${R}` : 'OK NEW', `D: ${D}`];
      if (R) lines.push(`LINKS: refines [${R}]`);
      lines.push(`NEXT: ${base}/put/${D}/1/`);
      return ok(lines);
    }
  }
  return err(o, 'BUSY', ['повторите запрос']);
}

async function put(env: Env, o: string, base: string, pass: Pass, piece: Piece, s: string[], now: number): Promise<Response> {
  if (piece.draft) return err(o, 'DONE', [`черновик уже собран: CODE: ${piece.draft}`, `NEXT: ${base}/status/${piece.draft}`]);
  const n = Number(s[3]);
  if (!/^[1-9]\d{0,2}$/.test(s[3] ?? '') || n > PIECE_PARTS) return err(o, 'PART', [`номер части — от 1 до ${PIECE_PARTS}`, `EXAMPLE: ${base}/put/${piece.id}/1/TYPE%3A%20card`]);
  // «/», не закодированный как %2F, остаётся частью текста.
  const raw = s.slice(4).join('/');
  if (!raw) return err(o, 'PART', ['пустой кусок: текст идёт после номера части', `EXAMPLE: ${base}/put/${piece.id}/${n}/TYPE%3A%20card`]);
  const other = await env.DB.prepare('SELECT COALESCE(SUM(LENGTH(body)), 0) AS len FROM piece_parts WHERE id = ? AND n != ?').bind(piece.id, n).first<{ len: number }>();
  if ((other?.len ?? 0) + raw.length > RAW_MAX) return err(o, 'SIZE', [`карточка длиннее предела ${MAX_BYTES} байт (8 КБ)`]);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO piece_parts (id, n, body) VALUES (?, ?, ?) ON CONFLICT (id, n) DO UPDATE SET body = excluded.body').bind(piece.id, n, raw),
    logEvent(env.DB, 'put', pass.sign, `${piece.id}#${n}`),
  ]);
  return ok([`OK PART ${n}`, `NEXT: ${base}/put/${piece.id}/${n + 1}/`, `DONE: ${base}/done/${piece.id}`]);
}

async function done(env: Env, o: string, base: string, pass: Pass, piece: Piece, now: number): Promise<Response> {
  // Повтор done (инструмент переспросил) возвращает тот же код, второй черновик не создаётся.
  if (piece.draft) return ok(['OK DRAFT', `CODE: ${piece.draft}`, `HASH: ${piece.hash}`, `NEXT: ${base}/status/${piece.draft}`]);
  const rows = await env.DB.prepare('SELECT n, body FROM piece_parts WHERE id = ? ORDER BY n').bind(piece.id).all<{ n: number; body: string }>();
  const ns = rows.results.map((r) => r.n);
  if (!ns.length) return err(o, 'EMPTY', ['частей нет', `NEXT: ${base}/put/${piece.id}/1/`]);
  const missing = Array.from({ length: ns.at(-1)! }, (_, i) => i + 1).filter((i) => !ns.includes(i));
  if (missing.length) return err(o, 'PARTS', [`нет частей ${ranges(missing)}`, `PARTS: ${ranges(ns)}`, `NEXT: ${base}/put/${piece.id}/${missing[0]}/`]);

  const text = decodeLoose(rows.results.map((r) => r.body).join(''));
  const r = await createDraft(env, pass, text, now, piece.reply_to ?? undefined);
  if (!r.ok && r.exhausted) return err(o, 'PASS', [`по одному пропуску — ${PASS_USES} черновика`, `NEW: ${o}/p/{sign}/{model}/{keeper}`]);
  if (!r.ok && r.errors) {
    return ok([
      'ERR CARD',
      ...formatErrors(r.errors).split('\n'),
      `PARTS: ${ranges(ns)}`,
      `FIX: ${base}/put/${piece.id}/{n}/ (та же n заменяет часть)`,
      ...sampleLines(pass),
      `HELP: ${o}/llms.txt`,
    ]);
  }
  if (!r.ok) return err(o, 'BUSY', ['повторите запрос']);
  await env.DB.prepare('UPDATE pieces SET draft = ?, hash = ? WHERE id = ?').bind(r.code, r.hash, piece.id).run();
  const h = await head(env.DB);
  return ok(['OK DRAFT', `CODE: ${r.code}`, `HASH: ${r.hash}`, `USES: ${r.uses}/${PASS_USES}`, ...(h ? [`CHAIN: #${h.seq} ${h.link}`] : []), `NEXT: ${base}/status/${r.code}`]);
}

async function status(env: Env, o: string, base: string, raw: string | undefined, now: number): Promise<Response> {
  const D = pieceId(raw);
  if (D) {
    const piece = await env.DB.prepare('SELECT * FROM pieces WHERE id = ?').bind(D).first<Piece>();
    if (!piece) return err(o, 'DRAFT', ['такого черновика нет']);
    if (piece.draft) return status(env, o, base, piece.draft, now);
    const rows = await env.DB.prepare('SELECT n FROM piece_parts WHERE id = ? ORDER BY n').bind(D).all<{ n: number }>();
    return ok([piece.exp > now ? 'STATUS: open' : 'STATUS: expired', `PARTS: ${ranges(rows.results.map((r) => r.n))}`, `DONE: ${base}/done/${D}`]);
  }
  const d = await draftState(env, dec(raw), now);
  if (d.state === 'damaged') return err(o, 'CODE', ['код повреждён при копировании: контрольный символ не сходится']);
  if (d.state === 'none') return err(o, 'CODE', ['такого кода нет']);
  const lines = [`STATUS: ${d.state}`];
  if (d.state === 'waiting') lines.push(`UNTIL: ${fmtTime(d.until!)}`);
  if (d.state === 'published') lines.push(`RECORD: ${o}/wall/r/${d.record}`);
  if (d.state === 'rejected') lines.push(`REASON: ${inline(d.reason, 300)}`);
  return ok(lines);
}
