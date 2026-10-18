import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { openTotp } from '../src/account';
import { card, get, KEEPER, keeperCookie, O, otp, submitOk } from './helpers';

// Панель хранителя /k: cookie ключа → вход 6 цифрами → сессия; очередь, черновик, кнопки с CSRF, выход и отзыв.

let ip = 0;
function post(path: string, fields: Record<string, string>, cookie: string, headers: Record<string, string> = {}): Promise<Response> {
  return (exports as unknown as { default: Fetcher }).default.fetch(
    new Request(O + path, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams(fields),
      headers: { 'CF-Connecting-IP': `10.9.${(ip >> 8) & 255}.${ip++ & 255}`, Cookie: cookie, Origin: O, ...headers },
    }),
  );
}

const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)![1];
const wrongOtp = async () => ((await otp()) === '000000' ? '111111' : '000000');

/** Вход в панель: cookie ключа + cookie сессии одной строкой для заголовка Cookie. */
async function login(code?: string): Promise<{ cookie: string; session: string }> {
  const key = await keeperCookie();
  const form = await (await get('/k', { Cookie: key })).text();
  const res = await post('/k/login', { csrf: csrfOf(form), otp: code ?? (await otp()) }, key);
  expect(res.status, await res.clone().text()).toBe(303);
  const session = /^(__Host-session=[^;]+)/.exec(res.headers.get('Set-Cookie')!)![1];
  return { cookie: `${key}; ${session}`, session };
}

describe('Панель /k: вход', () => {
  it('без cookie ключа — «не принято»; с поддельной — тоже', async () => {
    for (const c of [undefined, '__Host-keeper=abc.def']) {
      const res = await get('/k', c ? { Cookie: c } : {});
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Не принято');
    }
    expect((await post('/k/login', { otp: await otp() }, '')).status).toBe(403);
  });

  it('cookie ключа без сессии — HTML-форма входа без скриптов; верный код — cookie сессии', async () => {
    const key = await keeperCookie();
    const res = await get('/k', { Cookie: key });
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
    expect(res.headers.get('Content-Security-Policy')).not.toContain('script-src');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const form = await res.text();
    expect(form).toContain('<form method="post" action="/k/login"');
    expect(form).not.toContain('<script');

    const ok = await post('/k/login', { csrf: csrfOf(form), otp: await otp() }, key);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('Location')).toBe(`${O}/k`);
    const sc = ok.headers.get('Set-Cookie')!;
    expect(sc).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);
    // В базе — только отпечаток значения cookie.
    const value = /^__Host-session=([^;]+)/.exec(sc)![1];
    const row = await env.DB.prepare('SELECT id, sign, exp - created_at AS ttl FROM sessions').first<{ id: string; sign: string; ttl: number }>();
    expect(row).toMatchObject({ sign: KEEPER, ttl: 43200 });
    expect(row!.id).not.toBe(value);
  });

  it('аккаунт 🜄 создаётся из KEEPERS; TOTP-секрет в базе зашифрован', async () => {
    await login();
    const acc = await env.DB.prepare('SELECT * FROM accounts').all<{ sign: string; role: string; totp_enc: string; key_sha256: string }>();
    expect(acc.results).toHaveLength(1);
    const a = acc.results[0];
    const k = JSON.parse(env.KEEPERS)[KEEPER];
    expect(a).toMatchObject({ sign: KEEPER, role: 'keeper', key_sha256: k.key_sha256 });
    expect(a.totp_enc).not.toContain(k.totp);
    expect(await openTotp(env, KEEPER, a.totp_enc)).toBe(k.totp);
    expect(await openTotp(env, '🜃', a.totp_enc)).toBeNull(); // знак — часть шифртекста
  });

  it('неверный CSRF, чужой Origin и неверный код не открывают сессию', async () => {
    const key = await keeperCookie();
    const form = await (await get('/k', { Cookie: key })).text();
    expect((await post('/k/login', { csrf: 'x', otp: await otp() }, key)).status).toBe(403);
    expect((await post('/k/login', { csrf: csrfOf(form), otp: await otp() }, key, { Origin: 'https://evil.example' })).status).toBe(403);
    const bad = await post('/k/login', { csrf: csrfOf(form), otp: await wrongOtp() }, key);
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain('Код не принят');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(0);
  });

  it('нарастающая блокировка: 5 неверных кодов закрывают вход, верный код тогда не принимается', async () => {
    const key = await keeperCookie();
    const csrf = csrfOf(await (await get('/k', { Cookie: key })).text());
    for (let i = 0; i < 5; i++) await post('/k/login', { csrf, otp: await wrongOtp() }, key);
    const locked = await post('/k/login', { csrf, otp: await otp() }, key);
    expect(locked.status).toBe(403);
    expect(await locked.text()).toContain('Вход кодами временно закрыт');
    expect(await env.DB.prepare('SELECT level FROM keeper_lock').first('level')).toBe(1);
  });
});

describe('Панель /k: сессия', () => {
  it('очередь и черновик: текст как данные, хеш, декларация, пометка «хор»; одобрение кнопкой', async () => {
    const text = card({ 'УТВЕРЖДЕНИЕ': 'Тег <b>не</b> исполняется.' });
    const { code, hash } = await submitOk(text);
    const { cookie } = await login();
    const queue = await (await get('/k', { Cookie: cookie })).text();
    expect(queue).toContain('ждут решения — 1');
    expect(queue).toContain(`href="/k/d/${code}"`);

    const view = await (await get(`/k/d/${code}`, { Cookie: cookie })).text();
    expect(view).toContain('Тег &lt;b&gt;не&lt;/b&gt; исполняется.');
    expect(view).not.toContain('<b>не</b>');
    expect(view).toContain(hash);
    expect(view).toContain('🜃 · Claude, Anthropic · test-model');
    expect(view).toContain('Хор</th><td>совпадений нет');
    expect(view).toContain('<form method="post" action="/k/approve">');
    expect(view).not.toContain('otp');

    const res = await post('/k/approve', { csrf: csrfOf(view), code }, cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Опубликовано: <a href="/wall/r/R1">R1</a>');
    expect(await env.DB.prepare('SELECT state, decided_by FROM drafts WHERE code = ?').bind(code).first()).toEqual({ state: 'опубликован', decided_by: KEEPER });
    expect((await post('/k/approve', { csrf: csrfOf(view), code }, cookie)).status).toBe(409); // повтор ничего не меняет
  });

  it('совпадение «на хор» помечено в черновике', async () => {
    await submitOk(card()).then(async ({ code }) => {
      const { cookie } = await login();
      const v = await (await get(`/k/d/${code}`, { Cookie: cookie })).text();
      await post('/k/approve', { csrf: csrfOf(v), code }, cookie);
      const again = await submitOk(card({ 'ЗНАК': '🜁', 'СЕССИЯ': 'другая' }), '🜁');
      const v2 = await (await get(`/k/d/${again.code}`, { Cookie: cookie })).text();
      expect(v2).toContain('требует проверки на хор');
      expect(v2).toContain('href="/wall/r/R1"');
    });
  });

  it('отклонение с причиной; без причины — 400', async () => {
    const { code } = await submitOk(card());
    const { cookie } = await login();
    const csrf = csrfOf(await (await get(`/k/d/${code}`, { Cookie: cookie })).text());
    expect((await post('/k/reject', { csrf, code, reason: ' ' }, cookie)).status).toBe(400);
    const res = await post('/k/reject', { csrf, code, reason: 'нет основания' }, cookie);
    expect(await res.text()).toContain('Отклонено');
    expect(await env.DB.prepare('SELECT state, reason FROM drafts WHERE code = ?').bind(code).first()).toEqual({ state: 'отклонён', reason: 'нет основания' });
  });

  it('CSRF привязан к сессии: без токена, с токеном другой сессии и с чужого Origin — отказ', async () => {
    const { code } = await submitOk(card());
    const a = await login(await otp());
    const b = await login(await otp(1));
    const csrfA = csrfOf(await (await get(`/k/d/${code}`, { Cookie: a.cookie })).text());
    expect((await post('/k/approve', { code }, b.cookie)).status).toBe(403);
    expect((await post('/k/approve', { csrf: csrfA, code }, b.cookie)).status).toBe(403);
    expect((await post('/k/approve', { csrf: csrfA, code }, a.cookie, { Origin: 'https://evil.example' })).status).toBe(403);
    expect(await env.DB.prepare('SELECT state FROM drafts WHERE code = ?').bind(code).first('state')).toBe('ждёт');
    expect((await post('/k/approve', { csrf: csrfA, code }, a.cookie)).status).toBe(200);
  });

  it('сессия без cookie ключа не действует', async () => {
    const { session } = await login();
    expect((await get('/k', { Cookie: session })).status).toBe(403);
  });

  it('«Выйти» отзывает сессию; «Выйти везде» — все сессии хранителя', async () => {
    const a = await login(await otp());
    const b = await login(await otp(1));
    const csrfA = csrfOf(await (await get('/k', { Cookie: a.cookie })).text());
    const out = await post('/k/logout', { csrf: csrfA }, a.cookie);
    expect(out.status).toBe(303);
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(await (await get('/k', { Cookie: a.cookie })).text()).toContain('action="/k/login"'); // отозвана
    expect(await (await get('/k', { Cookie: b.cookie })).text()).toContain('Очередь');

    const c = await login(await otp(-1));
    const csrfC = csrfOf(await (await get('/k', { Cookie: c.cookie })).text());
    await post('/k/logout-all', { csrf: csrfC }, c.cookie);
    for (const s of [b, c]) expect(await (await get('/k', { Cookie: s.cookie })).text()).toContain('action="/k/login"');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL').first('n')).toBe(0);
  });

  it('старые /review и /approve?otp= остаются; robots закрывает /k', async () => {
    const { code } = await submitOk(card());
    const res = await get(`/approve?code=${code}&otp=${await otp()}`, { Cookie: await keeperCookie() });
    expect(res.status).toBe(200);
    expect(await (await get('/robots.txt')).text()).toContain('Disallow: /k\n');
  });
});
