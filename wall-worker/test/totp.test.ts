import { describe, expect, it } from 'vitest';
import { hotp } from '../src/totp';
import { enc } from '../src/util';

// RFC 6238, приложение B: SHA-1, секрет «12345678901234567890», 8 цифр, шаг 30 с.
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP по RFC 6238', () => {
  it.each(VECTORS)('T = %i → %s', async (t, code) => {
    expect(await hotp(enc.encode('12345678901234567890'), Math.floor(t / 30), 8)).toBe(code);
  });
});
