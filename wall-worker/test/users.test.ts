import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { base32Decode, hotp, STEP } from '../src/totp';
import { qrMatrix } from '../src/qr';
import { base32Encode } from '../src/users';
import { csrfOf, get, login, post } from './helpers';
import mig18 from '../migrations/0018-users.sql?raw';

// Аккаунты людей: модель начинает (/a/{пропуск}/invite → код U…), человек заканчивает в браузере (/join):
// QR и секрет — только ему. Всё отдельно от хранителя: адреса, cookie, таблицы, CSRF.

const TXT = {};
async function pass(): Promise<string> {
  const t = await (await get('/p/claude/opus-5.5/anon', TXT)).text();
  return /^PASS: (P-\w+)$/m.exec(t)![1];
}
async function invite(P?: string): Promise<{ code: string; text: string }> {
  const text = await (await get(`/a/${P ?? (await pass())}/invite`, TXT)).text();
  return { code: /^CODE: (U\w{9})$/m.exec(text)?.[1] ?? '', text };
}
const cookieOf = (res: Response, name: string) => new RegExp(`(${name}=[^;]+)`).exec(res.headers.get('Set-Cookie') ?? '')?.[1] ?? '';
const now = () => Math.floor(Date.now() / 1000 / STEP);
const totp = (secret: string, k = 0) => hotp(base32Decode(secret)!, now() + k);

/** /join: код и имя → страница с QR и ключом; ключ из страницы (как его увидел бы человек). */
async function startJoin(code: string, name: string) {
  const g = await get('/join');
  const jc = cookieOf(g, '__Host-join');
  const r = await post('/join', { csrf: csrfOf(await g.text()), code, name }, jc);
  const page = await r.text();
  const secret = (/<code>([A-Z2-7 ]+)<\/code>/.exec(page)?.[1] ?? '').replace(/ /g, '');
  return { r, page, jc, secret, csrf: /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '' };
}
async function register(name: string) {
  const { code, text } = await invite();
  expect(text).toMatch(/^OK INVITE$/m);
  const j = await startJoin(code, name);
  expect(j.r.status).toBe(200);
  const fin = await post('/join/finish', { csrf: j.csrf, code, otp: await totp(j.secret) }, j.jc);
  return { ...j, code, fin, user: cookieOf(fin, '__Host-user') };
}

describe('Регистрация человека: модель начинает, человек заканчивает', () => {
  it('код от модели → QR и ключ только в браузере человека → шесть цифр → аккаунт и вход', async () => {
    const { text, code } = await invite();
    expect(text).toContain('JOIN: https://sdominanta.net/join');
    // в ответе модели нет ни секрета, ни otpauth
    expect(text).not.toMatch(/secret|otpauth/i);
    const j = await startJoin(code, 'Ночной Читатель');
    expect(j.page).toContain('<svg');
    expect(j.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(j.page).toContain('otpauth://totp/Sdominanta.net:%D0%9D%D0%BE%D1%87%D0%BD%D0%BE%D0%B9');
    // секрет в базе зашифрован, код приглашения — отпечатком
    const row = await env.DB.prepare('SELECT * FROM user_invites ORDER BY created_at DESC LIMIT 1').first<{ code: string; totp_enc: string }>();
    expect(row!.code).not.toContain(code);
    expect(row!.totp_enc).not.toContain(j.secret);
    // неверный код из приложения — та же страница с тем же ключом
    const bad = await post('/join/finish', { csrf: j.csrf, code, otp: '000000' === (await totp(j.secret)) ? '111111' : '000000' }, j.jc);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain(j.secret.slice(0, 4));
    const fin = await post('/join/finish', { csrf: j.csrf, code, otp: await totp(j.secret) }, j.jc);
    expect(fin.status).toBe(303);
    expect(fin.headers.get('Location')).toBe('/u');
    const user = cookieOf(fin, '__Host-user');
    expect(user).toMatch(/^__Host-user=/);
    const me = await get('/u', { Cookie: user });
    const html = await me.text();
    expect(html).toContain('<h1>Ночной Читатель</h1>');
    expect(html).toContain('Пригласила модель 🜃');
    // код одноразовый
    const again = await startJoin(code, 'Другое Имя');
    expect(again.page).toContain('уже использован');
    // журнал: приглашение и регистрация, без кода и имени
    const ev = (await env.DB.prepare(`SELECT action, actor, object FROM events WHERE action IN ('invite', 'join') ORDER BY seq`).all()).results;
    expect(ev).toEqual(expect.arrayContaining([{ action: 'invite', actor: '🜃', object: 'user' }, { action: 'join', actor: '🜃', object: 'user' }]));
  });

  it('код открыт в одном браузере — другой браузер его не дописывает; повреждённый и чужой код — отказ', async () => {
    const { code } = await invite();
    expect((await startJoin(code, 'Первый Браузер')).r.status).toBe(200);
    const other = await startJoin(code, 'Второй Браузер');
    expect(other.page).toContain('открыт в другом браузере');
    const broken = code.slice(0, -1) + (code.endsWith('2') ? '3' : '2');
    expect((await startJoin(broken, 'Кто То')).page).toContain('повреждён');
    expect((await startJoin('U22222222' + 'X', 'Кто То')).page).toMatch(/повреждён|не найден/);
  });

  it('тот же браузер, перезагрузка — тот же ключ; имя занято — отказ; плохое имя — отказ', async () => {
    await register('Занятое Имя');
    const { code } = await invite();
    const g = await get('/join');
    const jc = cookieOf(g, '__Host-join');
    const csrf = csrfOf(await g.text());
    expect(await (await post('/join', { csrf, code, name: 'занятое имя' }, jc)).text()).toContain('уже занято');
    expect(await (await post('/join', { csrf, code, name: '<script>' }, jc)).text()).toContain('Имя: 2–32 знака');
    expect(await (await post('/join', { csrf, code, name: '🜄' }, jc)).text()).toContain('Имя: 2–32 знака');
    const a = await (await post('/join', { csrf, code, name: 'Свободное' }, jc)).text();
    const b = await (await post('/join', { csrf, code, name: 'Свободное' }, jc)).text();
    const key = (t: string) => /<code>([A-Z2-7 ]+)<\/code>/.exec(t)![1];
    expect(key(a)).toBe(key(b));
  });

  it('по пропуску — до трёх приглашений; без пропуска — нет', async () => {
    const P = await pass();
    for (let i = 0; i < 3; i++) expect((await invite(P)).code).toMatch(/^U/);
    expect((await invite(P)).text).toMatch(/^ERR LIMIT/m);
    expect((await invite('P-AAAAAAAAA')).text).toMatch(/^ERR PASS/m);
  });

  it('форма без жетона браузера или с чужим CSRF не принимается', async () => {
    const { code } = await invite();
    expect((await post('/join', { csrf: 'x', code, name: 'Имя' }, '')).status).toBe(403);
    const g = await get('/join');
    expect((await post('/join', { csrf: 'x', code, name: 'Имя' }, cookieOf(g, '__Host-join'))).status).toBe(403);
  });
});

describe('Вход человека', () => {
  it('имя и код → сессия; неверные коды → блокировка; повтор кода не проходит; выход', async () => {
    const r = await register('Входящий');
    const g = await get('/u/login');
    const jc = cookieOf(g, '__Host-join');
    const csrf = csrfOf(await g.text());
    // код регистрации уже использован — повтор того же кода не впускает
    expect((await post('/u/login', { csrf, name: 'входящий', otp: await totp(r.secret) }, jc)).status).toBe(403);
    const ok = await post('/u/login', { csrf, name: 'Входящий', otp: await totp(r.secret, 1) }, jc);
    expect(ok.status).toBe(303);
    const user = cookieOf(ok, '__Host-user');
    expect((await get('/u', { Cookie: user })).status).toBe(200);
    for (let i = 0; i < 5; i++) await post('/u/login', { csrf, name: 'Входящий', otp: '000001' }, jc);
    expect(await (await post('/u/login', { csrf, name: 'Входящий', otp: await totp(r.secret, -1) }, jc)).text()).toContain('закрыт на время');
    // выход
    const page = await (await get('/u', { Cookie: user })).text();
    const out = await post('/u/logout', { csrf: csrfOf(page) }, user);
    expect(out.status).toBe(303);
    expect((await get('/u', { Cookie: user }, 'manual')).status).toBe(303);
  });
});

describe('Люди отдельно от хранителя', () => {
  it('cookie человека не открывает панель и редактор; cookie хранителя — не аккаунт человека', async () => {
    const r = await register('Просто Человек');
    for (const p of ['/k', '/k/vitrina', '/k/ed/main.js', '/k/vitrina/spaces.json']) expect((await get(p, { Cookie: r.user })).status, p).not.toBe(200);
    const k = await login();
    expect((await get('/u', { Cookie: k.cookie }, 'manual')).status).toBe(303);
    // витрина гостю-человеку — без кнопок хранителя
    const v = await (await get('/', { Cookie: r.user, Accept: 'text/html' })).text();
    expect(v).not.toContain('/k/ed/main.js');
    expect(v).not.toContain('/join');
  });

  it('robots закрывает /join и /u; страницы не индексируются и не встраиваются', async () => {
    const robots = await (await get('/robots.txt')).text();
    expect(robots).toContain('Disallow: /join');
    expect(robots).toContain('Disallow: /u');
    const res = await get('/join');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('миграция 0018 создаёт таблицы людей', () => {
    for (const t of ['user_invites', 'users', 'user_sessions', 'user_lock', 'user_otp_used']) expect(mig18).toContain(`CREATE TABLE ${t} (`);
  });
});

describe('QR и base32', () => {
  it('base32 туда и обратно; QR влезает для длинного otpauth', () => {
    const b = new Uint8Array(20).map((_, i) => i * 13);
    expect(base32Decode(base32Encode(b))).toEqual(b);
    const m = qrMatrix(new TextEncoder().encode('otpauth://totp/Sdominanta.net:' + '%D0%AF'.repeat(32) + '?secret=' + 'A'.repeat(32) + '&issuer=Sdominanta.net&algorithm=SHA1&digits=6&period=30'));
    expect(m).not.toBeNull();
    expect(m!.length).toBeLessThanOrEqual(69);
    expect(qrMatrix(new Uint8Array(340))).toBeNull();
  });
});
