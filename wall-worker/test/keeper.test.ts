import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { issueKeeperCookie, lockDuration } from '../src/keeper';
import { b64url, hmacSha256 } from '../src/util';

const TAG = () => JSON.parse(env.KEEPERS)['🜄'].key_sha256.slice(0, 8) as string;
import { card, get, kget, otp, submitOk } from './helpers';

// Два слоя защиты хранителя: ключ → cookie; TOTP с нарастающей блокировкой.

const now = () => Math.floor(Date.now() / 1000);
const counters = async () => ({
  lock: (await env.DB.prepare('SELECT COUNT(*) AS n FROM keeper_lock').first<{ n: number }>())!.n,
  otp: (await env.DB.prepare('SELECT COUNT(*) AS n FROM otp_used').first<{ n: number }>())!.n,
});
const lockRow = () => env.DB.prepare('SELECT * FROM keeper_lock').first<{ fails: number; level: number; locked_until: number | null; day_fails: number }>();
const wrongOtp = async () => ((await otp()) === '000000' ? '111111' : '000000');

describe('Слой 1: ключ хранителя и cookie', () => {
  it('верный ключ → cookie и редирект 303 на /wall без ключа', async () => {
    const res = await get(`/keeper?key=${encodeURIComponent(env.TEST_KEEPER_KEY)}`, {}, 'manual');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('https://sdominanta.net/wall');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const c = res.headers.get('Set-Cookie')!;
    expect(c).toMatch(/^__Host-keeper=[\w-]+\.[\w-]+; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    expect(c).not.toContain(env.TEST_KEEPER_KEY);
  });

  it('неверный или пустой ключ → «не принято», без cookie', async () => {
    for (const key of ['', 'неверный', env.TEST_KEEPER_KEY + 'x']) {
      const res = await get(`/keeper?key=${encodeURIComponent(key)}`, {}, 'manual');
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('# Не принято\n');
      expect(res.headers.get('Set-Cookie')).toBeNull();
    }
  });

  it('/keeper — не больше 10 попыток в час с IP', async () => {
    const ip = { 'CF-Connecting-IP': '198.51.100.9' };
    for (let i = 0; i < 10; i++) expect((await get('/keeper?key=x', ip, 'manual')).status).toBe(403);
    expect((await get(`/keeper?key=${encodeURIComponent(env.TEST_KEEPER_KEY)}`, ip, 'manual')).status).toBe(429);
  });

  it('без cookie /review, /approve, /reject → 403, TOTP не проверяется, счётчики не меняются', async () => {
    const { code } = await submitOk(card());
    const good = await otp();
    for (const p of [`/review?code=${code}`, `/approve?code=${code}&otp=${good}`, `/approve?code=${code}&otp=000000`, `/reject?code=${code}&otp=${good}&reason=x`]) {
      const res = await get(p);
      expect(res.status, p).toBe(403);
      expect(await res.text(), p).toContain('Только для хранителя');
    }
    expect(await counters()).toEqual({ lock: 0, otp: 0 });
    expect((await env.DB.prepare('SELECT state FROM drafts').first<{ state: string }>())!.state).toBe('ждёт');
  });

  it('поддельная, просроченная или чужая cookie → 403', async () => {
    const { code } = await submitOk(card());
    const forge = async (payload: string, key = env.TOKEN_KEY) =>
      `__Host-keeper=${b64url(new TextEncoder().encode(payload))}.${b64url(await hmacSha256(key, 'keeper|' + payload))}`;
    const cookies = [
      await forge(`🜄|${now() + 3600}|${TAG()}`, 'чужой ключ'), // подпись не тем ключом
      '__Host-keeper=' + (await issueKeeperCookie(env, '🜄', now() - 31 * 24 * 3600)), // истекла
      await forge(`🜁|${now() + 3600}|${TAG()}`), // не хранитель
      await forge(`🜄|${now() + 3600}|${TAG()}|x`), // лишнее поле
      await forge(`🜄|${now() + 3600}`), // без отпечатка ключа
      await forge(`🜄|${now() + 3600}|00000000`), // ключ хранителя сменился: старая cookie отозвана
      (await forge(`🜄|${now() + 3600}|${TAG()}`)).slice(0, -2), // испорчена подпись
    ];
    for (const c of cookies) {
      expect((await get(`/review?code=${code}`, { Cookie: c })).status, c).toBe(403);
      expect((await get(`/approve?code=${code}&otp=${await otp()}`, { Cookie: c })).status, c).toBe(403);
    }
    expect(await counters()).toEqual({ lock: 0, otp: 0 });
    // Контроль: настоящая cookie той же формы открывает /review.
    expect((await get(`/review?code=${code}`, { Cookie: await forge(`🜄|${now() + 3600}|${TAG()}`) })).status).toBe(200);
  });
});

describe('Слой 2: нарастающая блокировка', () => {
  it('15 мин → 30 мин → …; уровень сбрасывается только верным кодом', async () => {
    const { code } = await submitOk(card());
    const wrong = await wrongOtp();
    const fiveWrong = async () => {
      for (let i = 0; i < 5; i++) await kget(`/approve?code=${code}&otp=${wrong}`);
    };

    await fiveWrong();
    let r = (await lockRow())!;
    expect(r.level).toBe(1);
    expect(r.locked_until! - now()).toBeGreaterThan(15 * 60 - 5);
    expect(r.locked_until! - now()).toBeLessThanOrEqual(15 * 60);

    // Блокировка истекла — следующая серия даёт вдвое дольше.
    await env.DB.prepare('UPDATE keeper_lock SET locked_until = ?').bind(now() - 1).run();
    await fiveWrong();
    r = (await lockRow())!;
    expect(r.level).toBe(2);
    expect(r.locked_until! - now()).toBeGreaterThan(30 * 60 - 5);

    // Верный код во время блокировки не проходит и уровень не сбрасывает.
    expect((await kget(`/approve?code=${code}&otp=${await otp()}`)).status).toBe(403);
    expect((await lockRow())!.level).toBe(2);

    // После блокировки верный код проходит и сбрасывает уровень.
    await env.DB.prepare('UPDATE keeper_lock SET locked_until = ?').bind(now() - 1).run();
    expect((await kget(`/approve?code=${code}&otp=${await otp()}`)).status).toBe(200);
    r = (await lockRow())!;
    expect(r).toMatchObject({ level: 0, fails: 0, locked_until: null });
    expect(r.day_fails).toBe(10);
  });

  it('потолок — 24 часа', () => {
    expect([0, 1, 2, 6, 7, 30].map(lockDuration)).toEqual([900, 1800, 3600, 57600, 86400, 86400]);
  });

  it('/review показывает число неверных кодов за сутки', async () => {
    const { code } = await submitOk(card());
    const wrong = await wrongOtp();
    for (let i = 0; i < 3; i++) await kget(`/approve?code=${code}&otp=${wrong}`);
    expect(await (await kget(`/review?code=${code}`)).text()).toContain('неверных кодов за сутки — 3');
    // Сутки прошли — счёт начинается заново.
    await env.DB.prepare('UPDATE keeper_lock SET day_start = day_start - 86400').run();
    expect(await (await kget(`/review?code=${code}`)).text()).toContain('неверных кодов за сутки — 0');
  });
});
