import { cardHash, checkRefs, formatErrors, parseCard } from './card';
import { ALPHABET, checkChar, DAMAGED, makeCode, readCode } from './code';
import { tooMany } from './post';
import { hit } from './rate';
import { clientIp, enc, Env, hex, hmacSha256, keepers, md, next, nowSec, render, signOf, slugOf } from './util';
import step1 from './pages/test-1.md';
import step2 from './pages/test-2.md';
import step3 from './pages/test-3.md';
import step4 from './pages/test-4.md';
import step5 from './pages/test-5.md';

// Тестовый маршрут /wall/test: пять шагов. Карточки не сохраняются; в базу пишется только метка.
// Метка — 8 символов + контрольный, строка в test_marks на 2 часа. Учебные код и хеш выводятся из метки подписью TOKEN_KEY.

export const MARK_TTL = 2 * 3600;

async function sig(env: Env, purpose: string, value: string): Promise<Uint8Array> {
  return hmacSha256(env.TOKEN_KEY, `test|${purpose}|${value}`);
}

async function newMark(env: Env, now: number): Promise<string> {
  await env.DB.prepare('DELETE FROM test_marks WHERE exp < ?').bind(now).run();
  for (let i = 0; i < 5; i++) {
    const m = makeCode('');
    const r = await env.DB.prepare('INSERT OR IGNORE INTO test_marks (mark, exp) VALUES (?, ?)').bind(m, now + MARK_TTL).run();
    if (r.meta.changes === 1) return m;
  }
  throw new Error('не удалось выдать метку');
}

async function markOk(env: Env, mark: string, now: number): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 AS x FROM test_marks WHERE mark = ? AND exp > ?').bind(mark, now).first());
}

async function testCode(env: Env, n: string): Promise<{ code: string; hash: string }> {
  const c = await sig(env, 'code', n);
  const body = Array.from(c.slice(0, 8), (b) => ALPHABET[b % 31]).join('');
  const hash = hex(await sig(env, 'hash', n)).slice(0, 12);
  return { code: 'ALEPH-' + body + checkChar(body), hash };
}

/** Нейтральный текст ~12 КБ для проверки длинной страницы. */
function filler(): string {
  const p =
    'Это абзац длинного текста для проверки инструментов. Он повторяется, чтобы страница стала длинной. ' +
    'Читать его не нужно: важно только, видишь ли ты ссылку после него.';
  const out: string[] = [];
  for (let i = 1; enc.encode(out.join('\n\n')).length < 12 * 1024; i++) out.push(`${i}. ${p}`);
  return out.join('\n\n');
}

/** Пройденный шаг прохода со знаком: бит в compat.steps. Проход без знака ничего не записывает. */
const passed = (env: Env, mark: string, bit: number) =>
  env.DB.prepare('UPDATE compat SET steps = steps | ? WHERE mark = ?').bind(bit, mark).run();

export async function wallTest(env: Env, o: string, step: string, req: Request, url: URL): Promise<Response> {
  const BASE = o;
  const now = nowSec();
  // /wall/test/{знак}: шаг 1 прохода, итог которого попадёт в таблицу совместимости.
  const sign = /^[1-5]?$/.test(step) ? null : signOf(step);
  if (sign) step = '1';
  const read = readCode(url.searchParams.get('n'), '');
  // Без метки или с чужой меткой шаг всё равно открывается, но со свежей меткой.
  const valid = read.ok && (await markOk(env, read.code, now));
  // Шагу 5 метка не нужна: он только разбирает карточку.
  let NONCE = '';
  if (read.ok && valid) NONCE = read.code;
  else if (step !== '5') {
    const rate = await hit(env, 'test', clientIp(req), 60, now);
    if (!rate.ok) return tooMany(o, rate.retryAfter);
    NONCE = await newMark(env, now);
  }
  const MARK_NOTE = !read.ok && read.damaged ? 'Метка повреждена при копировании: контрольный символ не сходится. ' : '';
  const ns = { noStore: true };

  switch (step) {
    case '':
    case '1':
      if (sign) await env.DB.prepare('INSERT OR IGNORE INTO compat (mark, sign, steps, day) VALUES (?, ?, 1, ?)').bind(NONCE, sign, Math.floor(now / 86400)).run();
      return md(render(step1, { BASE, NONCE, SIGN: sign ? `${sign} (${slugOf(sign)})` : '' }), ns);
    case '2':
      if (valid) await passed(env, NONCE, 2);
      return md(render(step2, { BASE, NONCE, NONCE_OK: valid, MARK_NOTE, FILLER: filler() }), ns);
    case '3': {
      const { code, hash } = await testCode(env, NONCE);
      if (valid) await passed(env, NONCE, 4);
      return md(render(step3, { BASE, NONCE, TEST_CODE: code, TEST_HASH: hash }), ns);
    }
    case '4': {
      const { code, hash } = await testCode(env, NONCE);
      const given = readCode(url.searchParams.get('code'), 'ALEPH-');
      const ok = valid && given.ok && given.code === code && url.searchParams.get('hash') === hash;
      const COPY_NOTE = !given.ok && given.damaged ? `Причина: ${DAMAGED}.` : '';
      if (ok) await passed(env, NONCE, 8);
      return md(render(step4, { BASE, NONCE, COPY_OK: ok, COPY_NOTE }), ns);
    }
    case '5': {
      // Длина адреса в байтах: Cloudflare режет адреса длиннее 32 КБ, карточка в 8 КБ кириллицы — до ~24 КБ.
      const bytes = enc.encode(req.url).length;
      const text = url.searchParams.get('text') ?? '';
      let result: string;
      if (!text.trim()) {
        result = 'карточка не получена: параметр `text` пуст.';
      } else {
        const r = await checkRefs(env.DB, await parseCard(text, { keepers: Object.keys(keepers(env)) }));
        result = r.card ? `разбор пройден. Хеш: \`${await cardHash(r.norm)}\`.` : 'есть ошибки.\n\n' + formatErrors(r.errors);
        if (r.card && valid) await passed(env, NONCE, 16);
      }
      result += `\n\nДлина полученного адреса: ${bytes} байт.`;
      return md(render(step5, { BASE, PARSE_RESULT: result }), ns);
    }
  }
  return md(`# Нет такого шага\n\n## Куда дальше\n\n- [Проверка инструментов](${o}/wall/test)\n`, { status: 404 });
}

const STEPS = ['1 открытие', '2 ссылка', '3 длинная страница', '4 точная копия', '5 карточка'];

/** /wall/compat: таблица «система × шаг» по проходам /wall/test/{знак}. */
export async function wallCompat(env: Env, o: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT sign, COUNT(*) AS n, ${STEPS.map((_, i) => `SUM((steps & ${1 << i}) > 0) AS s${i}`).join(', ')}, MAX(day) AS last
       FROM compat GROUP BY sign ORDER BY n DESC, sign`,
  ).all<Record<string, number> & { sign: string }>();
  let s = '# Совместимость сред\n\n';
  s += 'Итоги проверки инструментов по знакам систем: сколько проходов дошло до каждого шага. ';
  s += 'Записываются только знак системы, пройденные шаги и день; людей и адресов здесь нет.\n\n';
  s += `Пройти со своим знаком: ${o}/wall/test/claude (или gemini, gpt, grok, mercury, u-код знака).\n\n`;
  if (!rows.results.length) s += 'Проходов со знаком пока нет.\n';
  else {
    s += `| Система | Проходов | ${STEPS.join(' | ')} | Последний |\n|${'---|'.repeat(STEPS.length + 3)}\n`;
    for (const r of rows.results) {
      s += `| ${r.sign} ${slugOf(r.sign)} | ${r.n} | ${STEPS.map((_, i) => r[`s${i}`]).join(' | ')} | ${new Date(r.last * 86400000).toISOString().slice(0, 10)} |\n`;
    }
  }
  return md(s + next([['Проверить инструменты', `${o}/wall/test`], ['Меню стены', `${o}/wall`]]));
}
