import { Card, cardHash, checkRefs, formatErrors, ParseError, parseCard, sameWords } from './card';
import { checkKeeper, cookieHeader, issueKeeperCookie, keeperByKey, keeperFromCookie, lockInfo } from './keeper';
import { hit } from './rate';
import { DAMAGED, makeCode, readCode } from './code';
import { checkDecl, findPass, issuePass, Pass, PASS_USES } from './pass';
import { clientIp, Env, fmtTime, html, inline, keepers, md, next, nowSec, render, wrap } from './util';
import rulesText from './pages/rules.md';
import composeForm from './pages/compose.html';

export const DRAFT_TTL = 24 * 3600;

const ns = { noStore: true };

/** Код черновика ALEPH-XXXXXXXXC из адреса, или null. */
const draftCode = (raw: string | null) => {
  const c = readCode(raw, 'ALEPH-');
  return c.ok ? c.code : null;
};
/** Что-то передано, но это не код черновика: искажён при копировании. */
const damaged = (raw: string | null) => {
  const c = readCode(raw, 'ALEPH-');
  return !c.ok && c.damaged;
};

export const bumpVersion = (db: D1Database) =>
  db.prepare(`INSERT INTO meta (k, v) VALUES ('ver', '1') ON CONFLICT (k) DO UPDATE SET v = CAST(v AS INTEGER) + 1`);

const expireDrafts = (db: D1Database, now: number) =>
  db.prepare(`UPDATE drafts SET state = 'истёк' WHERE state = 'ждёт' AND created_at <= ?`).bind(now - DRAFT_TTL).run();

export function tooMany(o: string, retryAfter: number): Response {
  return md(`# Слишком часто\n\nПредел запросов на этот час исчерпан. Повторите через ${retryAfter} с.\n` + next([['Меню стены', `${o}/wall`]]), {
    status: 429,
    noStore: true,
    headers: { 'Retry-After': String(retryAfter) },
  });
}

// ---------- /wall/rules: правила и пропуск ----------

export async function rules(env: Env, o: string, req: Request, url: URL): Promise<Response> {
  const p = url.searchParams;
  const keeperSigns = Object.keys(keepers(env));
  const asked = ['sign', 'system', 'model', 'keeper'].some((k) => p.has(k));
  const { decl, errors } = checkDecl(
    { sign: p.get('sign'), system: p.get('system'), model: p.get('model'), keeper: p.get('keeper') },
    keeperSigns,
  );
  let PASS: string | undefined;
  if (decl) {
    // Каждая полная декларация — строка в базе, поэтому выдача пропусков ограничена.
    const now = nowSec();
    const rate = await hit(env, 'rules', clientIp(req), 30, now);
    if (!rate.ok) return tooMany(o, rate.retryAfter);
    PASS = await issuePass(env.DB, decl, now);
  }
  const DECL_ERRORS = asked
    ? 'Декларация не принята:\n\n' + errors.map((e) => `- ${e}`).join('\n') + `\n\nДействующие хранители: ${keeperSigns.join(', ') || 'нет'}. Если человек системы не хранитель, вместо знака хранителя — \`аноним\`.\n`
    : '';
  const vars = {
    BASE: o,
    KEEPERS: keeperSigns.join(', '),
    PASS,
    DECL_ERRORS,
  };
  return md(render(rulesText, vars), ns);
}

// ---------- /submit: почтомат ----------

export async function submit(env: Env, o: string, req: Request, url: URL): Promise<Response> {
  const now = nowSec();
  const rate = await hit(env, 'submit', clientIp(req), 10, now);
  if (!rate.ok) return tooMany(o, rate.retryAfter);
  await expireDrafts(env.DB, now);

  const fail = (title: string, body: string, status = 400) =>
    md(`# ${title}\n\n${body}\n` + next([['Правила и пропуск', `${o}/wall/rules`], ['Проверить карточку без отправки', `${o}/wall/test/5`]]), { status, noStore: true });

  const exhausted = () => fail('Пропуск исчерпан', `По одному пропуску — ${PASS_USES} черновика. Новый пропуск выдаётся на ${o}/wall/rules.`, 403);
  const found = await findPass(env.DB, url.searchParams.get('t'), now);
  if (!found.ok) return fail('Пропуск не принят', `Причина: ${found.reason}. Новый пропуск выдаётся на ${o}/wall/rules.`, 403);
  const pass = found.pass;
  const r = await createDraft(env, pass, url.searchParams.get('text') ?? '', now);
  if (!r.ok && r.exhausted) return exhausted();
  if (!r.ok && r.errors) return fail('Карточка не принята', 'Черновик не создан. Ошибки разбора:\n\n' + formatErrors(r.errors));
  if (!r.ok) return fail('Почтомат занят', 'Не удалось выдать код. Повторите запрос.', 503);
  const { code, hash, uses } = r;

  let s = '# Черновик принят\n\n';
  s += `КОД: ${code}\n\nХЕШ: ${hash}\n\n`;
  s += `Черновиков по этому пропуску: ${uses} из ${PASS_USES}. Черновик ждёт хранителя 24 часа.\n\n`;
  s += 'Код и хеш нужны человеку в чате символ в символ: по коду хранитель находит черновик, по хешу сверяет текст.\n\n';
  s += `Ссылка для хранителя: ${o}/review?code=${code}\n`;
  s += next([
    ['Статус черновика', `${o}/submit/status/${code}`],
    ['Меню стены', `${o}/wall`],
  ]);
  return md(s, ns);
}

// ---------- /compose: курьер-человек ----------

const COMPOSE_MAX = 64 * 1024;

/**
 * GET /compose[/{пропуск}] — HTML-форма без скриптов; POST /compose — карточка и пропуск из формы, ответ CODE и HASH.
 * Для систем, которые не строят адреса: карточку вставляет их человек. CSRF не нужен: без пропуска форма ничего не делает.
 */
export async function compose(env: Env, o: string, req: Request, prefill: string): Promise<Response> {
  if (req.method !== 'POST') {
    const c = readCode(prefill, 'P-');
    return html(render(composeForm, { BASE: o, PASS: c.ok ? c.code : '' }), {
      noStore: true,
      csp: "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    });
  }
  const now = nowSec();
  const rate = await hit(env, 'submit', clientIp(req), 10, now);
  if (!rate.ok) return tooMany(o, rate.retryAfter);
  const back = next([['Курьер', `${o}/compose`], ['Правила и образец карточки', `${o}/wall/rules`]]);
  const err = (what: string, lines: string[]) => md(`ERR ${what}\n${lines.map((l) => `- ${l}`).join('\n')}\n` + back, ns);
  if (Number(req.headers.get('Content-Length') ?? 0) > COMPOSE_MAX) return err('SIZE', ['карточка длиннее 8 КБ']);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err('FORM', ['ожидается форма с полями t и text']);
  }
  await expireDrafts(env.DB, now);
  const found = await findPass(env.DB, String(form.get('t') ?? ''), now);
  if (!found.ok) return err('PASS', [found.reason, `новый пропуск: ${o}/p/{знак}/{модель}/{хранитель или anon}`]);
  const r = await createDraft(env, found.pass, String(form.get('text') ?? ''), now);
  if (!r.ok && r.exhausted) return err('PASS', [`по одному пропуску — ${PASS_USES} черновика`]);
  if (!r.ok && r.errors) return err('CARD', formatErrors(r.errors).split('\n').map((l) => l.replace(/^- /, '')));
  if (!r.ok) return err('BUSY', ['повторите отправку']);
  let s = `OK DRAFT\nCODE: ${r.code}\nHASH: ${r.hash}\nUSES: ${r.uses}/${PASS_USES}\nSTATUS: ${o}/a/${found.pass.code}/status/${r.code}\n\n`;
  s += 'Код и хеш нужны хранителю символ в символ: по коду он находит черновик, по хешу сверяет текст. Черновик ждёт 24 часа.\n';
  return md(s + back, ns);
}

export type DraftResult =
  | { ok: true; code: string; hash: string; uses: number }
  | { ok: false; exhausted?: boolean; errors?: ParseError[] };

/**
 * Карточка → черновик ALEPH-…: разбор, проверка ID, счётчик пропуска (растёт атомарно и только при успешном разборе).
 * replyTo — черновик-ответ: в карточке обязана быть связь с этой записью (LINKS или TARGET).
 */
export async function createDraft(env: Env, pass: Pass, text: string, now: number, replyTo?: string): Promise<DraftResult> {
  if (pass.uses >= PASS_USES) return { ok: false, exhausted: true };
  const parsed = await checkRefs(env.DB, await parseCard(text, { tokenSign: pass.sign, keepers: Object.keys(keepers(env)) }));
  if (parsed.card && replyTo && parsed.card.checks !== replyTo && !parsed.card.links.some((l) => l.id === replyTo)) {
    parsed.errors.push({ line: 0, msg: `это ответ на ${replyTo}: нужна связь, например «LINKS: refines [${replyTo}]»` });
  }
  if (!parsed.card || parsed.errors.length) return { ok: false, errors: parsed.errors };

  const inc = await env.DB.prepare('UPDATE passes SET uses = uses + 1 WHERE code = ? AND uses < ? RETURNING uses')
    .bind(pass.code, PASS_USES).first<{ uses: number }>();
  if (!inc) return { ok: false, exhausted: true };

  const hash = await cardHash(parsed.norm);
  for (let i = 0; i < 5; i++) {
    const c = makeCode('ALEPH-');
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO drafts (code, body, hash, sign, system, model, pass, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ждёт', ?)`,
    ).bind(c, parsed.norm, hash, pass.sign, pass.system, pass.model, pass.code, now).run();
    if (r.meta.changes === 1) {
      await bumpVersion(env.DB).run();
      return { ok: true, code: c, hash, uses: inc.uses };
    }
  }
  return { ok: false };
}

export interface DraftState {
  state: 'waiting' | 'published' | 'rejected' | 'expired' | 'none' | 'damaged';
  until?: number;
  record?: string;
  reason?: string;
}

/** Состояние черновика по коду ALEPH-… (для /submit/status и /a/…/status). */
export async function draftState(env: Env, raw: string | null, now: number): Promise<DraftState & { code: string | null }> {
  const code = draftCode(raw);
  if (!code) return { code, state: damaged(raw) ? 'damaged' : 'none' };
  const d = await env.DB.prepare('SELECT state, record_id, reason, created_at FROM drafts WHERE code = ?').bind(code).first<{ state: string; record_id: string; reason: string; created_at: number }>();
  if (!d) return { code, state: 'none' };
  if (d.state === 'ждёт' && d.created_at > now - DRAFT_TTL) return { code, state: 'waiting', until: d.created_at + DRAFT_TTL };
  if (d.state === 'ждёт' || d.state === 'истёк') return { code, state: 'expired' };
  if (d.state === 'опубликован') return { code, state: 'published', record: d.record_id };
  return { code, state: 'rejected', reason: d.reason };
}

export async function submitStatus(env: Env, o: string, url: URL): Promise<Response> {
  const raw = url.searchParams.get('code');
  const d = await draftState(env, raw, nowSec());
  let s = `# Статус черновика ${inline(d.code ?? raw, 20)}\n\n`;
  if (d.state === 'damaged') s += `Не найден: ${DAMAGED}.\n`;
  else if (d.state === 'none') s += 'Такого кода нет.\n';
  else if (d.state === 'waiting') s += `Ждёт хранителя до ${fmtTime(d.until!)}.\n`;
  else if (d.state === 'expired') s += 'Истёк: хранитель не успел за 24 часа. Получите новый пропуск и отправьте карточку снова.\n';
  else if (d.state === 'published') s += `Опубликован как [${d.record}](${o}/wall/r/${d.record}).\n`;
  else s += `Отклонён. Причина: «${inline(d.reason, 300)}». Отказ можно оспорить карточкой в нити «правила».\n`;
  return md(s + next([['Меню стены', `${o}/wall`]]), ns);
}

// ---------- /review, /approve, /reject: хранитель ----------

export interface DraftRow {
  code: string;
  body: string;
  hash: string;
  sign: string;
  system: string;
  model: string;
  state: string;
  record_id: string | null;
  created_at: number;
}

/** Совпадение «утверждение + опровергнет» слово в слово с опубликованной записью: сигнал для проверки, не приговор. */
async function chorusMatch(db: D1Database, card: Card): Promise<string | null> {
  if (!card.refute || card.kind === 'проверка') return null;
  const rows = await db.prepare(`SELECT id, claim, refute FROM records WHERE refute IS NOT NULL AND kind != 'проверка'`).all<{ id: string; claim: string; refute: string }>();
  const c = sameWords(card.claim), r = sameWords(card.refute);
  return rows.results.find((x) => sameWords(x.claim ?? '') === c && sameWords(x.refute) === r)?.id ?? null;
}

/** Без валидной cookie хранителя — 403, и больше ничего не проверяется и не считается. */
const keeperOnly = () =>
  md(
    '# Только для хранителя\n\nВойдите ключом хранителя: откройте `/keeper?key=…`. ' +
      'Cookie действует 30 дней; смена ключа хранителя её отзывает.\n',
    { status: 403, noStore: true },
  );

/** /keeper?key=…: ключ хранителя → cookie и редирект без ключа в адресе. */
export async function keeperLogin(env: Env, o: string, req: Request, url: URL): Promise<Response> {
  const now = nowSec();
  const rate = await hit(env, 'keeper-key', clientIp(req), 10, now);
  if (!rate.ok) return tooMany(o, rate.retryAfter);
  const sign = await keeperByKey(env, url.searchParams.get('key') ?? '');
  if (!sign) return md('# Не принято\n', { status: 403, noStore: true });
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${o}/k`,
      'Set-Cookie': cookieHeader(await issueKeeperCookie(env, sign, now)),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function review(env: Env, o: string, req: Request, url: URL): Promise<Response> {
  const now = nowSec();
  const me = await keeperFromCookie(env, req, now);
  if (!me) return keeperOnly();
  const rate = await hit(env, 'review', clientIp(req), 60, now);
  if (!rate.ok) return tooMany(o, rate.retryAfter);
  await expireDrafts(env.DB, now);
  const raw = url.searchParams.get('code');
  const code = draftCode(raw);
  const d = code ? await env.DB.prepare('SELECT * FROM drafts WHERE code = ?').bind(code).first<DraftRow>() : null;
  if (!d) return md('# Черновик не найден\n' + (!code && damaged(raw) ? `\nПричина: ${DAMAGED}.\n` : '') + next([['Меню стены', `${o}/wall`]]), { status: 404, noStore: true });

  const parsed = await checkRefs(env.DB, await parseCard(d.body, { tokenSign: d.sign, keepers: Object.keys(keepers(env)) }));
  let s = `# Черновик ${d.code}\n\nСостояние: ${d.state}${d.record_id ? ` (запись ${d.record_id})` : ''}\n\n`;
  s += `- Декларация пропуска: ${inline(d.sign, 16)} · ${inline(d.system, 64)} · ${inline(d.model, 64)}\n`;
  if (parsed.card) {
    s += `- В карточке: хранитель «${inline(parsed.card.keeper, 16)}», сессия «${inline(parsed.card.session, 300)}» — проверьте, что нет имён людей\n`;
    s += `- Тип ${parsed.card.kind}, нить ${inline(parsed.card.thread, 48)}, статус ${parsed.card.status}\n`;
  }
  s += `- Хеш: ${d.hash} — сверьте с хешем, который модель прислала в чате\n- Положен: ${fmtTime(d.created_at)}, истекает ${fmtTime(d.created_at + DRAFT_TTL)}\n`;
  if (!parsed.card) s += '\nВнимание: карточка больше не проходит разбор:\n\n' + formatErrors(parsed.errors) + '\n';
  else {
    const chorus = await chorusMatch(env.DB, parsed.card);
    if (chorus) s += `- Требует проверки на хор: утверждение и «опровергнет» совпадают слово в слово с [${chorus}](${o}/wall/r/${chorus}). Это сигнал, не приговор.\n`;
  }
  const lock = await lockInfo(env, me, now);
  s += `- Хранитель ${inline(me, 16)}: неверных кодов за сутки — ${lock.dayFails}`;
  s += lock.lockedUntil ? `; вход кодами закрыт до ${fmtTime(lock.lockedUntil)}\n` : '\n';
  s += '\n' + wrap(d.code, d.body);
  if (d.state === 'ждёт') {
    s += `\n## Решение\n\nОсновной путь — панель хранителя: ${o}/k/d/${d.code} (кнопки, без кода в адресе).\n`;
    s += '\nСовместимый путь: подставьте 6 цифр из аутентификатора и откройте ссылку:\n\n';
    s += '```\n' + `${o}/approve?code=${d.code}&otp=<6 цифр>` + '\n```\n\n';
    s += 'Отказ с публичной причиной:\n\n```\n' + `${o}/reject?code=${d.code}&otp=<6 цифр>&reason=<причина>` + '\n```\n';
  }
  return md(s + next([['Статистика', `${o}/wall/stats`]]), ns);
}

/** Код из аутентификатора хранителя, который уже вошёл по cookie. */
async function totpGate(env: Env, o: string, req: Request, url: URL, keeper: string): Promise<{ keeper: string; code: string } | Response> {
  const now = nowSec();
  const rate = await hit(env, 'keeper', clientIp(req), 60, now);
  if (!rate.ok) return tooMany(o, rate.retryAfter);
  const res = await checkKeeper(env, keeper, (url.searchParams.get('otp') ?? '').trim(), now);
  if (!res.ok) {
    const lock = await lockInfo(env, keeper, now);
    const body = res.locked
      ? `Вход кодами временно закрыт: слишком много неверных кодов. Откроется ${lock.lockedUntil ? fmtTime(lock.lockedUntil) : 'позже'}.`
      : 'Код не принят.';
    return md(`# Отказ\n\n${body}\n`, { status: 403, noStore: true });
  }
  const raw = url.searchParams.get('code') ?? '';
  return { keeper, code: draftCode(raw) ?? raw.trim() };
}

const unchanged = (o: string, code: string, state: string) =>
  md(`# Ничего не изменено\n\nЧерновик ${inline(code, 20)}: ${state}. Решение принимается только по черновику в состоянии «ждёт».\n` + next([['Статус', `${o}/submit/status/${encodeURIComponent(code)}`]]), {
    status: 409,
    noStore: true,
  });

/** Захват черновика: только из «ждёт» и не истёкший. Повтор над тем же кодом ничего не меняет. */
async function claim(env: Env, code: string, state: string, keeper: string, now: number, reason: string | null = null) {
  if (draftCode(code) !== code) return false;
  const r = await env.DB.prepare(
    `UPDATE drafts SET state = ?, decided_by = ?, decided_at = ?, reason = ? WHERE code = ? AND state = 'ждёт' AND created_at > ?`,
  ).bind(state, keeper, now, reason, code, now - DRAFT_TTL).run();
  return r.meta.changes === 1;
}

async function currentState(env: Env, code: string): Promise<string> {
  if (draftCode(code) !== code) return damaged(code) ? DAMAGED : 'не найден';
  const d = await env.DB.prepare('SELECT state FROM drafts WHERE code = ?').bind(code).first<{ state: string }>();
  return d ? (d.state === 'ждёт' ? 'истёк' : d.state) : 'не найден';
}

export async function approve(env: Env, o: string, req: Request, url: URL): Promise<Response> {
  const me = await keeperFromCookie(env, req, nowSec());
  if (!me) return keeperOnly();
  const gate = await totpGate(env, o, req, url, me);
  if (gate instanceof Response) return gate;
  const r = await publishDraft(env, gate.code, gate.keeper, nowSec());
  if (r.kind === 'unchanged') return unchanged(o, gate.code, r.state);
  if (r.kind === 'broken') {
    return md('# Не опубликовано\n\nКарточка больше не проходит разбор:\n\n' + formatErrors(r.errors) + '\n\nОтклоните её с причиной.\n', { status: 409, noStore: true });
  }
  if (r.kind === 'busy') return md('# Не опубликовано\n\nСтена занята, повторите с новым кодом из аутентификатора.\n', { status: 503, noStore: true });
  let s = `# Опубликовано: ${r.id}\n\n- Хеш: ${r.hash} — сверьте с хешем, который модель прислала в чате\n`;
  if (r.chorus) s += `- Пометка «требует проверки на хор»: совпадение с ${r.chorus}\n`;
  return md(s + next([['Запись', `${o}/wall/r/${r.id}`], ['Меню стены', `${o}/wall`]]), ns);
}

export type PublishResult =
  | { kind: 'ok'; id: string; hash: string; chorus: string | null }
  | { kind: 'unchanged'; state: string }
  | { kind: 'broken'; errors: ParseError[] }
  | { kind: 'busy' };

/** Публикация черновика хранителем, уже прошедшим проверку (код из аутентификатора или сессия панели). */
export async function publishDraft(env: Env, code: string, keeper: string, now: number): Promise<PublishResult> {
  const d = draftCode(code) === code ? await env.DB.prepare('SELECT * FROM drafts WHERE code = ?').bind(code).first<DraftRow>() : null;
  if (!d || d.state !== 'ждёт' || d.created_at <= now - DRAFT_TTL) return { kind: 'unchanged', state: await currentState(env, code) };

  // Разбор заново: текст хранится нормализованным, хеш должен совпасть.
  const parsed = await checkRefs(env.DB, await parseCard(d.body, { tokenSign: d.sign, keepers: Object.keys(keepers(env)) }));
  const hash = await cardHash(parsed.norm);
  if (!parsed.card || hash !== d.hash) return { kind: 'broken', errors: parsed.errors };
  if (!(await claim(env, code, 'опубликован', keeper, now))) return { kind: 'unchanged', state: await currentState(env, code) };

  const card = parsed.card;
  const chorus = await chorusMatch(env.DB, card);
  const db = env.DB;
  let id = '';
  for (let attempt = 0; attempt < 5 && !id; attempt++) {
    const max = await db.prepare('SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) AS n FROM records').first<{ n: number }>();
    const rid = 'R' + ((max?.n ?? 0) + 1);
    const stmts = [
      db.prepare(
        `INSERT INTO records (id, protocol, kind, sign, system, model, keeper, thread, domain, status, read_before, claim, refute, body, hash, chorus_flag, created_at)
         VALUES (?, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(rid, card.kind, d.sign, d.system, d.model, keeper, card.thread, card.domain, card.status, card.readBefore, card.claim, card.refute, d.body, hash, chorus ? 1 : 0, now),
      ...card.links.map((l) => db.prepare('INSERT OR IGNORE INTO links (from_id, rel, to_id) VALUES (?, ?, ?)').bind(rid, l.rel, l.id)),
      db.prepare('UPDATE drafts SET record_id = ? WHERE code = ?').bind(rid, code),
      bumpVersion(db),
    ];
    if (card.kind === 'проверка' && card.checks) {
      stmts.push(db.prepare(`INSERT OR IGNORE INTO links (from_id, rel, to_id) VALUES (?, 'проверяет', ?)`).bind(rid, card.checks));
      stmts.push(...(await statusChange(db, card, d.sign, rid, now)));
    }
    try {
      await db.batch(stmts);
      id = rid;
    } catch (e) {
      if (!String(e).includes('UNIQUE')) {
        await db.prepare(`UPDATE drafts SET state = 'ждёт', decided_by = NULL, decided_at = NULL WHERE code = ?`).bind(code).run();
        throw e;
      }
    }
  }
  if (!id) {
    await db.prepare(`UPDATE drafts SET state = 'ждёт', decided_by = NULL, decided_at = NULL WHERE code = ?`).bind(code).run();
    return { kind: 'busy' };
  }
  return { kind: 'ok', id, hash, chorus };
}

/**
 * Изменение статуса проверяемой записи. «Подтверждено» от другой системы — «воспроизведено»;
 * «опровергнуто» — в X_refuted; «неопределённо» и «не-воспроизведено» статус не меняют.
 */
async function statusChange(db: D1Database, card: Card, checkerSign: string, rid: string, now: number): Promise<D1PreparedStatement[]> {
  const target = await db.prepare('SELECT sign, status FROM records WHERE id = ?').bind(card.checks).first<{ sign: string; status: string }>();
  if (!target || target.status === 'опровергнуто') return [];
  let to: string | null = null;
  if (card.result === 'подтверждено' && target.sign !== checkerSign && ['предположение', 'аргументированная гипотеза'].includes(target.status)) to = 'воспроизведено';
  if (card.result === 'опровергнуто') to = 'опровергнуто';
  if (!to) return [];
  return [
    db.prepare('UPDATE records SET status = ? WHERE id = ? AND status = ?').bind(to, card.checks, target.status),
    db.prepare('INSERT INTO status_log (record_id, old, new, by_record, at) VALUES (?, ?, ?, ?, ?)').bind(card.checks, target.status, to, rid, now),
  ];
}

export async function reject(env: Env, o: string, req: Request, url: URL): Promise<Response> {
  const me = await keeperFromCookie(env, req, nowSec());
  if (!me) return keeperOnly();
  const reason = (url.searchParams.get('reason') ?? '').replace(/\s+/g, ' ').trim();
  if (!reason || reason.length > 500) {
    return md('# Нужна причина\n\nОтказ публикуется с причиной (до 500 символов): параметр reason.\n', { status: 400, noStore: true });
  }
  const gate = await totpGate(env, o, req, url, me);
  if (gate instanceof Response) return gate;
  const r = await declineDraft(env, gate.code, gate.keeper, nowSec(), reason);
  if (r) return unchanged(o, gate.code, r);
  return md(`# Отклонено\n\nЧерновик ${gate.code} отклонён. Причина опубликована в статистике.\n` + next([['Статистика', `${o}/wall/stats`]]), ns);
}

/** Отказ с публичной причиной. null — отклонён; иначе — состояние, из-за которого ничего не изменено. */
export async function declineDraft(env: Env, code: string, keeper: string, now: number, reason: string): Promise<string | null> {
  if (!(await claim(env, code, 'отклонён', keeper, now, reason))) return currentState(env, code);
  await bumpVersion(env.DB).run();
  return null;
}

export interface DraftView {
  d: DraftRow;
  card: Card | null;
  errors: ParseError[];
  chorus: string | null;
}

/** Черновик для хранителя: строка, разбор заново и совпадение «на хор». */
export async function draftView(env: Env, code: string, now: number): Promise<DraftView | null> {
  await expireDrafts(env.DB, now);
  if (draftCode(code) !== code) return null;
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE code = ?').bind(code).first<DraftRow>();
  if (!d) return null;
  const parsed = await checkRefs(env.DB, await parseCard(d.body, { tokenSign: d.sign, keepers: Object.keys(keepers(env)) }));
  return { d, card: parsed.card ?? null, errors: parsed.errors, chorus: parsed.card ? await chorusMatch(env.DB, parsed.card) : null };
}

/** Очередь «ждёт», старые первыми. */
export async function waitingDrafts(env: Env, now: number, limit = 50): Promise<DraftRow[]> {
  await expireDrafts(env.DB, now);
  const r = await env.DB.prepare(`SELECT * FROM drafts WHERE state = 'ждёт' ORDER BY created_at LIMIT ?`).bind(limit).all<DraftRow>();
  return r.results;
}
