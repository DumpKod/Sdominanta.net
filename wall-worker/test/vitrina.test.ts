import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENE, validateScene } from '../src/scene';
import * as M from '../public/vitrina/model.js';
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
    for (const [name, text] of [['vitrina.js', vitrinaJs], ['model.js', modelJs], ['vitrina.css', vitrinaCss], ['editor.js', editorJs], ['font.json', fontJson]] as const) {
      expect(external(text.replace("'http://www.w3.org/2000/svg'", '')), name).toEqual([]); // пространство имён SVG — не адрес загрузки
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
    expect(vitrinaJs).not.toContain('/k/vitrina'); // правка и сохранение живут только в /k/editor.js
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
  it('/k/editor.js — только в сессии: без cookie, с одной cookie ключа и с отозванной сессией — нет', async () => {
    expect((await get('/k/editor.js')).status).toBe(403);
    const key = await (await get('/k/editor.js', { Cookie: await keeperCookie() })).text();
    expect(key).not.toContain('setInput');
    const { cookie } = await login();
    const res = await get('/k/editor.js', { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toContain('E.setInput({');
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
    for (const s of ['new M.History()', 'hist.undo()', 'hist.redo()', "e.code === 'Digit2' && e.shiftKey", 'drawMini', 'nearSegment', 'deletePoint', 'rectFrom', 'fZ', 'M.STYLE', 'startHandle', 'applyHandle', '.stretch(', '.rotate('])
      expect(editorJs, s).toContain(s);
    for (const s of ["e.code === 'Space'", 'e.button === 1', "e.code === 'Digit1' && e.shiftKey", 'clampTo', 'pinch', 'cull()'])
      expect(vitrinaJs, s).toContain(s);
  });
});
