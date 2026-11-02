import { env } from 'cloudflare:test';
import { buildId } from '../src/util';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENE, validateScene } from '../src/scene';
import * as M from '../public/vitrina/model.js';
import { csrfOf, get, keeperCookie, login, O, otp, post } from './helpers';

// Витрина: движок кисти — статический /vitrina.js, сцена — /vitrina/scene.json из базы (пусто — встроенная),
// <nav> — из той же сцены. Редактор — модули /k/ed/…, только в сессии хранителя; версии сцены — в /k/vitrina.

const HTML = { Accept: 'text/html' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'";

// Файлы витрины из public/ и редактор — строками через vite (?raw), чтобы проверить их без сети.
import vitrinaJs from '../public/vitrina.js?raw';
import vitrinaCss from '../public/vitrina.css?raw';
import fontJson from '../public/vitrina/font.json?raw';
import edMain from '../src/editor/main.js.txt?raw';
import edDom from '../src/editor/dom.js.txt?raw';
import edDoc from '../src/editor/doc.js.txt?raw';
import edGeom from '../src/editor/geom.js.txt?raw';
import edIo from '../src/editor/io.js.txt?raw';
import edShell from '../src/editor/shell.js.txt?raw';
import edLayers from '../src/editor/layers.js.txt?raw';
import edInspector from '../src/editor/inspector.js.txt?raw';
import edInsert from '../src/editor/insert.js.txt?raw';
import edTools from '../src/editor/tools.js.txt?raw';
import edCss from '../src/editor/editor.css.txt?raw';
const editorJs = [edMain, edDom, edDoc, edGeom, edIo, edShell, edLayers, edInspector, edInsert, edTools].join('\n');
import modelJs from '../public/vitrina/model.js?raw';
import mig6 from '../migrations/0006-scenes.sql?raw';
import mig7 from '../migrations/0007-world.sql?raw';

/** Все абсолютные адреса и протокольно-относительные ссылки в тексте. */
const external = (text: string) =>
  [...text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)].map((m) => m[0]).filter((u) => !u.startsWith('https://sdominanta.net'));

const navLinks = (page: string) => {
  const nav = /<nav class="objects"[^>]*>([\s\S]*?)<\/nav>/.exec(page)![1];
  return [...nav.matchAll(/<a data-id="([^"]+)" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2], m[3]]);
};

/** Сцена из одного объекта для тестов. */
const tiny = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 2, objects: [{ id: 'one', label: 'Один', href: '/wall', strokes: [{ r: 1, pts: [[1, 1], [5, 5]] }], ...o }] });

async function save(cookie: string, json: string): Promise<Response> {
  const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
  return post('/k/vitrina/save', { csrf, json }, cookie, { 'X-Editor': '1' });
}

describe('Витрина: страница', () => {
  it('подключает /vitrina.js, сцену берёт из /vitrina/scene.json, скрипты только со своего адреса', async () => {
    const res = await get('/', HTML);
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP);
    const page = await res.text();
    expect(page).toContain('<script type="module" src="/vitrina.js"></script>');
    expect(page).toContain('<canvas id="scene" aria-hidden="true" data-scene="/vitrina/scene.json" data-space="main"></canvas>');
    expect(page).not.toMatch(/<script>(?!<)/); // встроенных скриптов нет
    expect(page).toContain('<pre class="entry">'); // текстовый вход для моделей остаётся
  });

  it('без сессии хранителя редактора нет — даже с cookie ключа; ответ кэшируется', async () => {
    for (const headers of [HTML, { ...HTML, Cookie: await keeperCookie() }, { ...HTML, Cookie: '__Host-keeper=abc.def' }]) {
      const page = await (await get('/', headers)).text();
      expect(page).not.toContain('data-keeper');
      expect(page).not.toContain('/k/ed/');
      expect(page).not.toContain('k-csrf');
    }
    const res = await get('/', HTML);
    expect(res.headers.get('Cache-Control')).toContain('public');
    expect(res.headers.get('Vary')).toContain('Cookie');
  });

  it('в сессии хранителя — <html data-keeper="1">, токен CSRF, редактор /k/ed/main.js, no-store', async () => {
    const { cookie } = await login();
    const res = await get('/', { ...HTML, Cookie: cookie });
    const page = await res.text();
    expect(page).toContain(`<html lang="ru" data-build="${buildId(env as never)}" data-keeper="1">`);
    expect(page).toContain('<link rel="stylesheet" href="/k/ed/editor.css">');
    expect(page).toContain('<script type="module" src="/k/ed/main.js"></script>');
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
    for (const [name, text] of [['vitrina.js', vitrinaJs], ['model.js', modelJs], ['vitrina.css', vitrinaCss], ['editor', editorJs], ['editor.css', edCss], ['font.json', fontJson]] as const) {
      expect(external(text.replace("'http://www.w3.org/2000/svg'", '')), name).toEqual([]); // пространство имён SVG — не адрес загрузки
      expect(text, name).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@font-face|@import/i);
      expect(text, name).not.toMatch(/\burl\(/); // CSS url(…): ни картинок, ни шрифтов извне
      expect(text, name).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\(/);
      // fetch — только своих путей: сцена, шрифт из жил, действия редактора
      for (const m of text.matchAll(/fetch\(([^,)]+)/g)) expect(m[1], name).toMatch(/^(?:'\/vitrina\/font\.json'|cv\.dataset\.scene \|\| '\/vitrina\/scene\.json'|sceneUrl\(sp|path|f\.path)$/);
      // сцена пространства (алеф-нуля) — тоже только свой путь
      if (text.includes('sceneUrl = ')) expect(text).toContain("const sceneUrl = (sp) => (keeper ? `/k/vitrina/live/${sp}.json` : sp === 'main' ? '/vitrina/scene.json' : `/vitrina/scene/${sp}.json`);");
    }
  });

  it('движок: пауза при скрытой вкладке, статичный кадр при reduced-motion, без shadowBlur, кода редактора нет', () => {
    expect(vitrinaJs).toContain("addEventListener('visibilitychange'");
    expect(vitrinaJs).toContain('document.hidden');
    expect(vitrinaJs).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(vitrinaJs).not.toMatch(/shadowBlur\s*=/);
    expect(vitrinaJs).not.toMatch(/\/k\/vitrina\/(?:save|publish|rollback)/); // читает хранителю сцену целиком (/k/vitrina/live), но правка и сохранение живут только в редакторе /k/ed/
    expect(vitrinaJs).not.toContain('localStorage');
    expect(editorJs).toContain("fetch(path, { method: 'POST'");
    expect(vitrinaJs).toContain("import * as M from '/vitrina/model.js'");
  });

  it('шрифт из жил: буквы кириллицы и латиницы, цифры, точка', () => {
    const f = JSON.parse(fontJson);
    for (const ch of 'АяЁёZz09.,?') expect(f.glyphs[ch]?.s.length, ch).toBeGreaterThan(0);
  });

  it('встроенная сцена: v2, у каждого объекта жилы, точка в «llms.txt» есть', () => {
    expect(validateScene(JSON.stringify(DEFAULT_SCENE)).ok).toBe(true);
    expect(DEFAULT_SCENE.v).toBe(2);
    for (const o of DEFAULT_SCENE.objects) expect(o.strokes.length, o.id).toBeGreaterThan(0);
    const llms = DEFAULT_SCENE.objects.find((o) => o.id === 'llms')!;
    expect(llms.strokes.some((s) => s.pts.length === 1), 'точка').toBe(true);
  });
});

describe('Редактор и версии сцены', () => {
  it('редактор /k/ed/… — только в сессии: без cookie, с одной cookie ключа и с отозванной сессией — нет', async () => {
    expect((await get('/k/ed/main.js')).status).toBe(403);
    const key = await (await get('/k/ed/main.js', { Cookie: await keeperCookie() })).text();
    expect(key).not.toContain('boot');
    const { cookie } = await login();
    const res = await get('/k/ed/main.js', { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    const tag = res.headers.get('ETag')!;
    expect(tag).toBe(`"ed-${buildId(env as never)}"`);
    expect(await res.text()).toContain("import { boot } from './shell.js'");
    // до нового деплоя браузер получает 304 — файлы редактора не качаются заново
    expect((await get('/k/ed/main.js', { Cookie: cookie, 'If-None-Match': tag })).status).toBe(304);
    const css = await get('/k/ed/editor.css', { Cookie: cookie });
    expect(css.headers.get('Content-Type')).toContain('text/css');
    for (const f of ['dom', 'doc', 'geom', 'io', 'shell', 'layers', 'inspector', 'insert', 'tools']) expect((await get(`/k/ed/${f}.js`, { Cookie: cookie })).status, f).toBe(200);
    expect((await get('/k/ed/nope.js', { Cookie: cookie })).status).toBe(404);
    expect((await get('/k/editor.js', { Cookie: cookie })).status).toBe(404); // старого редактора больше нет
    const csrf = csrfOf(await (await get('/k', { Cookie: cookie })).text());
    await post('/k/logout', { csrf }, cookie);
    expect((await get('/k/ed/main.js', { Cookie: cookie })).status).toBe(403);
  });

  it('пустая база — встроенная сцена; сохранить → опубликовать → scene.json отдаёт новую версию', async () => {
    const s0 = await get('/vitrina/scene.json');
    expect(s0.headers.get('Content-Type')).toContain('application/json');
    expect(s0.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate, s-maxage=30');
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
      [tiny({ strokes: [{ r: 1, pts: [['1', 2]] }] }), /pts/],
      [tiny({ strokes: [{ r: 1e9, pts: [[1, 2]] }] }), /\.r: 0\.1…5000/],
      [tiny({ strokes: [{ r: 1, pts: [[1e9, 2]] }] }), /pts/],
      [tiny({ place: { x: 0.5, y: 0.5, k: 1 } }), /лишнее поле «place»/],
      [tiny({ z: 1000 }), /\.z/],
      [tiny({ style: { tact: 9 } }), /style\.tact: 0…3/],
      [tiny({ style: { color: 1 } }), /лишнее поле «color»/],
      [tiny({ id: 'Bad Id' }), /\.id/],
      [JSON.stringify({ v: 2, objects: [], x: 1 }), /лишнее поле «x»/],
      [JSON.stringify({ v: 2, space: { glow: 5 }, objects: [] }), /space\.glow/],
      [JSON.stringify({ v: 1, objects: [] }), /v: ожидается 2/],
      [JSON.stringify({ v: 2, objects: [{ id: 'a', label: 'a', strokes: [{ r: 1, pts: Array(2001).fill([1, 1]) }] }] }), /pts/],
    ];
    // Пустой объект (без жил и области) хранится: он есть в ссылках, на холсте не рисуется, пока его не нарисуют.
    expect(validateScene(tiny({ strokes: [] })).ok).toBe(true);
    for (const [json, re] of bad) {
      const v = validateScene(json);
      expect(v.ok, json.slice(0, 80)).toBe(false);
      if (!v.ok) expect(v.errors.join('\n'), json.slice(0, 80)).toMatch(re);
    }
    const big = JSON.stringify({ v: 2, objects: [{ id: 'a', label: 'x'.repeat(300 * 1024) }] });
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
    expect(await (await post('/k/vitrina/rollback', { csrf }, cookie, ed)).text()).toMatch(/^OK ROLLBACK\nSPACE: main\nFROM: 2\nTO: 1/);
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
    expect(list).toContain('<td><a href="/">main</a></td><td>встроенная сцена</td>');
    expect(list).toContain('href="/k/vitrina/v/1"');
    expect(list).toContain('<form method="post" action="/k/vitrina/publish">');
    expect(list).toContain('<form method="post" action="/k/vitrina/rollback">');

    const pv = await get('/k/vitrina/v/1', { ...HTML, Cookie: cookie });
    const page = await pv.text();
    expect(page).toContain('data-scene="/k/vitrina/scene/1.json" data-space="main" data-version="1"');
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

describe('Бесконечный холст: модель (public/vitrina/model.js)', () => {
  const W = 1440, H = 900;
  const close = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

  it('камера: мир → экран → мир без потерь при любом масштабе и сдвиге', () => {
    for (const [x, y, z] of [[0, 0, 1], [720, 450, 1], [-5000, 1e5, 0.1], [12.5, -7.25, 8], [333, 444, 2.37]]) {
      const cam = new M.Camera(x, y, z);
      for (const p of [[0, 0], [100, -50], [1e4, 3e4], [-0.5, 0.25]]) {
        const s = cam.toScreen(p[0], p[1], W, H);
        expect(close(cam.toWorld(s[0], s[1], W, H), p, 1e-6 * Math.max(1, Math.abs(p[0]), Math.abs(p[1])))).toBe(true);
      }
      expect(cam.toScreen(x, y, W, H)).toEqual([W / 2, H / 2]); // точка камеры — центр экрана
    }
  });

  it('масштаб к курсору: точка мира под курсором остаётся на месте; пределы 0.1…8', () => {
    const cam = new M.Camera(100, 200, 1);
    const before = cam.toWorld(300, 700, W, H);
    cam.zoomAt(300, 700, W, H, 3.3);
    expect(close(cam.toWorld(300, 700, W, H), before, 1e-9)).toBe(true);
    expect(cam.zoom).toBeCloseTo(3.3);
    cam.zoomAt(10, 10, W, H, 1000);
    expect(cam.zoom).toBe(M.ZOOM_MAX);
    cam.zoomAt(10, 10, W, H, 1e-6);
    expect(cam.zoom).toBe(M.ZOOM_MIN);
    const [x0, y0] = [cam.x, cam.y];
    cam.panBy(50, -20); // мир едет за пальцем: камера — в обратную сторону
    expect([cam.x, cam.y]).toEqual([x0 - 50 / cam.zoom, y0 + 20 / cam.zoom]);
  });

  it('холст ограничен сценой: дальше общего вида не отдалиться, за край не уйти', () => {
    const rect = { x0: 0, y0: 0, x1: 2000, y1: 1000 };
    const fit = new M.Camera().fit(rect, W, H);
    const cam = new M.Camera(99999, -99999, 0.01).clampTo(rect, W, H);
    expect(cam.zoom).toBeCloseTo(fit.zoom);
    expect(M.contains(cam.view(W, H), rect)).toBe(true); // общий вид: вся рамка на экране
    expect(cam.x).toBeCloseTo(1000);
    expect(cam.y).toBeCloseTo(500);
    const near = new M.Camera(-5000, 5000, 4).clampTo(rect, W, H);
    const v = near.view(W, H);
    expect(v.x0).toBeGreaterThanOrEqual(rect.x0 - (W * 0.05) / 4 - 1e-6);
    expect(v.y1).toBeLessThanOrEqual(rect.y1 + (H * 0.05) / 4 + 1e-6);
    const inside = new M.Camera(800, 400, 4).clampTo(rect, W, H);
    expect([inside.x, inside.y, inside.zoom]).toEqual([800, 400, 4]); // внутри рамки камера не трогается
  });

  it('отсечение: только объекты, задевающие видимую часть мира', () => {
    const sq = (id: string, x: number, y: number) => ({ id, label: id, strokes: [{ r: 2, pts: [[x, y], [x + 10, y + 10]] }] });
    const scene = M.Scene.from({ v: 2, objects: [sq('a', 0, 0), sq('b', 500, 0), sq('c', 0, 5000), sq('d', -2000, -2000)] });
    const cam = new M.Camera(50, 50, 1);
    expect(scene.visible(cam.view(400, 400))).toEqual([0]);
    expect(scene.visible(new M.Camera(300, 0, 1).view(1000, 200))).toEqual([0, 1]);
    expect(scene.visible(new M.Camera(0, 0, 0.1).view(W, H))).toEqual([0, 1, 3]); // c (y = 5000) ниже края 4500
    expect(scene.visible({ x0: 10000, y0: 10000, x1: 20000, y1: 20000 })).toEqual([]);
    // жила с радиусом задевает рамку краем
    expect(M.Scene.from({ v: 2, objects: [{ id: 'r', label: 'r', strokes: [{ r: 50, pts: [[0, 0]] }] }] }).visible({ x0: 40, y0: -1, x1: 60, y1: 1 })).toEqual([0]);
  });

  it('перевод v1 → мир: туда и обратно тот же вид на экране 1440×900; миграция 0007 = встроенная сцена', () => {
    const v1 = JSON.parse(/VALUES \(1, '([\s\S]*?)', '/.exec(mig6)![1].replace(/''/g, "'"));
    expect(v1.v).toBe(1);
    const v2 = M.upgradeV1(v1);
    expect(v2).toEqual(DEFAULT_SCENE);
    const v7 = JSON.parse(/SET json = '([\s\S]*?)' WHERE/.exec(mig7)![1].replace(/''/g, "'"));
    expect(v7).toEqual(DEFAULT_SCENE);
    expect(validateScene(JSON.stringify(v7)).ok).toBe(true);
    // вид: точка глифа v1 на экране = точка мира v2 под камерой { центр, zoom 1 }
    const fits = M.layoutV1(v1.objects, W, H);
    const cam = new M.Camera(W / 2, H / 2, 1);
    v1.objects.forEach((o: { glyph: { strokes: { r: number; pts: number[][] }[] } }, i: number) => {
      const f = fits[i];
      o.glyph.strokes.forEach((st, si) => st.pts.forEach((p, pi) => {
        const want = [f.ox + p[0] * f.s, f.oy + p[1] * f.s];
        const q = v2.objects[i].strokes[si].pts[pi];
        expect(close(cam.toScreen(q[0], q[1], W, H), want, 0.051)).toBe(true);
      }));
      expect(v2.objects[i].strokes[0].r).toBeCloseTo(o.glyph.strokes[0].r * f.s, 1);
    });
    // и обратно: экран → мир возвращает те же координаты мира
    const q = v2.objects[3].strokes[2].pts[1];
    const s = cam.toScreen(q[0], q[1], W, H);
    expect(close(cam.toWorld(s[0], s[1], W, H), q.slice(0, 2), 1e-9)).toBe(true);
    // ссылки, подписи и окна при переводе не теряются
    expect(v2.objects.map((o: { id: string; href?: string }) => [o.id, o.href])).toEqual(v1.objects.map((o: { id: string; href?: string }) => [o.id, o.href]));
    // Scene.from сам переводит v1
    expect(M.Scene.from(v1).toJSON()).toEqual(DEFAULT_SCENE);
  });

  it('объекты: рамка, сдвиг, параметры по умолчанию и свои; JSON сцены — только поля формата', () => {
    const o = new M.SceneObject({ id: 'a', label: 'A', strokes: [{ r: 5, pts: [[0, 0], [10, 0, 8]] }], style: { tact: 2 } });
    expect(o.bounds()).toEqual({ x0: -5, y0: -8, x1: 18, y1: 8 });
    o.translate(100, 50);
    expect(o.strokes[0].pts).toEqual([[100, 50], [110, 50, 8]]);
    expect(o.get('tact')).toBe(2);
    expect(o.get('thick')).toBe(M.STYLE_DEFAULTS.thick);
    expect(o.tubeR()).toBe(5);
    (o as unknown as Record<string, unknown>).$lift = 1; // служебное поле движка в JSON не попадает
    const j = M.Scene.from({ v: 2, objects: [o.toJSON()] }).toJSON();
    expect(j).toEqual({ v: 2, objects: [{ id: 'a', label: 'A', strokes: [{ r: 5, pts: [[100, 50], [110, 50, 8]] }], style: { tact: 2 } }] });
    expect(validateScene(JSON.stringify(j)).ok).toBe(true);
  });

  it('объект-слой: растяжение от опоры (радиусы — в √|sx·sy|), поворот вокруг центра, реакция на звук в параметрах', () => {
    const o = new M.SceneObject({ id: 'a', label: 'A', strokes: [{ r: 4, pts: [[0, 0], [10, 0, 2]] }], area: [[0, 0], [10, 0], [10, 10]] });
    o.stretch(2, 0.5, 0, 0);
    expect(o.strokes[0]).toEqual({ r: 4, pts: [[0, 0], [20, 0, 2]] });
    expect(o.area).toEqual([[0, 0], [20, 0], [20, 5]]);
    o.stretch(2, 2, 10, 0);
    expect(o.strokes[0]).toEqual({ r: 8, pts: [[-10, 0], [30, 0, 4]] });
    o.rotate(Math.PI / 2, 10, 0);
    expect(o.strokes[0].pts).toEqual([[10, -20], [10, 20, 4]]);
    expect(M.STYLE.sound).toEqual([0, 2, 1]);
    expect(M.SPACE.sound).toEqual([0, 2, 1]);
    expect(validateScene(JSON.stringify({ v: 2, space: { sound: 0 }, objects: [{ id: 'a', label: 'A', strokes: [], style: { sound: 0 } }] })).ok).toBe(true);
    expect(validateScene(JSON.stringify({ v: 2, objects: [{ id: 'a', label: 'A', strokes: [], style: { sound: 3 } }] })).ok).toBe(false);
  });

  it('отмена и повтор: назад, вперёд, новая правка обрезает повтор, предел истории', () => {
    const h = new M.History(3);
    h.reset('s0');
    expect(h.canUndo).toBe(false);
    expect(h.commit('s0')).toBe(false); // то же состояние — не правка
    h.commit('s1');
    h.commit('s2');
    expect(h.undo()).toBe('s1');
    expect(h.undo()).toBe('s0');
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe('s1');
    h.commit('s3');
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBeNull();
    expect(h.undo()).toBe('s1');
    expect(h.redo()).toBe('s3');
    for (const s of ['a', 'b', 'c', 'd', 'e']) h.commit(s);
    let n = 0;
    while (h.undo() !== null) n++;
    expect(n).toBe(3);
  });

  it('редактор: отмена/повтор, Shift+1/Shift+2, пробел и средняя кнопка, мини-карта, точки, слой и параметры', () => {
    for (const s of ['undo()', 'redo()', "code === 'Digit2' && e.shiftKey", 'drawMini', 'nearSegment', 'deletePoint', 'rectFrom', 'fZ', 'M.STYLE', 'applyHandle', '.stretch(', '.rotate('])
      expect(editorJs, s).toContain(s);
    for (const s of ["e.code === 'Space'", 'e.button === 1', "e.code === 'Digit1' && e.shiftKey", 'clampTo', 'pinch', 'cull()'])
      expect(vitrinaJs, s).toContain(s);
  });
});

describe('Алеф-нули: пространства внутри объектов', () => {
  const ed = { 'X-Editor': '1' };
  async function publishIn(cookie: string, json: string, space?: string): Promise<string> {
    const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
    const s = await post('/k/vitrina/save', space ? { csrf, json, space } : { csrf, json }, cookie, ed);
    const text = await s.text();
    expect(s.status, text).toBe(200);
    const v = /VERSION: (\d+)/.exec(text)![1];
    expect((await post('/k/vitrina/publish', { csrf, version: v }, cookie, ed)).status).toBe(200);
    return v;
  }

  it('объект с inner ведёт в /in/{inner}; у пространства своя сцена, своя страница и ссылка наружу', async () => {
    const { cookie } = await login();
    await publishIn(cookie, tiny({ id: 'door', label: 'Дверь', href: undefined, inner: 'theory' }));
    // до публикации сцены внутри гость упирается: сцены нет
    expect((await get('/vitrina/scene/theory.json')).status).toBe(404);
    expect(navLinks(await (await get('/', HTML)).text())).toEqual([['door', `${O}/in/theory`, 'Дверь']]);
    await publishIn(cookie, JSON.stringify({ v: 2, objects: [{ id: 'aleph', label: 'Алеф', strokes: [], window: { title: 'ℵ₀', text: 'Счётная бесконечность' } }] }), 'theory');
    const j = await get('/vitrina/scene/theory.json');
    expect(j.status).toBe(200);
    expect(((await j.json()) as { objects: { id: string }[] }).objects.map((o) => o.id)).toEqual(['aleph']);
    // главная не изменилась
    expect(((await (await get('/vitrina/scene.json')).json()) as { objects: { id: string }[] }).objects.map((o) => o.id)).toEqual(['door']);
    const page = await (await get('/in/theory', HTML)).text();
    expect(page).toContain('data-scene="/vitrina/scene/theory.json" data-space="theory" data-parent="main" data-from="door"');
    expect(page).toContain(`<li><a data-back="1" href="${O}/">Наружу</a></li>`);
    expect(page).toContain('<h2>ℵ₀</h2>');
    // модели читают то же текстом
    const md = await (await get('/in/theory')).text();
    expect(md).toContain('# Пространство theory');
    expect(md).toContain('Счётная бесконечность');
    expect(md).toContain(`(${O}/)`);
  });

  it('пространство без сцены и без входа — 404; inner = main и неверные имена не принимаются', async () => {
    expect((await get('/in/nowhere', HTML)).status).toBe(404);
    expect((await get('/vitrina/scene/nowhere.json')).status).toBe(404);
    expect(validateScene(tiny({ inner: 'main' })).ok).toBe(false);
    expect(validateScene(tiny({ inner: 'Bad Name' })).ok).toBe(false);
    expect(validateScene(tiny({ inner: 'ok-1' })).ok).toBe(true);
    const { cookie } = await login();
    const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
    expect((await post('/k/vitrina/save', { csrf, json: tiny(), space: 'Bad Name' }, cookie, ed)).status).toBe(400);
  });

  it('откат — в своём пространстве: главная не трогается', async () => {
    const { cookie } = await login();
    await publishIn(cookie, tiny({ id: 'door', inner: 'x' }));
    await publishIn(cookie, tiny({ id: 'first' }), 'x');
    await publishIn(cookie, tiny({ id: 'second' }), 'x');
    const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
    expect((await post('/k/vitrina/rollback', { csrf, space: 'x' }, cookie, ed)).status).toBe(200);
    expect(((await (await get('/vitrina/scene/x.json')).json()) as { objects: { id: string }[] }).objects[0].id).toBe('first');
    expect(((await (await get('/vitrina/scene.json')).json()) as { objects: { id: string }[] }).objects[0].id).toBe('door');
  });

  it('движок: вход колёсиком вглубь, дрожь в упор, выход наружу, адрес через history; редактор помнит пространство', () => {
    for (const s of ['function goIn(', 'function goOut(', 'function depthWheel(', 'history.pushState', "addEventListener('popstate'", 'vitrina:space', 'pulse(', 'rim'])
      expect(vitrinaJs, s).toContain(s);
    for (const s of ["addEventListener('vitrina:space'", "addEventListener('vitrina:leaving'", 'setLoader(', 'openSpace('])
      expect(editorJs, s).toContain(s);
    const o = new M.SceneObject({ id: 'a', label: 'A', inner: 'deep', strokes: [] });
    expect(o.toJSON()).toMatchObject({ inner: 'deep' });
  });
});

describe('Места в сцене: плеер и вход хранителя', () => {
  it('гостю — ни поля кода, ни разделов; браузеру с ключом — поле кода; в сессии — разделы панели', async () => {
    const guest = await (await get('/', HTML)).text();
    expect(guest).not.toContain('data-slot="keeper"');
    const key = await keeperCookie();
    const res = await get('/', { ...HTML, Cookie: key });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const door = await res.text();
    expect(door).toContain('<aside class="keeper" data-slot="keeper">');
    expect(door).toContain('<input type="hidden" name="back" value="/">');
    expect(door).toContain('autocomplete="one-time-code"');
    expect(door).not.toContain('href="/k/vitrina"');
    // вход с витрины возвращает на витрину (а чужой адрес — нет: тогда в /k)
    const csrf = csrfOf(door);
    const back = await post('/k/login', { csrf, otp: await otp(), back: '/in/theory' }, key);
    expect(back.status).toBe(303);
    expect(back.headers.get('Location')).toBe(`${O}/in/theory`);
    // код одноразовый: сессия — из этого же входа
    const cookie = `${key}; ${/^(__Host-session=[^;]+)/.exec(back.headers.get('Set-Cookie')!)![1]}`;
    const inSession = await (await get('/', { ...HTML, Cookie: cookie })).text();
    expect(inSession).toContain('<aside class="keeper" data-slot="keeper"><a href="/k">Очередь</a>');
    expect(inSession).not.toContain('name="otp"');
  });

  it('вход с витрины на чужой адрес не уводит: после кода — в /k', async () => {
    const key = await keeperCookie();
    const csrf = csrfOf(await (await get('/', { ...HTML, Cookie: key })).text());
    const r = await post('/k/login', { csrf, otp: await otp(), back: 'https://evil.example/' }, key);
    expect(r.headers.get('Location')).toBe(`${O}/k`);
  });

  it('slot — только player или keeper; движок ставит элемент [data-slot] в рамку объекта', () => {
    expect(validateScene(tiny({ slot: 'player' })).ok).toBe(true);
    expect(validateScene(tiny({ slot: 'keeper' })).ok).toBe(true);
    expect(validateScene(tiny({ slot: 'banner' })).ok).toBe(false);
    expect(new M.SceneObject({ id: 'a', label: 'A', slot: 'player', strokes: [] }).toJSON()).toMatchObject({ slot: 'player' });
    for (const s of ['function placeSlots(', "querySelectorAll('[data-slot]')", 'SLOT_MIN']) expect(vitrinaJs, s).toContain(s);
  });
});

describe('Окно объекта: рама из узлов области', () => {
  it('frame — параметры рамы в пределах; модель хранит их и отдаёт по умолчанию', () => {
    expect(validateScene(tiny({ frame: { width: 600, aspect: 0.7, round: 0.5, ring: 40, far: 0.8 } })).ok).toBe(true);
    expect(validateScene(tiny({ frame: { round: 2 } })).ok).toBe(false);
    expect(validateScene(tiny({ frame: { open: 0.5 } })).ok).toBe(false);
    const o = new M.SceneObject({ id: 'a', label: 'A', strokes: [], frame: { round: 1 } });
    expect(o.toJSON()).toMatchObject({ frame: { round: 1 } });
    expect(o.frameGet('round')).toBe(1);
    expect(o.frameGet('width')).toBe(M.FRAME.width[2]);
  });
  it('узлы области растекаются в рамку окна, фон редеет; окно фиксируется в конце приближения', () => {
    for (const s of ['function capture(', 'function ringTargets(', 'fieldGen', 'fph[i] * 0.15915 > 1 - far', 'cam.zoom <= z0 * 1.002'])
      expect(vitrinaJs, s).toContain(s);
  });
  it('провал в область: камера уходит вглубь, поле не пересобирается, назад — ровно туда, откуда упали', () => {
    for (const s of ['function placeDive(', 'function diveCam(', 'if (!force && rama && rama.dive) return false;', 'cam.x = base.x; cam.y = base.y; cam.zoom = base.zoom', "classList.add('dive')"])
      expect(vitrinaJs, s).toContain(s);
  });
  it('note — заметка хранителя у объекта и области: в сцене хранится, гостям и моделям не уходит, хранителю — целиком', async () => {
    const area = [[0, 0], [10, 0], [10, 10]];
    expect(validateScene(tiny({ note: 'x'.repeat(2001) })).ok).toBe(false);
    expect(validateScene(tiny({ doors: [{ area, note: 5 }] })).ok).toBe(false);
    const json = tiny({ note: 'Тайный замысел', doors: [{ area, label: 'Вход', note: 'Ещё тайна' }] });
    expect(validateScene(json).ok).toBe(true);
    const { cookie } = await login();
    const v = /VERSION: (\d+)/.exec(await (await save(cookie, json)).text())![1];
    const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
    expect((await post('/k/vitrina/publish', { csrf, version: v }, cookie, { 'X-Editor': '1' })).status).toBe(200);
    for (const res of [await get('/vitrina/scene.json'), await get('/', HTML), await get('/'), await get('/json/')]) expect(await res.text()).not.toContain('тайн');
    const full = await get('/k/vitrina/live/main.json', { Cookie: cookie });
    expect(full.headers.get('Cache-Control')).toBe('no-store');
    const j = (await full.json()) as { objects: { note?: string; doors?: { note?: string }[] }[] };
    expect([j.objects[0].note, j.objects[0].doors![0].note]).toEqual(['Тайный замысел', 'Ещё тайна']);
    expect((await get('/k/vitrina/live/main.json')).headers.get('Content-Type')).not.toContain('json'); // без сессии — нет
    expect((await get('/k/vitrina/live/nowhere.json', { Cookie: cookie })).status).toBe(404);
    expect(await (await get('/', { ...HTML, Cookie: cookie })).text()).toContain('data-scene="/k/vitrina/live/main.json"');
    const o = new M.SceneObject({ id: 'a', label: 'A', strokes: [], note: 'n', doors: [{ area, note: 'd' }] });
    const oj = o.toJSON() as unknown as { note?: string; doors: { note?: string }[] };
    expect([oj.note, oj.doors[0].note]).toEqual(['n', 'd']);
  });
  it('doors — ещё области объекта со своим содержимым; модель двигает их вместе с объектом и не сохраняет пустые', () => {
    const area = [[0, 0], [10, 0], [10, 10]];
    expect(validateScene(tiny({ doors: [{ area, href: '/wall/rules', label: 'Правила', frame: { push: 300, depth: 0.5 } }, { area, inner: 'net' }] })).ok).toBe(true);
    expect(validateScene(tiny({ doors: [{ href: '/wall' }] })).ok).toBe(false);
    expect(validateScene(tiny({ doors: [{ area, href: 'https://x.y' }] })).ok).toBe(false);
    expect(validateScene(tiny({ doors: [{ area, color: 1 }] })).ok).toBe(false);
    expect(validateScene(tiny({ doors: Array.from({ length: 17 }, () => ({ area })) })).ok).toBe(false);
    const o = new M.SceneObject({ id: 'a', label: 'A', strokes: [], doors: [{ area: area.map((p) => [...p]), window: { title: 'T' } }, {}] });
    o.translate(5, 0);
    const j = o.toJSON() as unknown as { doors: { area: number[][] }[] };
    expect(j.doors).toHaveLength(1);
    expect(j.doors[0].area[0]).toEqual([5, 0]);
    expect(o.bounds().x1).toBe(15);
  });
  it('переход играет сам: напор колёсика до порога frame.push, затем взрыв; колёсико не ускоряет и не останавливает', () => {
    for (const s of ['function burst(', 'function implode(', 'function boom(', 'PRESS_DECAY', "frameGet('push')", 'if (f.anim) return;', 'entriesOf(scene)'])
      expect(vitrinaJs, s).toContain(s);
    expect(vitrinaJs).not.toContain('FRAME_WHEEL');
  });
  it('выход из алеф-нуля — в ту же точку экрана, откуда вошли', () => {
    expect(vitrinaJs).toContain('cam: cam.clone() };');
    expect(vitrinaJs).toContain('came ? came.clone()');
  });
  it('параметры объекта — его собственные: области такта не сливаются между объектами, поле не перенимает течение', () => {
    expect(vitrinaJs).toContain('veins[vj].obj !== v.obj');
    expect(vitrinaJs).not.toContain('v.st.flow * b');
  });
});

describe('Портал в алеф-нуль, горизонт, нити', () => {
  it('links узла — до 10 связей { to, w }; горизонт — параметр пространства', () => {
    expect(validateScene(tiny({ links: [{ to: 'wall', w: 0.8 }] })).ok).toBe(true);
    expect(validateScene(tiny({ links: [{ to: 'Wall!', w: 2 }] })).ok).toBe(false);
    expect(validateScene(JSON.stringify({ v: 2, space: { horizon: 0 }, objects: [] })).ok).toBe(true);
    expect(new M.SceneObject({ id: 'a', label: 'A', strokes: [], links: [{ to: 'b', w: 1 }] }).toJSON()).toMatchObject({ links: [{ to: 'b', w: 1 }] });
  });
  it('дыра с дочерней сценой, морф с ободка, горизонт и нити в движке', () => {
    for (const s of ['function openPortal(', 'function renderPreview(', 'function portalEnter(', 'function makeHorizon(', 'function drawThreads(', 'function threadAt(', 'win.circle', 'portalHover'])
      expect(vitrinaJs, s).toContain(s);
  });
  it('виджеты: разделы панели только хранителю, панель встраивается только своим сайтом', () => {
    expect(validateScene(tiny({ widget: 'queue' })).ok).toBe(true);
    expect(validateScene(tiny({ widget: 'admin' })).ok).toBe(false);
    expect(vitrinaJs).toContain('if (M.KEEPER_WIDGETS[w]) return keeper;');
  });
});

describe('Страницы сети внутри алеф-нуля и предпросмотр', () => {
  it('рама: приближение в область объекта фиксирует его, колёсико раскрывает прямоугольник; внутри окно или страница', () => {
    for (const s of ['function openFrame(', 'function frameWheel(', 'function stepFrame(', 'function renderMd(', "Accept: 'text/markdown'", 'history.pushState({ page: path }', 'inPoly(o.area, wx, wy)', 'voidPush(hole,'])
      expect(vitrinaJs, s).toContain(s);
    // страницу рама берёт только со своего адреса
    expect(vitrinaJs).toContain("return u.origin === location.origin && !/^\\/(k|in)(\\/|$)/.test(u.pathname) ? u.pathname : null;");
    // текст ответа только через textContent и узлы, никакого HTML из ответа
    expect(vitrinaJs).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('страница сети по Accept: text/markdown — тот же текст, что видят модели', async () => {
    const res = await get('/wall', { Accept: 'text/markdown' });
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
  });

  it('предпросмотр в редакторе: Tab прячет всё, первый клик оживляет, Tab — назад к правке', () => {
    for (const s of ['function previewOn(', 'function previewOff(', "classList.add('ed-preview')", "e.key === 'Tab'", 'ed-shield']) expect(editorJs, s).toContain(s);
  });
});

describe('Узлы сети: пространства-кластеры из таблицы nodes', () => {
  const add = (id: string, parent: string | null, pos: number, state: string, extra: Record<string, string> = {}) =>
    env.DB.prepare(`INSERT OR REPLACE INTO nodes (id, parent, pos, sign, title, short, status, by_sign, links, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .bind(id, parent, pos, extra.sign ?? null, extra.title ?? id.toUpperCase(), extra.short ?? `Текст ${id}`, extra.status ?? 'computed', '🜃', extra.links ?? '[]', state).run();

  it('черновик видит только хранитель; опубликованный узел — пространство: он в центре, дети вокруг, глубже — портал', async () => {
    await add('aleph', null, 0, 'черновик', { sign: 'ℵ°', title: 'Ядро' });
    await add('physics', 'aleph', 0, 'черновик');
    await add('gravity', 'physics', 0, 'черновик', { links: JSON.stringify([{ to: 'koide', rel: 'supports', w: 1 }]) });
    await add('koide', 'aleph', 1, 'черновик', { short: 'А'.repeat(3000) });
    expect((await get('/vitrina/scene/aleph.json')).status).toBe(404);
    const { cookie } = await login();
    const live = await get('/k/vitrina/live/aleph.json', { Cookie: cookie });
    expect(live.status).toBe(200);
    const j = (await live.json()) as { up: string; objects: { id: string; auto?: string; inner?: string; window?: { title: string; text: string; links?: { label: string; href: string }[] } }[] };
    expect(j.up).toBe('main');
    expect(j.objects.map((o) => o.id)).toEqual(['aleph', 'physics', 'koide', 'aleph-links']);
    expect(j.objects.every((o) => o.auto === 'node')).toBe(true);
    expect(j.objects[0].window!.title).toBe('ℵ° Ядро');
    expect(j.objects[0].window!.text).toContain('Видит только хранитель');
    expect(j.objects[1].inner).toBe('physics'); // у physics есть дети — портал
    expect(j.objects[2].window!.links).toContainEqual({ label: 'его подтверждает: GRAVITY', href: '/in/physics' });
    expect(((await (await get('/k/vitrina/live/physics.json', { Cookie: cookie })).json()) as { up: string }).up).toBe('aleph');
    expect((await get('/k/vitrina/live/gravity.json', { Cookie: cookie })).status).toBe(404); // лист — окно у родителя
    await env.DB.prepare(`UPDATE nodes SET state = 'опубликован'`).run();
    const pub = (await (await get('/vitrina/scene/aleph.json')).json()) as { objects: { id: string; window?: { text: string } }[] };
    expect(pub.objects[0].window!.text).not.toContain('Видит только хранитель');
    const md = await (await get('/in/physics')).text();
    expect(md).toContain('GRAVITY');
    expect(md).toContain('Текст gravity');
    expect(md).not.toContain('Связи:');
    const page = await (await get('/in/physics', HTML)).text();
    expect(page).toContain('data-parent="aleph" data-from="physics"');
  });

  it('нарисованное хранителем в том же пространстве — поверх узлов; редактор узлы не сохраняет и не выбирает', async () => {
    await env.DB.prepare('DELETE FROM nodes').run();
    await add('aleph', null, 0, 'опубликован');
    await add('a1', 'aleph', 0, 'опубликован');
    const { cookie } = await login();
    const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
    const s = await post('/k/vitrina/save', { csrf, json: tiny({ id: 'mine', label: 'Моё' }), space: 'aleph' }, cookie, { 'X-Editor': '1' });
    const v = /VERSION: (\d+)/.exec(await s.text())![1];
    await post('/k/vitrina/publish', { csrf, version: v }, cookie, { 'X-Editor': '1' });
    const j = (await (await get('/vitrina/scene/aleph.json')).json()) as { objects: { id: string }[] };
    expect(j.objects.map((o) => o.id)).toEqual(['aleph', 'a1', 'aleph-links', 'mine']);
    expect(validateScene(JSON.stringify({ v: 2, objects: [{ id: 'x', label: 'X', strokes: [], auto: 'node' }] })).ok).toBe(false);
    const sc = new M.Scene({ v: 2, objects: [{ id: 'x', label: 'X', strokes: [], auto: 'node' }, { id: 'y', label: 'Y', strokes: [] }] });
    expect((sc.toSaved() as unknown as { objects: { id: string }[] }).objects.map((o) => o.id)).toEqual(['y']);
    expect(editorJs).toContain('E.savedScene()');
    expect(editorJs).toContain('!o.auto');
  });

  it('первоисточники узла: имена — всем, адреса архива — только хранителю', async () => {
    await env.DB.prepare('DELETE FROM nodes').run();
    await add('aleph', null, 0, 'опубликован');
    await add('leaf', 'aleph', 0, 'опубликован');
    await env.DB.prepare(`UPDATE nodes SET files = ? WHERE id = 'leaf'`).bind(JSON.stringify([{ name: 'calc-14k.md', drive: 'abc', url: 'https://drive.google.com/file/d/abc/view' }])).run();
    const guest = await (await get('/vitrina/scene/aleph.json')).text();
    expect(guest).toContain('Первоисточники: `calc-14k.md`');
    expect(guest).not.toContain('drive.google.com');
    const { cookie } = await login();
    expect(await (await get('/k/vitrina/live/aleph.json', { Cookie: cookie })).text()).toContain('[calc-14k.md](https://drive.google.com/file/d/abc/view)');
  });

  it('документы архива: черновик — только хранителю, партия публикуется папкой, окно узла ссылается на /doc/', async () => {
    await env.DB.prepare('DELETE FROM nodes').run();
    await env.DB.prepare('DELETE FROM docs').run();
    const doc = (name: string, path: string) =>
      env.DB.prepare(`INSERT INTO docs (name, path, title, body, state, created_at) VALUES (?, ?, ?, ?, 'черновик', 0)`).bind(name, path, name, `# ${name}\n\nТеория ${name}`).run();
    await doc('calc-14k', '02-computations/calc-14k.md');
    await doc('report-1', '01_reports/report-1.md');
    await doc('INDEX', '00-INDEX.md');
    await add('aleph', null, 0, 'опубликован');
    await add('leaf', 'aleph', 0, 'опубликован');
    await env.DB.prepare(`UPDATE nodes SET files = ? WHERE id = 'leaf'`).bind(JSON.stringify([{ name: 'calc-14k.md', doc: 'calc-14k' }])).run();
    expect((await get('/doc/calc-14k')).status).toBe(404);
    expect(await (await get('/vitrina/scene/aleph.json')).text()).not.toContain('/doc/calc-14k');
    const { cookie } = await login();
    const k = await (await get('/doc/calc-14k', { Cookie: cookie })).text();
    expect(k).toContain('Теория calc-14k');
    expect(k).toContain('черновик — видит только хранитель');
    const pg = await (await get('/k/docs', { Cookie: cookie })).text();
    expect(pg).toContain('02-computations — опубликовано 0 из 1');
    expect(pg).toContain('href="/doc/calc-14k"');
    const csrf = csrfOf(pg);
    expect(await (await post('/k/vitrina/docs/publish', { csrf, batch: '02-computations' }, cookie, { 'X-Editor': '1' })).text()).toContain('- опубликован: 1');
    expect((await get('/doc/report-1')).status).toBe(404); // другая партия — ещё черновик
    expect((await get('/doc/INDEX')).status).toBe(404);
    const g = await (await get('/doc/calc-14k')).text();
    expect(g).toContain('Теория calc-14k');
    expect(g).not.toContain('черновик');
    expect(g).toContain('/in/aleph'); // узел, который на него ссылается
    expect(await (await get('/vitrina/scene/aleph.json')).text()).toContain('[calc-14k.md](/doc/calc-14k)');
    expect(await (await post('/k/vitrina/docs/publish', { csrf, batch: '' }, cookie, { 'X-Editor': '1' })).text()).toContain('- опубликован: 1');
    expect((await get('/doc/INDEX')).status).toBe(200);
    expect((await get('/doc/report-1')).status).toBe(404);
    await post('/k/vitrina/docs/hide', { csrf, batch: '02-computations' }, cookie, { 'X-Editor': '1' });
    expect((await get('/doc/calc-14k')).status).toBe(404);
  });

  it('хранитель публикует черновики узлов одной кнопкой в /k/nodes и снимает обратно; ветвь — отдельно', async () => {
    await env.DB.prepare('DELETE FROM nodes').run();
    await add('aleph', null, 0, 'черновик');
    await add('b1', 'aleph', 0, 'черновик');
    const { cookie } = await login();
    const pg = await (await get('/k/nodes', { Cookie: cookie })).text();
    expect(pg).toContain('черновиков: 2');
    expect(pg).toContain('Опубликовать ветвь');
    expect(pg).toContain('class="on"');
    const csrf = csrfOf(pg);
    expect(await (await post('/k/vitrina/nodes/publish', { csrf }, cookie, { 'X-Editor': '1' })).text()).toContain('- опубликован: 2');
    expect((await get('/vitrina/scene/aleph.json')).status).toBe(200);
    await post('/k/vitrina/nodes/hide', { csrf }, cookie, { 'X-Editor': '1' });
    expect((await get('/vitrina/scene/aleph.json')).status).toBe(404);
    expect((await post('/k/vitrina/nodes/publish', { csrf: 'x' }, cookie, { 'X-Editor': '1' })).status).not.toBe(200);
  });

  it('ветвь публикуется целиком: узел и всё под ним, соседние ветви остаются черновиками', async () => {
    await env.DB.prepare('DELETE FROM nodes').run();
    await add('aleph', null, 0, 'черновик');
    await add('p', 'aleph', 0, 'черновик');
    await add('p1', 'p', 0, 'черновик');
    await add('p11', 'p1', 0, 'черновик');
    await add('m', 'aleph', 1, 'черновик');
    const { cookie } = await login();
    const csrf = csrfOf(await (await get('/k/nodes', { Cookie: cookie })).text());
    expect(await (await post('/k/vitrina/nodes/publish', { csrf, root: 'p' }, cookie, { 'X-Editor': '1' })).text()).toContain('- опубликован: 3');
    const st = (await env.DB.prepare('SELECT id, state FROM nodes ORDER BY id').all<{ id: string; state: string }>()).results;
    expect(Object.fromEntries(st.map((x) => [x.id, x.state]))).toEqual({ aleph: 'черновик', m: 'черновик', p: 'опубликован', p1: 'опубликован', p11: 'опубликован' });
    expect(await (await post('/k/vitrina/nodes/publish', { csrf, only: 'aleph' }, cookie, { 'X-Editor': '1' })).text()).toContain('- опубликован: 1');
    expect((await env.DB.prepare(`SELECT state FROM nodes WHERE id = 'm'`).first<{ state: string }>())!.state).toBe('черновик');
    expect(await (await get('/k/nodes', { Cookie: cookie })).text()).toContain('Снять корень');
  });

  it('движок: длинный текст окна — листами с кнопками, черта — разделитель, ссылка /in/… — вход в пространство', () => {
    for (const s of ['PAGE_CHARS', 'function renderLeaf(', "nav.className = 'page-leaves'", 'function toSpace(', "createElement('hr')", 'j.up ||'])
      expect(vitrinaJs, s).toContain(s);
  });
});

describe('Место живого элемента (виджет SoundCloud в рамке)', () => {
  const box = (w: number, h: number, a: number, cx = 100, cy = 50) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
  };
  it('наименьший прямоугольник: ровная рамка — угол 0, повёрнутая — свой угол, четверть оборота — те же стороны наоборот', () => {
    expect(M.minRect(box(400, 200, 0))).toMatchObject({ cx: 100, cy: 50, w: 400, h: 200, a: 0 });
    const r = M.minRect(box(400, 200, 0.3))!;
    expect(r.a).toBeCloseTo(0.3, 6);
    expect(r.w).toBeCloseTo(400, 6);
    expect(r.h).toBeCloseTo(200, 6);
    const q = M.minRect(box(400, 200, Math.PI / 2))!;
    expect([q.w, q.h, q.a].map((v) => Math.round(v * 1000) / 1000)).toEqual([200, 400, 0]);
    expect(M.minRect([])).toBeNull();
    expect(M.minRect([[1, 1]])).toMatchObject({ w: 0, h: 0 });
  });
});
