import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENE, validateScene } from '../src/scene';
import { csrfOf, get, keeperCookie, login, O, post } from './helpers';

// Витрина: движок кисти — статический /vitrina.js, сцена — /vitrina/scene.json из базы (пусто — встроенная),
// <nav> — из той же сцены. Редактор — /k/editor.js, только в сессии хранителя; версии сцены — в /k/vitrina.

const HTML = { Accept: 'text/html' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'";

// Файлы витрины из public/ и редактор — строками через vite (?raw), чтобы проверить их без сети.
import vitrinaJs from '../public/vitrina.js?raw';
import vitrinaCss from '../public/vitrina.css?raw';
import fontJson from '../public/vitrina/font.json?raw';
import editorJs from '../src/pages/editor.js.txt?raw';

/** Все абсолютные адреса и протокольно-относительные ссылки в тексте. */
const external = (text: string) =>
  [...text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)].map((m) => m[0]).filter((u) => !u.startsWith('https://sdominanta.net'));

const navLinks = (page: string) => {
  const nav = /<nav class="objects"[^>]*>([\s\S]*?)<\/nav>/.exec(page)![1];
  return [...nav.matchAll(/<a data-id="([^"]+)" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2], m[3]]);
};

/** Сцена из одного объекта для тестов. */
const tiny = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, objects: [{ id: 'one', label: 'Один', href: '/wall', glyph: { w: 10, h: 10, strokes: [{ r: 1, pts: [[1, 1], [5, 5]] }] }, ...o }] });

async function save(cookie: string, json: string): Promise<Response> {
  const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
  return post('/k/vitrina/save', { csrf, json }, cookie, { 'X-Editor': '1' });
}

describe('Витрина: страница', () => {
  it('подключает /vitrina.js, сцену берёт из /vitrina/scene.json, скрипты только со своего адреса', async () => {
    const res = await get('/', HTML);
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP);
    const page = await res.text();
    expect(page).toContain('<script src="/vitrina.js" defer></script>');
    expect(page).toContain('<canvas id="scene" aria-hidden="true" data-scene="/vitrina/scene.json"></canvas>');
    expect(page).not.toMatch(/<script>(?!<)/); // встроенных скриптов нет
    expect(page).toContain('<pre class="entry">'); // текстовый вход для моделей остаётся
  });

  it('без сессии хранителя редактора нет — даже с cookie ключа; ответ кэшируется', async () => {
    for (const headers of [HTML, { ...HTML, Cookie: await keeperCookie() }, { ...HTML, Cookie: '__Host-keeper=abc.def' }]) {
      const page = await (await get('/', headers)).text();
      expect(page).not.toContain('data-keeper');
      expect(page).not.toContain('/k/editor.js');
      expect(page).not.toContain('k-csrf');
    }
    const res = await get('/', HTML);
    expect(res.headers.get('Cache-Control')).toContain('public');
    expect(res.headers.get('Vary')).toContain('Cookie');
  });

  it('в сессии хранителя — <html data-keeper="1">, токен CSRF, /k/editor.js, no-store', async () => {
    const { cookie } = await login();
    const res = await get('/', { ...HTML, Cookie: cookie });
    const page = await res.text();
    expect(page).toContain('<html lang="ru" data-keeper="1">');
    expect(page).toContain('<script src="/k/editor.js" defer></script>');
    expect(page).toMatch(/<meta name="k-csrf" content="[A-Za-z0-9_-]{43}">/);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('<nav> строится из той же сцены: подписи и ссылки объектов, текст и ссылки окон', async () => {
    const page = await (await get('/', HTML)).text();
    expect(navLinks(page)).toEqual(DEFAULT_SCENE.objects.map((x) => [x.id, O + x.href, x.label]));

    const { cookie } = await login();
    const json = tiny({ id: 'door', label: 'Дверь', href: undefined, window: { title: 'Окно', text: 'Текст <b>окна</b>', links: [{ label: 'Правила', href: '/wall/rules' }] } });
    const r = await save(cookie, json);
    const v = /^VERSION: (\d+)$/m.exec(await r.text())![1];
    const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
    await post('/k/vitrina/publish', { csrf, version: v }, cookie, { 'X-Editor': '1' });
    const p2 = await (await get('/', HTML)).text();
    expect(navLinks(p2)).toEqual([['door', '#w-door', 'Дверь']]);
    expect(p2).toContain('<h2>Окно</h2>');
    expect(p2).toContain('<p>Текст &lt;b&gt;окна&lt;/b&gt;</p>');
    expect(p2).toContain(`<a href="${O}/wall/rules">Правила</a>`);
  });
});

describe('Витрина: файлы', () => {
  it('страница, движок, стили, шрифт и редактор не обращаются ни к одному внешнему домену; шрифтов в браузере нет', async () => {
    const page = await (await get('/', HTML)).text();
    expect(external(page)).toEqual([]);
    expect(page).not.toMatch(/<style|style="|@import|<link[^>]+href="(?!\/)/i);
    for (const [name, text] of [['vitrina.js', vitrinaJs], ['vitrina.css', vitrinaCss], ['editor.js', editorJs], ['font.json', fontJson]] as const) {
      expect(external(text), name).toEqual([]);
      expect(text, name).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@font-face|@import/i);
      expect(text, name).not.toMatch(/\burl\(/); // CSS url(…): ни картинок, ни шрифтов извне
      expect(text, name).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\(/);
      // fetch — только своих путей: сцена, шрифт из жил, действия редактора
      for (const m of text.matchAll(/fetch\(([^,)]+)/g)) expect(m[1], name).toMatch(/^(?:'\/vitrina\/font\.json'|cv\.dataset\.scene \|\| '\/vitrina\/scene\.json'|path)$/);
    }
  });

  it('движок: пауза при скрытой вкладке, статичный кадр при reduced-motion, без shadowBlur, кода редактора нет', () => {
    expect(vitrinaJs).toContain("addEventListener('visibilitychange'");
    expect(vitrinaJs).toContain('document.hidden');
    expect(vitrinaJs).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(vitrinaJs).not.toMatch(/shadowBlur\s*=/);
    expect(vitrinaJs).not.toMatch(/addEventListener\('pointerdown'/); // правка живёт только в /k/editor.js
    expect(vitrinaJs).not.toContain('localStorage');
    expect(editorJs).toContain("addEventListener('pointerdown'");
  });

  it('шрифт из жил: буквы кириллицы и латиницы, цифры, точка', () => {
    const f = JSON.parse(fontJson);
    for (const ch of 'АяЁёZz09.,?') expect(f.glyphs[ch]?.s.length, ch).toBeGreaterThan(0);
  });

  it('встроенная сцена: у каждого объекта жилы, точка в «llms.txt» есть', () => {
    expect(validateScene(JSON.stringify(DEFAULT_SCENE)).ok).toBe(true);
    for (const o of DEFAULT_SCENE.objects) expect(o.glyph!.strokes.length, o.id).toBeGreaterThan(0);
    const llms = DEFAULT_SCENE.objects.find((o) => o.id === 'llms')!;
    expect(llms.glyph!.strokes.some((s) => s.pts.length === 1), 'точка').toBe(true);
  });
});

describe('Редактор и версии сцены', () => {
  it('/k/editor.js — только в сессии: без cookie, с одной cookie ключа и с отозванной сессией — нет', async () => {
    expect((await get('/k/editor.js')).status).toBe(403);
    const key = await (await get('/k/editor.js', { Cookie: await keeperCookie() })).text();
    expect(key).not.toContain('pointerdown');
    const { cookie } = await login();
    const res = await get('/k/editor.js', { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toContain("addEventListener('pointerdown'");
    const csrf = csrfOf(await (await get('/k', { Cookie: cookie })).text());
    await post('/k/logout', { csrf }, cookie);
    expect((await get('/k/editor.js', { Cookie: cookie })).status).toBe(403);
  });

  it('пустая база — встроенная сцена; сохранить → опубликовать → scene.json отдаёт новую версию', async () => {
    const s0 = await get('/vitrina/scene.json');
    expect(s0.headers.get('Content-Type')).toContain('application/json');
    expect(s0.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(JSON.parse(await s0.text())).toEqual(DEFAULT_SCENE);

    const { cookie } = await login();
    const r = await save(cookie, tiny());
    expect(await r.clone().text()).toMatch(/^OK SAVED\nVERSION: 1\n/);
    const row = await env.DB.prepare('SELECT status, by_sign FROM scenes WHERE version = 1').first();
    expect(row).toEqual({ status: 'черновик', by_sign: '🜄' });
    expect(JSON.parse(await (await get('/vitrina/scene.json')).text())).toEqual(DEFAULT_SCENE); // черновик не на витрине

    const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
    const pub = await post('/k/vitrina/publish', { csrf, version: '1' }, cookie, { 'X-Editor': '1' });
    expect(await pub.text()).toMatch(/^OK PUBLISHED/);
    const s1 = await get('/vitrina/scene.json');
    expect(s1.headers.get('X-Scene-Version')).toBe('1');
    expect(JSON.parse(await s1.text()).objects[0].id).toBe('one');
  });

  it('полноразмерная сцена с кириллицей проходит форму сохранения (не упирается в лимит обычных форм)', async () => {
    const { cookie } = await login();
    const big = JSON.parse(JSON.stringify(DEFAULT_SCENE));
    big.objects[0].window = { title: 'Что это за сеть', text: 'Стена — место для записей. '.repeat(140), links: [{ label: 'Меню стены', href: '/wall' }] };
    const json = JSON.stringify(big);
    expect(json.length).toBeGreaterThan(20000);
    const r = await save(cookie, json);
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/^OK SAVED/);
  });

  it('CSRF: без токена, с чужим токеном и с чужого Origin сохранить и опубликовать нельзя', async () => {
    const a = await login();
    expect((await post('/k/vitrina/save', { json: tiny() }, a.cookie, { 'X-Editor': '1' })).status).toBe(403);
    expect((await post('/k/vitrina/save', { csrf: 'x'.repeat(43), json: tiny() }, a.cookie, { 'X-Editor': '1' })).status).toBe(403);
    const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: a.cookie })).text());
    expect((await post('/k/vitrina/save', { csrf, json: tiny() }, a.cookie, { Origin: 'https://evil.example' })).status).toBe(403);
    // только cookie ключа, без сессии
    expect((await post('/k/vitrina/save', { csrf, json: tiny() }, await keeperCookie(), { 'X-Editor': '1' })).status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM scenes').first('n')).toBe(0);
  });

  it('проверка JSON: лишние поля, нечисла, внешние ссылки, размер', async () => {
    const bad: [string, RegExp][] = [
      ['{', /не JSON/],
      [tiny({ evil: 1 }), /лишнее поле «evil»/],
      [tiny({ href: 'https://evil.example/x' }), /href: только относительный путь/],
      [tiny({ href: '//evil.example' }), /href: только относительный путь/],
      [tiny({ href: '/wall/../k' }), /href: только относительный путь/],
      [tiny({ href: 'javascript:alert(1)' }), /href: только относительный путь/],
      [tiny({ window: { links: [{ label: 'x', href: 'http://a.b' }] } }), /links\[0\]\.href/],
      [tiny({ window: { onclick: 'x' } }), /лишнее поле «onclick»/],
      [tiny({ glyph: { w: 10, h: 10, strokes: [{ r: 1, pts: [['1', 2]] }] } }), /pts/],
      [tiny({ glyph: { w: 10, h: 10, strokes: [{ r: 1e9, pts: [[1, 2]] }] } }), /\.r: 0\.1…500/],
      [tiny({ place: { x: 2, y: 0, k: 1 } }), /place/],
      [tiny({ id: 'Bad Id' }), /\.id/],
      [JSON.stringify({ v: 1, objects: [], x: 1 }), /лишнее поле «x»/],
      [JSON.stringify({ v: 1, objects: [{ id: 'a', label: 'a', glyph: { w: 1, h: 1, strokes: [{ r: 1, pts: Array(2001).fill([1, 1]) }] } }] }), /pts/],
    ];
    for (const [json, re] of bad) {
      const v = validateScene(json);
      expect(v.ok, json.slice(0, 80)).toBe(false);
      if (!v.ok) expect(v.errors.join('\n'), json.slice(0, 80)).toMatch(re);
    }
    const big = JSON.stringify({ v: 1, objects: [{ id: 'a', label: 'x'.repeat(300 * 1024) }] });
    expect(validateScene(big)).toEqual({ ok: false, errors: ['сцена больше 256 КБ'] });

    const { cookie } = await login();
    const r = await save(cookie, tiny({ href: 'https://evil.example' }));
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/^ERR SCENE\n- objects\[0\]\.href/);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM scenes').first('n')).toBe(0);
  });

  it('откат: снимает текущую публикацию, витрина возвращается к предыдущей, затем к встроенной', async () => {
    const { cookie } = await login();
    const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
    const ed = { 'X-Editor': '1' };
    await save(cookie, tiny({ id: 'first' }));
    await save(cookie, tiny({ id: 'second' }));
    await post('/k/vitrina/publish', { csrf, version: '1' }, cookie, ed);
    await post('/k/vitrina/publish', { csrf, version: '2' }, cookie, ed);
    const id = async () => JSON.parse(await (await get('/vitrina/scene.json')).text()).objects[0].id;
    expect(await id()).toBe('second');
    expect(await (await post('/k/vitrina/rollback', { csrf }, cookie, ed)).text()).toMatch(/^OK ROLLBACK\nFROM: 2\nTO: 1/);
    expect(await id()).toBe('first');
    await post('/k/vitrina/rollback', { csrf }, cookie, ed);
    expect(await id()).toBe(DEFAULT_SCENE.objects[0].id);
    const none = await post('/k/vitrina/rollback', { csrf }, cookie, ed);
    expect(none.status).toBe(409);
    expect((await post('/k/vitrina/rollback', {}, cookie, ed)).status).toBe(403); // без CSRF
  });

  it('раздел «Витрина» в /k: список версий, предпросмотр любой версии со своим data-scene', async () => {
    const { cookie } = await login();
    await save(cookie, tiny({ id: 'draft-one' }));
    const list = await (await get('/k/vitrina', { Cookie: cookie })).text();
    expect(list).toContain('Сейчас на витрине: встроенная сцена');
    expect(list).toContain('href="/k/vitrina/v/1"');
    expect(list).toContain('<form method="post" action="/k/vitrina/publish">');
    expect(list).toContain('<form method="post" action="/k/vitrina/rollback">');

    const pv = await get('/k/vitrina/v/1', { ...HTML, Cookie: cookie });
    const page = await pv.text();
    expect(page).toContain('data-scene="/k/vitrina/scene/1.json" data-version="1"');
    expect(navLinks(page)).toEqual([['draft-one', O + '/wall', 'Один']]);
    expect(pv.headers.get('Cache-Control')).toContain('no-store');
    const sj = await get('/k/vitrina/scene/1.json', { Cookie: cookie });
    expect(JSON.parse(await sj.text()).objects[0].id).toBe('draft-one');
    // без сессии — ни версий, ни их JSON
    for (const p of ['/k/vitrina', '/k/vitrina/v/1', '/k/vitrina/scene/1.json']) {
      expect(await (await get(p, { Cookie: await keeperCookie() })).text(), p).not.toContain('draft-one');
      expect((await get(p)).status, p).toBe(403);
    }
  });
});
