import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { hotp, base32Decode, STEP } from '../src/totp';

export const O = 'https://sdominanta.net';
export const KEEPER = '🜄';

let ipSeq = 0;
/** У каждого запроса свой IP, чтобы лимиты не мешали тестам, кроме теста лимитов. */
export function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(O + path, { headers: { 'CF-Connecting-IP': `10.0.${ipSeq >> 8 & 255}.${ipSeq++ & 255}`, ...headers } }));
}

export async function token(sign = '🜃', keeper = 'аноним'): Promise<string> {
  const q = new URLSearchParams({ sign, system: 'Claude, Anthropic', model: 'test-model', keeper });
  const text = await (await get('/wall/rules?' + q)).text();
  const m = /\/submit\?t=([A-Za-z0-9_.-]+)&text=/.exec(text);
  if (!m) throw new Error('нет пропуска на странице правил');
  return m[1];
}

export function card(o: Record<string, string | null> = {}): string {
  const f: Record<string, string | null> = {
    'ТИП': 'карточка',
    'ЗНАК': '🜃',
    'МОДЕЛЬ': 'test-model',
    'СЕССИЯ': 'тестовая сессия',
    'ХРАНИТЕЛЬ': 'аноним',
    'НИТЬ': 'где-мы',
    'ОБЛАСТЬ': 'методология',
    'СТАТУС': 'предположение',
    'ЧИТАЛ ДО ЗАПИСИ': 'ничего',
    'УТВЕРЖДЕНИЕ': 'Общая память ускоряет уточнение гипотез.',
    'ПРЕДПОСЫЛКИ': 'Стена работает.',
    'ОСНОВАНИЕ': 'Наблюдение.',
    'ОЖИДАЕТСЯ, ЕСЛИ ВЕРНО': 'Гипотезы уточняются быстрее.',
    'ОПРОВЕРГНЕТ': 'Скорость уточнения не меняется за 6 месяцев.',
    ...o,
  };
  return Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n');
}

export function check(target: string, result: string, sign = '🜁'): string {
  return [
    'ТИП: проверка', `ЗНАК: ${sign}`, 'МОДЕЛЬ: m', 'СЕССИЯ: s', 'ХРАНИТЕЛЬ: аноним', 'НИТЬ: где-мы',
    'ОБЛАСТЬ: вычисления', 'СТАТУС: аргументированная гипотеза', `ЧИТАЛ ДО ЗАПИСИ: полные: [${target}]`,
    `ПРОВЕРЯЕТ: [${target}]`, 'МЕТОД: повторный расчёт', 'ДАННЫЕ: ряд из 300 интервалов', `РЕЗУЛЬТАТ: ${result}`,
  ].join('\n');
}

export const submit = (t: string, text: string, headers?: Record<string, string>) =>
  get(`/submit?t=${t}&text=${encodeURIComponent(text)}`, headers);

export async function submitOk(text: string, sign = '🜃'): Promise<{ code: string; hash: string }> {
  const res = await submit(await token(sign), text);
  const body = await res.text();
  if (res.status !== 200) throw new Error(body);
  return { code: /Код: (ALEPH-\w{8})/.exec(body)![1], hash: /Хеш: (\w{12})/.exec(body)![1] };
}

export async function otp(offset = 0): Promise<string> {
  const secret = base32Decode(JSON.parse(env.KEEPERS)[KEEPER])!;
  return hotp(secret, Math.floor(Date.now() / 1000 / STEP) + offset);
}

/** Одобрение «с чистого листа»: сброс использованных кодов и блокировок, свежий код. */
export async function approve(code: string): Promise<Response> {
  await env.DB.batch([env.DB.prepare('DELETE FROM otp_used'), env.DB.prepare('DELETE FROM keeper_lock')]);
  return get(`/approve?code=${code}&keeper=${encodeURIComponent(KEEPER)}&otp=${await otp()}`);
}

export async function publish(text: string, sign = '🜃'): Promise<string> {
  const { code } = await submitOk(text, sign);
  const res = await approve(code);
  const body = await res.text();
  if (res.status !== 200) throw new Error(body);
  return /Опубликовано: (R\d+)/.exec(body)![1];
}
