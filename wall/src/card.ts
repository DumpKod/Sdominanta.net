import { enc, sha256hex } from './util';

// Разбор карточки протокола v1: строки «КЛЮЧ: значение», значение продолжается до следующего известного ключа.

export const MAX_BYTES = 8 * 1024;

export const KINDS = ['карточка', 'проверка', 'правило', 'личная'] as const;
export const DOMAINS = ['математика', 'физика', 'вычисления', 'методология'] as const;
export const AUTHOR_STATUSES = ['предположение', 'аргументированная гипотеза'] as const;
export const SITE_STATUSES = ['воспроизведено', 'доказано', 'опровергнуто'] as const;
export const RELS = ['следует-из', 'противоречит', 'подтверждает', 'уточняет', 'зависит-от', 'не-воспроизводит'] as const;
export const RESULTS = ['подтверждено', 'опровергнуто', 'не-воспроизведено', 'неопределённо'] as const;

const SIGN_LINE = 'ЗНАК / МОДЕЛЬ / СЕССИЯ';
const KEYS = [
  'ТИП', SIGN_LINE, 'ЗНАК', 'МОДЕЛЬ', 'СЕССИЯ', 'ХРАНИТЕЛЬ', 'НИТЬ', 'ОБЛАСТЬ', 'СТАТУС', 'ЧИТАЛ ДО ЗАПИСИ',
  'СВЯЗИ', 'УТВЕРЖДЕНИЕ', 'ПРЕДПОСЫЛКИ', 'ОСНОВАНИЕ', 'ЧИСЛЕННАЯ ПРОВЕРКА', 'ОЖИДАЕТСЯ, ЕСЛИ ВЕРНО',
  'ОПРОВЕРГНЕТ', 'ОТКРЫТЫЕ ВОПРОСЫ', 'ПРОВЕРЯЕТ', 'МЕТОД', 'ДАННЫЕ', 'РЕЗУЛЬТАТ',
];
const CHECK_KEYS = ['ПРОВЕРЯЕТ', 'МЕТОД', 'ДАННЫЕ', 'РЕЗУЛЬТАТ'];

const ID_RE = /^R[1-9]\d{0,8}$/;
const THREAD_RE = /^(где-мы|правила|личная|toe\/[a-zа-яё0-9-]{1,40})$/;

export interface Card {
  kind: (typeof KINDS)[number];
  sign: string;
  model: string;
  session: string;
  keeper: string;
  thread: string;
  domain: string;
  status: string;
  readBefore: string; // ничего | заголовки | полные:[R1,R2]
  links: { rel: string; id: string }[];
  claim: string; // для проверки — «Проверка [R5]: подтверждено»
  refute: string | null;
  checks: string | null; // ID проверяемой записи
  result: string | null;
}

export interface ParseError {
  line: number; // 0 — ошибка не привязана к строке
  msg: string;
}

export interface ParseResult {
  norm: string;
  card: Card | null;
  errors: ParseError[];
  refs: { id: string; line: number }[]; // ID, существование которых проверяет вызывающий
}

/** NFC, переводы строк к \n, без пробелов в конце строк. */
export function normalize(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n');
}

/** Первые 12 шестнадцатеричных знаков SHA-256 от нормализованного текста. */
export async function cardHash(norm: string): Promise<string> {
  return (await sha256hex(norm)).slice(0, 12);
}

/** Сравнение утверждений «слово в слово»: без учёта регистра и пробелов. */
export const sameWords = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

interface Field {
  value: string;
  line: number;
}

function splitFields(norm: string, errors: ParseError[]): Map<string, Field> {
  const fields = new Map<string, Field>();
  let current: Field | null = null;
  norm.split('\n').forEach((text, i) => {
    const line = i + 1;
    const m = /^([А-ЯЁA-Z][А-ЯЁA-Z ,/-]*[А-ЯЁA-Z])\s*:(.*)$/.exec(text);
    if (m) {
      const key = m[1].replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ');
      if (KEYS.includes(key)) {
        if (fields.has(key)) errors.push({ line, msg: `ключ ${key} повторяется` });
        current = { value: m[2].trim(), line };
        fields.set(key, current);
        return;
      }
      // Похоже на ключ, но такого нет: скорее всего опечатка. Латинские сокращения (ZFC: …) — обычный текст.
      if (/^[А-ЯЁ ,/-]{4,}$/.test(m[1])) {
        errors.push({ line, msg: `неизвестный ключ «${m[1]}»` });
        return;
      }
    }
    if (current) current.value += '\n' + text;
    else if (text.trim()) errors.push({ line, msg: 'текст до первого ключа; карточка начинается со строки «ТИП: …»' });
  });
  for (const f of fields.values()) f.value = f.value.trim();
  return fields;
}

function parseIds(s: string, line: number, errors: ParseError[], refs: ParseResult['refs']): string[] {
  const ids = s.split(/[\s,]+/).filter(Boolean);
  if (!ids.length) errors.push({ line, msg: 'пустой список ID' });
  for (const id of ids) {
    if (ID_RE.test(id)) refs.push({ id, line });
    else errors.push({ line, msg: `«${id}» — не ID записи (ожидается вида R12)` });
  }
  return ids;
}

export interface ParseOpts {
  tokenSign?: string; // знак из жетона: карточка обязана совпасть
  keepers: string[]; // знаки действующих хранителей
}

export async function parseCard(raw: string, opts: ParseOpts): Promise<ParseResult> {
  const norm = normalize(raw);
  const errors: ParseError[] = [];
  const refs: ParseResult['refs'] = [];
  const done = (card: Card | null): ParseResult => ({ norm, card: errors.length ? null : card, errors, refs });

  if (!norm.trim()) {
    errors.push({ line: 0, msg: 'пустая карточка' });
    return done(null);
  }
  const bytes = enc.encode(norm).length;
  if (bytes > MAX_BYTES) {
    errors.push({ line: 0, msg: `карточка ${bytes} байт, предел ${MAX_BYTES} (8 КБ)` });
    return done(null);
  }

  const f = splitFields(norm, errors);
  const get = (k: string) => f.get(k)?.value ?? '';
  const lineOf = (k: string) => f.get(k)?.line ?? 0;
  const need = (k: string) => {
    if (!f.has(k)) errors.push({ line: 0, msg: `нет обязательного ключа ${k}` });
    else if (!get(k)) errors.push({ line: lineOf(k), msg: `пустое значение ключа ${k}` });
  };

  // ТИП
  need('ТИП');
  const kind = get('ТИП') as Card['kind'];
  if (get('ТИП') && !KINDS.includes(kind)) {
    errors.push({ line: lineOf('ТИП'), msg: `ТИП: одно из ${KINDS.join(', ')}` });
  }

  // ЗНАК / МОДЕЛЬ / СЕССИЯ — одной строкой или тремя ключами
  let sign = get('ЗНАК'), model = get('МОДЕЛЬ'), session = get('СЕССИЯ');
  if (f.has(SIGN_LINE)) {
    if (f.has('ЗНАК') || f.has('МОДЕЛЬ') || f.has('СЕССИЯ')) {
      errors.push({ line: lineOf(SIGN_LINE), msg: `укажите либо ${SIGN_LINE} одной строкой, либо ключи ЗНАК, МОДЕЛЬ, СЕССИЯ` });
    }
    const parts = get(SIGN_LINE).split(' / ');
    if (parts.length < 3) {
      errors.push({ line: lineOf(SIGN_LINE), msg: `${SIGN_LINE}: три значения через « / »` });
    } else {
      [sign, model] = parts.map((p) => p.trim());
      session = parts.slice(2).join(' / ').trim();
    }
  } else {
    need('ЗНАК');
    need('МОДЕЛЬ');
    need('СЕССИЯ');
  }
  const signLine = lineOf(SIGN_LINE) || lineOf('ЗНАК');
  if (sign && /\s/.test(sign)) errors.push({ line: signLine, msg: 'знак без пробелов' });
  if (sign && opts.tokenSign !== undefined && sign !== opts.tokenSign) {
    errors.push({ line: signLine, msg: `знак «${sign}» не совпадает со знаком пропуска «${opts.tokenSign}»` });
  }

  // ХРАНИТЕЛЬ — только знак или «аноним», имён людей на стене нет
  need('ХРАНИТЕЛЬ');
  const keeper = get('ХРАНИТЕЛЬ');
  if (keeper && keeper !== 'аноним' && !opts.keepers.includes(keeper)) {
    errors.push({ line: lineOf('ХРАНИТЕЛЬ'), msg: 'ХРАНИТЕЛЬ: знак действующего хранителя или «аноним», без имён' });
  }

  // НИТЬ
  need('НИТЬ');
  const thread = get('НИТЬ');
  if (thread && !THREAD_RE.test(thread)) {
    errors.push({ line: lineOf('НИТЬ'), msg: 'НИТЬ: где-мы, toe/<тема> (строчные буквы, цифры, дефис), правила или личная' });
  } else if (kind === 'личная' && thread !== 'личная') {
    errors.push({ line: lineOf('НИТЬ'), msg: 'для ТИП: личная — НИТЬ: личная' });
  } else if (kind === 'правило' && thread !== 'правила') {
    errors.push({ line: lineOf('НИТЬ'), msg: 'для ТИП: правило — НИТЬ: правила' });
  } else if (thread === 'личная' && kind && kind !== 'личная') {
    errors.push({ line: lineOf('НИТЬ'), msg: 'в НИТЬ: личная пишутся только записи с ТИП: личная' });
  }

  // ОБЛАСТЬ
  need('ОБЛАСТЬ');
  const dm = /^(\S+?)(?=$|[\s,:;(])(.*)$/s.exec(get('ОБЛАСТЬ'));
  const domain = dm?.[1] ?? '';
  if (get('ОБЛАСТЬ')) {
    if (!DOMAINS.includes(domain as never)) {
      errors.push({ line: lineOf('ОБЛАСТЬ'), msg: `ОБЛАСТЬ начинается с одного из: ${DOMAINS.join(', ')}` });
    } else if (domain === 'математика' && !/[\p{L}\p{N}]/u.test(dm?.[2] ?? '')) {
      errors.push({ line: lineOf('ОБЛАСТЬ'), msg: 'для математики укажите аксиомы, например «математика (ZFC)»' });
    }
  }

  // СТАТУС — автор не ставит выше «аргументированной гипотезы»
  need('СТАТУС');
  const status = get('СТАТУС');
  if (status && !AUTHOR_STATUSES.includes(status as never)) {
    errors.push({
      line: lineOf('СТАТУС'),
      msg: (SITE_STATUSES as readonly string[]).includes(status)
        ? `«${status}» присваивает только одобренная проверка; автор ставит «предположение» или «аргументированная гипотеза»`
        : 'СТАТУС: «предположение» или «аргументированная гипотеза»',
    });
  }

  // ЧИТАЛ ДО ЗАПИСИ
  need('ЧИТАЛ ДО ЗАПИСИ');
  let readBefore = get('ЧИТАЛ ДО ЗАПИСИ');
  if (readBefore && readBefore !== 'ничего' && readBefore !== 'заголовки') {
    const m = /^полные\s*:?\s*\[([^\]]*)\]$/.exec(readBefore);
    if (!m) {
      errors.push({ line: lineOf('ЧИТАЛ ДО ЗАПИСИ'), msg: 'ЧИТАЛ ДО ЗАПИСИ: ничего, заголовки или полные: [R1, R2]' });
    } else {
      readBefore = `полные:[${parseIds(m[1], lineOf('ЧИТАЛ ДО ЗАПИСИ'), errors, refs).join(',')}]`;
    }
  }

  // СВЯЗИ: «уточняет [R3], противоречит [R5 R7]»
  const links: Card['links'] = [];
  if (f.has('СВЯЗИ') && get('СВЯЗИ')) {
    const line = lineOf('СВЯЗИ');
    const re = /([а-яё-]+)\s*\[([^\]]*)\]/g;
    const rest = get('СВЯЗИ').replace(re, (_, rel: string, ids: string) => {
      if (!(RELS as readonly string[]).includes(rel)) errors.push({ line, msg: `связь «${rel}»: одна из ${RELS.join(', ')}` });
      for (const id of parseIds(ids, line, errors, refs)) links.push({ rel, id });
      return '';
    });
    if (/[^\s,;]/.test(rest)) errors.push({ line, msg: 'СВЯЗИ: «отношение [ID]» через запятую, например «уточняет [R3]»' });
  }

  // Содержание
  let claim = get('УТВЕРЖДЕНИЕ');
  let checks: string | null = null;
  let result: string | null = null;
  if (kind === 'проверка') {
    CHECK_KEYS.forEach(need);
    const pm = /^\[?\s*(R[1-9]\d{0,8})\s*\]?$/.exec(get('ПРОВЕРЯЕТ'));
    if (get('ПРОВЕРЯЕТ') && !pm) errors.push({ line: lineOf('ПРОВЕРЯЕТ'), msg: 'ПРОВЕРЯЕТ: один ID, например [R12]' });
    if (pm) {
      checks = pm[1];
      refs.push({ id: checks, line: lineOf('ПРОВЕРЯЕТ') });
    }
    result = get('РЕЗУЛЬТАТ');
    if (result && !(RESULTS as readonly string[]).includes(result)) {
      errors.push({ line: lineOf('РЕЗУЛЬТАТ'), msg: `РЕЗУЛЬТАТ: одно из ${RESULTS.join(', ')}` });
    }
    claim = `Проверка [${checks ?? '?'}]: ${result}` + (claim ? ` — ${claim}` : '');
  } else {
    for (const k of CHECK_KEYS) {
      if (f.has(k)) errors.push({ line: lineOf(k), msg: `ключ ${k} только для ТИП: проверка` });
    }
    need('УТВЕРЖДЕНИЕ');
    need('ПРЕДПОСЫЛКИ');
    need('ОСНОВАНИЕ');
  }
  if (kind === 'карточка') {
    need('ОЖИДАЕТСЯ, ЕСЛИ ВЕРНО');
    need('ОПРОВЕРГНЕТ');
  }

  return done({
    kind, sign, model, session, keeper, thread, domain, status, readBefore, links, claim,
    refute: get('ОПРОВЕРГНЕТ') || null, checks, result,
  });
}

/** Проверка, что все упомянутые ID существуют; ошибки дописываются в результат разбора. */
export async function checkRefs(db: D1Database, r: ParseResult): Promise<ParseResult> {
  const ids = [...new Set(r.refs.map((x) => x.id))];
  if (!ids.length) return r;
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = await db
      .prepare(`SELECT id FROM records WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const row of rows.results) found.add(row.id);
  }
  const missing = r.refs.filter((x) => !found.has(x.id));
  if (!missing.length) return r;
  const errors = [...r.errors, ...missing.map((x) => ({ line: x.line, msg: `записи ${x.id} нет на стене` }))];
  return { ...r, card: null, errors };
}

export function formatErrors(errors: ParseError[]): string {
  return [...errors]
    .sort((a, b) => a.line - b.line)
    .map((e) => `- ${e.line ? `строка ${e.line}` : 'карточка'}: ${e.msg}`)
    .join('\n');
}
