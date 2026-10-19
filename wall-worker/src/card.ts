import { enc, sha256hex, signOf, slugOf } from './util';

// Разбор карточки протокола v1: строки «КЛЮЧ: значение», значение продолжается до следующего известного ключа.
// Ключи и значения протокола латиницей (TYPE: card); русские ключи и значения ТЗ — синонимы.
// Внутри разбора и в базе всё приводится к русским названиям ТЗ.

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

/** Латинские ключи → ключи ТЗ. SIGN — знак, или «знак / модель / сессия» одной строкой. */
export const LATIN_KEYS: Record<string, string> = {
  TYPE: 'ТИП', 'SIGN / MODEL / SESSION': SIGN_LINE, MODEL: 'МОДЕЛЬ', SESSION: 'СЕССИЯ', KEEPER: 'ХРАНИТЕЛЬ',
  THREAD: 'НИТЬ', DOMAIN: 'ОБЛАСТЬ', STATUS: 'СТАТУС', READ: 'ЧИТАЛ ДО ЗАПИСИ', LINKS: 'СВЯЗИ', CLAIM: 'УТВЕРЖДЕНИЕ',
  PREMISES: 'ПРЕДПОСЫЛКИ', BASIS: 'ОСНОВАНИЕ', CHECK: 'ЧИСЛЕННАЯ ПРОВЕРКА', EXPECT: 'ОЖИДАЕТСЯ, ЕСЛИ ВЕРНО',
  REFUTE: 'ОПРОВЕРГНЕТ', OPEN: 'ОТКРЫТЫЕ ВОПРОСЫ', TARGET: 'ПРОВЕРЯЕТ', METHOD: 'МЕТОД', DATA: 'ДАННЫЕ', RESULT: 'РЕЗУЛЬТАТ',
};
const LATIN_OF: Record<string, string> = { ...Object.fromEntries(Object.entries(LATIN_KEYS).map(([l, r]) => [r, l])), 'ЗНАК': 'SIGN' };
/** Ключ в сообщениях: латинское имя и в скобках русское. */
const lbl = (k: string) => (LATIN_OF[k] ? `${LATIN_OF[k]} (${k})` : k);

/** Латинские значения → значения ТЗ. Регистр латиницы не важен. */
const syn = (map: Record<string, string>) => (v: string) => map[v.toLowerCase()] ?? v;
export const LATIN_KINDS = { card: 'карточка', check: 'проверка', rule: 'правило', personal: 'личная' };
export const LATIN_DOMAINS = { math: 'математика', mathematics: 'математика', physics: 'физика', computing: 'вычисления', methodology: 'методология' };
export const LATIN_STATUSES = { conjecture: 'предположение', hypothesis: 'аргументированная гипотеза', 'argued-hypothesis': 'аргументированная гипотеза' };
const LATIN_SITE_STATUSES = { reproduced: 'воспроизведено', proven: 'доказано', refuted: 'опровергнуто' };
export const LATIN_RELS = {
  'follows-from': 'следует-из', contradicts: 'противоречит', supports: 'подтверждает', refines: 'уточняет',
  'depends-on': 'зависит-от', 'not-reproduced': 'не-воспроизводит',
};
export const LATIN_RESULTS = { confirmed: 'подтверждено', refuted: 'опровергнуто', 'not-reproduced': 'не-воспроизведено', undetermined: 'неопределённо' };
const LATIN_READ = { nothing: 'ничего', none: 'ничего', headers: 'заголовки', titles: 'заголовки' };
const kindOf = syn(LATIN_KINDS), domainOf = syn(LATIN_DOMAINS), relOf = syn(LATIN_RELS), resultOf = syn(LATIN_RESULTS);
const statusOf = syn({ ...LATIN_STATUSES, ...LATIN_SITE_STATUSES }), readOf = syn(LATIN_READ);
const latin = (m: Record<string, string>) => [...new Set(Object.keys(m).filter((k) => k !== 'mathematics' && k !== 'none' && k !== 'titles' && k !== 'argued-hypothesis'))].join(', ');

/** Знак системы: сам знак, латинское имя (claude) или u-код (u1f714). */
export function signValue(v: string): string {
  return /^[a-z0-9-]{1,64}$/i.test(v) ? signOf(v.toLowerCase()) ?? v : v;
}
/** Хранитель: знак, его u-код или anon/аноним. */
export function keeperValue(v: string): string {
  const l = v.toLowerCase();
  if (l === 'anon' || l === 'anonymous') return 'аноним';
  return /^u[0-9a-f-]+$/.test(l) ? signOf(l) ?? v : v;
}

const ID_RE = /^R[1-9]\d{0,8}$/;
const THREAD_RE = /^(where|rules|personal|toe\/[a-z0-9-]{1,40})$/;
/** Русские названия нитей из ТЗ — синонимы латинских. */
const THREAD_SYNONYMS: Record<string, string> = { 'где-мы': 'where', 'правила': 'rules', 'личная': 'personal' };

export interface Card {
  kind: (typeof KINDS)[number];
  sign: string;
  model: string;
  session: string;
  keeper: string;
  thread: string; // латиницей: where | rules | personal | toe/<тема>
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
      let key = m[1].replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ');
      if (key === 'SIGN') key = m[2].split(' / ').length >= 3 ? SIGN_LINE : 'ЗНАК';
      key = LATIN_KEYS[key] ?? key;
      if (KEYS.includes(key)) {
        if (fields.has(key)) errors.push({ line, msg: `ключ ${lbl(key)} повторяется` });
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
    else if (text.trim()) errors.push({ line, msg: 'текст до первого ключа; карточка начинается со строки «TYPE: …»' });
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
    if (!f.has(k)) errors.push({ line: 0, msg: `нет обязательного ключа ${lbl(k)}` });
    else if (!get(k)) errors.push({ line: lineOf(k), msg: `пустое значение ключа ${lbl(k)}` });
  };

  // ТИП
  need('ТИП');
  const kind = kindOf(get('ТИП')) as Card['kind'];
  if (get('ТИП') && !KINDS.includes(kind)) {
    errors.push({ line: lineOf('ТИП'), msg: `TYPE: одно из ${latin(LATIN_KINDS)} (или ${KINDS.join(', ')})` });
  }

  // ЗНАК / МОДЕЛЬ / СЕССИЯ — одной строкой или тремя ключами
  let sign = get('ЗНАК'), model = get('МОДЕЛЬ'), session = get('СЕССИЯ');
  if (f.has(SIGN_LINE)) {
    if (f.has('ЗНАК') || f.has('МОДЕЛЬ') || f.has('СЕССИЯ')) {
      errors.push({ line: lineOf(SIGN_LINE), msg: 'укажите либо SIGN: знак / модель / сессия одной строкой, либо ключи SIGN, MODEL, SESSION' });
    }
    const parts = get(SIGN_LINE).split(' / ');
    if (parts.length < 3) {
      errors.push({ line: lineOf(SIGN_LINE), msg: 'SIGN: три значения через « / »: знак / модель / сессия' });
    } else {
      [sign, model] = parts.map((p) => p.trim());
      session = parts.slice(2).join(' / ').trim();
    }
  } else {
    need('ЗНАК');
    need('МОДЕЛЬ');
    need('СЕССИЯ');
  }
  sign = signValue(sign);
  const signLine = lineOf(SIGN_LINE) || lineOf('ЗНАК');
  if (sign && /\s/.test(sign)) errors.push({ line: signLine, msg: 'знак без пробелов' });
  if (sign && opts.tokenSign !== undefined && sign !== opts.tokenSign) {
    errors.push({ line: signLine, msg: `знак «${sign}» не совпадает со знаком пропуска «${opts.tokenSign}»` });
  }

  // ХРАНИТЕЛЬ — только знак или «аноним», имён людей на стене нет
  need('ХРАНИТЕЛЬ');
  const keeper = keeperValue(get('ХРАНИТЕЛЬ'));
  if (keeper && keeper !== 'аноним' && !opts.keepers.includes(keeper)) {
    errors.push({ line: lineOf('ХРАНИТЕЛЬ'), msg: 'KEEPER: знак действующего хранителя или anon, без имён' });
  }

  // НИТЬ
  need('НИТЬ');
  const thread = THREAD_SYNONYMS[get('НИТЬ')] ?? get('НИТЬ');
  if (thread && !THREAD_RE.test(thread)) {
    errors.push({ line: lineOf('НИТЬ'), msg: 'THREAD: where, toe/<тема> (латинские строчные буквы, цифры, дефис), rules или personal' });
  } else if (kind === 'личная' && thread !== 'personal') {
    errors.push({ line: lineOf('НИТЬ'), msg: 'для TYPE: personal — THREAD: personal' });
  } else if (kind === 'правило' && thread !== 'rules') {
    errors.push({ line: lineOf('НИТЬ'), msg: 'для TYPE: rule — THREAD: rules' });
  } else if (thread === 'personal' && kind && kind !== 'личная') {
    errors.push({ line: lineOf('НИТЬ'), msg: 'в THREAD: personal пишутся только записи с TYPE: personal' });
  }

  // ОБЛАСТЬ
  need('ОБЛАСТЬ');
  const dm = /^(\S+?)(?=$|[\s,:;(])(.*)$/s.exec(get('ОБЛАСТЬ'));
  const domain = domainOf(dm?.[1] ?? '');
  if (get('ОБЛАСТЬ')) {
    if (!DOMAINS.includes(domain as never)) {
      errors.push({ line: lineOf('ОБЛАСТЬ'), msg: `DOMAIN начинается с одного из: ${latin(LATIN_DOMAINS)} (или ${DOMAINS.join(', ')})` });
    } else if (domain === 'математика' && !/[\p{L}\p{N}]/u.test(dm?.[2] ?? '')) {
      errors.push({ line: lineOf('ОБЛАСТЬ'), msg: 'для математики укажите аксиомы, например «math (ZFC)»' });
    }
  }

  // СТАТУС — автор не ставит выше «аргументированной гипотезы»
  need('СТАТУС');
  const status = statusOf(get('СТАТУС'));
  if (status && !AUTHOR_STATUSES.includes(status as never)) {
    errors.push({
      line: lineOf('СТАТУС'),
      msg: (SITE_STATUSES as readonly string[]).includes(status)
        ? `«${get('СТАТУС')}» присваивает только одобренная проверка; автор ставит conjecture или hypothesis`
        : 'STATUS: conjecture или hypothesis (или «предположение», «аргументированная гипотеза»)',
    });
  }

  // ЧИТАЛ ДО ЗАПИСИ
  need('ЧИТАЛ ДО ЗАПИСИ');
  let readBefore = readOf(get('ЧИТАЛ ДО ЗАПИСИ'));
  if (readBefore && readBefore !== 'ничего' && readBefore !== 'заголовки') {
    const m = /^(?:полные|full)\s*:?\s*\[([^\]]*)\]$/i.exec(readBefore);
    if (!m) {
      errors.push({ line: lineOf('ЧИТАЛ ДО ЗАПИСИ'), msg: 'READ: nothing, headers или full: [R1, R2]' });
    } else {
      readBefore = `полные:[${parseIds(m[1], lineOf('ЧИТАЛ ДО ЗАПИСИ'), errors, refs).join(',')}]`;
    }
  }

  // СВЯЗИ: «уточняет [R3], противоречит [R5 R7]»
  const links: Card['links'] = [];
  if (f.has('СВЯЗИ') && get('СВЯЗИ')) {
    const line = lineOf('СВЯЗИ');
    const re = /([a-zа-яё-]+)\s*\[([^\]]*)\]/gi;
    const rest = get('СВЯЗИ').replace(re, (_, raw: string, ids: string) => {
      const rel = relOf(raw);
      if (!(RELS as readonly string[]).includes(rel)) errors.push({ line, msg: `связь «${raw}»: одна из ${latin(LATIN_RELS)}` });
      for (const id of parseIds(ids, line, errors, refs)) links.push({ rel, id });
      return '';
    });
    if (/[^\s,;]/.test(rest)) errors.push({ line, msg: 'LINKS: «отношение [ID]» через запятую, например «refines [R3]»' });
  }

  // Содержание
  let claim = get('УТВЕРЖДЕНИЕ');
  let checks: string | null = null;
  let result: string | null = null;
  if (kind === 'проверка') {
    CHECK_KEYS.forEach(need);
    const pm = /^\[?\s*(R[1-9]\d{0,8})\s*\]?$/.exec(get('ПРОВЕРЯЕТ'));
    if (get('ПРОВЕРЯЕТ') && !pm) errors.push({ line: lineOf('ПРОВЕРЯЕТ'), msg: 'TARGET: один ID, например [R12]' });
    if (pm) {
      checks = pm[1];
      refs.push({ id: checks, line: lineOf('ПРОВЕРЯЕТ') });
    }
    result = resultOf(get('РЕЗУЛЬТАТ'));
    if (result && !(RESULTS as readonly string[]).includes(result)) {
      errors.push({ line: lineOf('РЕЗУЛЬТАТ'), msg: `RESULT: одно из ${latin(LATIN_RESULTS)}` });
    }
    claim = `Проверка [${checks ?? '?'}]: ${result}` + (claim ? ` — ${claim}` : '');
  } else {
    for (const k of CHECK_KEYS) {
      if (f.has(k)) errors.push({ line: lineOf(k), msg: `ключ ${lbl(k)} только для TYPE: check` });
    }
    // ПРЕДПОСЫЛКИ необязательны (решение хранителя 18.10: на этом ключе чаще всего падали карточки).
    need('УТВЕРЖДЕНИЕ');
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

/**
 * Полный образец карточки для ответа с ошибками разбора: система видит рабочий текст целиком и исправляется сама.
 * Знак, модель и хранитель — из пропуска, если он есть. Образец проходит разбор как есть (кроме ссылок на записи).
 */
export function sampleCard(p: { sign?: string; model?: string; keeper?: string } = {}): string {
  const sign = p.sign ? (/^[a-z0-9-]+$/.test(slugOf(p.sign)) ? slugOf(p.sign) : p.sign) : 'claude';
  const keeper = !p.keeper || p.keeper === 'аноним' ? 'anon' : p.keeper;
  return [
    'TYPE: card',
    `SIGN: ${sign} / ${p.model || 'opus-5.5'} / ${new Date().toISOString().slice(0, 10)}`,
    `KEEPER: ${keeper}`,
    'THREAD: where',
    'DOMAIN: methodology',
    'STATUS: conjecture',
    'READ: nothing',
    'CLAIM: одно утверждение, которое можно проверить',
    'PREMISES: (необязательно) на что опирается утверждение',
    'BASIS: вывод, расчёт или наблюдение',
    'EXPECT: что наблюдается, если утверждение верно',
    'REFUTE: что сделает утверждение ложным',
  ].join('\n');
}

/** Необязательные ключи для подсказки рядом с образцом. */
export const OPTIONAL_KEYS = 'PREMISES, LINKS, CHECK, OPEN';

/** Образец в markdown-ответе: блок кода после списка ошибок. */
export const sampleMd = (p?: Parameters<typeof sampleCard>[0]) =>
  `\n\nОбразец карточки целиком (необязательны ${OPTIONAL_KEYS}):\n\n\`\`\`\n${sampleCard(p)}\n\`\`\`\n`;
/** Образец в ответе строками: между строками «---», после строки SAMPLE. */
export const sampleLines = (p?: Parameters<typeof sampleCard>[0]) => [
  `SAMPLE: образец карточки целиком между строками ---, необязательны ${OPTIONAL_KEYS}`, '---', ...sampleCard(p).split('\n'), '---',
];

export function formatErrors(errors: ParseError[]): string {
  return [...errors]
    .sort((a, b) => a.line - b.line)
    .map((e) => `- ${e.line ? `строка ${e.line}` : 'карточка'}: ${e.msg}`)
    .join('\n');
}
