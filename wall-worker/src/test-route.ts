import { cardHash, checkRefs, formatErrors, parseCard } from './card';
import { b64url, enc, Env, hex, hmacSha256, keepers, md, randomBytes, render, timingSafeEqual } from './util';
import step1 from './pages/test-1.md';
import step2 from './pages/test-2.md';
import step3 from './pages/test-3.md';
import step4 from './pages/test-4.md';
import step5 from './pages/test-5.md';

// Тестовый маршрут /wall/test: пять шагов, в базу ничего не пишется.
// Метка (nonce) — случайная часть и её подпись TOKEN_KEY; учебные код и хеш выводятся из метки той же подписью.

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

async function sig(env: Env, purpose: string, value: string): Promise<Uint8Array> {
  return hmacSha256(env.TOKEN_KEY, `test|${purpose}|${value}`);
}

async function newNonce(env: Env): Promise<string> {
  const r = b64url(randomBytes(9));
  return r + '.' + b64url((await sig(env, 'nonce', r)).slice(0, 12));
}

async function nonceOk(env: Env, n: string): Promise<boolean> {
  const m = /^([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{16})$/.exec(n);
  if (!m) return false;
  return timingSafeEqual(enc.encode(b64url((await sig(env, 'nonce', m[1])).slice(0, 12))), enc.encode(m[2]));
}

async function testCode(env: Env, n: string): Promise<{ code: string; hash: string }> {
  const c = await sig(env, 'code', n);
  const code = 'ALEPH-' + Array.from(c.slice(0, 8), (b) => CODE_ALPHABET[b % 31]).join('');
  const hash = hex(await sig(env, 'hash', n)).slice(0, 12);
  return { code, hash };
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

export async function wallTest(env: Env, o: string, step: string, req: Request, url: URL): Promise<Response> {
  const BASE = o;
  const given = url.searchParams.get('n') ?? '';
  // Без метки или с поддельной меткой шаг всё равно открывается, но со свежей меткой.
  const valid = await nonceOk(env, given);
  const NONCE = valid ? given : await newNonce(env);
  const ns = { noStore: true };

  switch (step) {
    case '':
    case '1':
      return md(render(step1, { BASE, NONCE }), ns);
    case '2':
      return md(render(step2, { BASE, NONCE, NONCE_OK: valid, FILLER: filler() }), ns);
    case '3': {
      const { code, hash } = await testCode(env, NONCE);
      return md(render(step3, { BASE, NONCE, TEST_CODE: code, TEST_HASH: hash }), ns);
    }
    case '4': {
      const { code, hash } = await testCode(env, NONCE);
      const ok = valid && url.searchParams.get('code') === code && url.searchParams.get('hash') === hash;
      return md(render(step4, { BASE, NONCE, COPY_OK: ok }), ns);
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
      }
      result += `\n\nДлина полученного адреса: ${bytes} байт.`;
      return md(render(step5, { BASE, PARSE_RESULT: result }), ns);
    }
  }
  return md(`# Нет такого шага\n\n## Куда дальше\n\n- [Проверка инструментов](${o}/wall/test)\n`, { status: 404 });
}
