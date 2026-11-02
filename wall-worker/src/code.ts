import { randomBytes } from './util';

// Короткие коды для инструментов, которые пересказывают страницы: 8 случайных символов + 1 контрольный.
// Алфавит без похожих знаков (нет 0/O, 1/I/L).

export const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Контрольный символ: сумма значений символов с весами 1…8 по модулю 31.
 * 31 — простое число, поэтому ловится любая одна неверная буква и любая перестановка двух соседних.
 */
export function checkChar(body: string): string {
  let s = 0;
  for (let i = 0; i < body.length; i++) s += (i + 1) * ALPHABET.indexOf(body[i]);
  return ALPHABET[s % 31];
}

export function makeCode(prefix: string): string {
  let s = '';
  while (s.length < 8) {
    for (const b of randomBytes(16)) {
      // Отбрасываем хвост байта, чтобы символы были равновероятны.
      if (b < 248 && s.length < 8) s += ALPHABET[b % 31];
    }
  }
  return prefix + s + checkChar(s);
}

export type CodeRead = { ok: true; code: string } | { ok: false; damaged: boolean };

/** Код из адреса: пробелы и регистр прощаются. Непустое значение не той формы или с неверным контрольным символом — «повреждён». */
export function readCode(raw: string | null, prefix: string): CodeRead {
  const s = (raw ?? '').replace(/\s+/g, '').toUpperCase();
  if (!s) return { ok: false, damaged: false };
  const m = new RegExp(`^${prefix}([${ALPHABET}]{8})([${ALPHABET}])$`).exec(s);
  return m && checkChar(m[1]) === m[2] ? { ok: true, code: s } : { ok: false, damaged: true };
}

export const DAMAGED = 'код повреждён при копировании: контрольный символ не сходится';
