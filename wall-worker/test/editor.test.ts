import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { csrfOf, get, login, post } from './helpers';

// Редактор витрины v2: карта слоёв, аварийная копия слоя, лёгкие чтения без лимита панели.

const ed = { 'X-Editor': '1' };
const tiny = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 2, objects: [{ id: 'one', label: 'Один', strokes: [{ r: 1, pts: [[1, 1], [5, 5]] }], ...o }] });

async function session() {
  const { cookie } = await login();
  const csrf = csrfOf(await (await get('/k/vitrina', { Cookie: cookie })).text());
  return { cookie, csrf };
}
async function saveIn(cookie: string, csrf: string, json: string, space = 'main') {
  const r = await post('/k/vitrina/save', { csrf, json, space }, cookie, ed);
  return +/^VERSION: (\d+)$/m.exec(await r.text())![1];
}
type Item = { space: string; parent: string | null; from: string | null; label: string; state: string; version: number; last: number; draft: boolean };
const spaces = async (cookie: string) => ((await (await get('/k/vitrina/spaces.json', { Cookie: cookie })).json()) as { spaces: Item[] }).spaces;

describe('Редактор: карта слоёв', () => {
  it('без сессии карты нет', async () => {
    expect((await get('/k/vitrina/spaces.json')).status).not.toBe(200);
  });

  it('главная, алеф-нуль объекта и области, черновик новее опубликованного, пустой слой без сцены', async () => {
    await env.DB.prepare('DELETE FROM scenes').run();
    const { cookie, csrf } = await session();
    const doors = [{ area: [[0, 0], [9, 0], [9, 9]], inner: 'room', label: 'Комната' }];
    const v1 = await saveIn(cookie, csrf, tiny({ inner: 'hall', doors }));
    await post('/k/vitrina/publish', { csrf, version: String(v1) }, cookie, ed);
    const v2 = await saveIn(cookie, csrf, tiny({ id: 'x' }), 'hall');
    let list = await spaces(cookie);
    const main = list.find((i) => i.space === 'main')!;
    expect(main).toMatchObject({ parent: null, label: 'Главная', state: 'опубликован', version: v1, last: v1, draft: false });
    expect(list.find((i) => i.space === 'hall')).toMatchObject({ parent: 'main', from: 'one', state: 'черновик', version: 0, last: v2, draft: true });
    expect(list.find((i) => i.space === 'room')).toMatchObject({ parent: 'main', from: 'one', label: 'Комната', state: 'пусто' });
    // черновик главной новее опубликованной
    const v3 = await saveIn(cookie, csrf, tiny({ inner: 'hall', doors }));
    list = await spaces(cookie);
    expect(list.find((i) => i.space === 'main')).toMatchObject({ version: v1, last: v3, draft: true });
  });

  it('петля пространств (слой внутри самого себя через цепочку) не вешает карту', async () => {
    await env.DB.prepare('DELETE FROM scenes').run();
    const { cookie, csrf } = await session();
    for (const [sp, inner] of [['main', 'a'], ['a', 'b'], ['b', 'a']]) {
      const v = await saveIn(cookie, csrf, tiny({ inner }), sp);
      await post('/k/vitrina/publish', { csrf, version: String(v) }, cookie, ed);
    }
    const list = await spaces(cookie);
    expect(list.map((i) => i.space).sort()).toEqual(['a', 'b', 'main']);
    expect(list.find((i) => i.space === 'a')!.parent).toBe('main');
  });
});

describe('Редактор: аварийная копия слоя', () => {
  it('одна ячейка на слой: запись перезаписывает, сохранение черновика её снимает', async () => {
    await env.DB.prepare('DELETE FROM scene_recovery').run();
    const { cookie, csrf } = await session();
    expect((await get('/k/vitrina/recover/main.json', { Cookie: cookie })).status).toBe(204);
    expect((await post('/k/vitrina/recover', { csrf, space: 'main', json: tiny({ label: 'Первая' }) }, cookie, ed)).status).toBe(200);
    expect((await post('/k/vitrina/recover', { csrf, space: 'main', json: tiny({ label: 'Вторая' }) }, cookie, ed)).status).toBe(200);
    const r = (await (await get('/k/vitrina/recover/main.json', { Cookie: cookie })).json()) as { json: string; by: string; at: number };
    expect(JSON.parse(r.json).objects[0].label).toBe('Вторая');
    expect(r.by).toBe('🜄');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM scene_recovery').first<{ n: number }>())!.n).toBe(1);
    await saveIn(cookie, csrf, tiny());
    expect((await get('/k/vitrina/recover/main.json', { Cookie: cookie })).status).toBe(204);
  });

  it('копия проверяется как сцена; пустой json — выбросить копию', async () => {
    const { cookie, csrf } = await session();
    const bad = await post('/k/vitrina/recover', { csrf, space: 'deep', json: '{"v":2,"objects":"нет"}' }, cookie, ed);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/^ERR SCENE/);
    expect((await post('/k/vitrina/recover', { csrf, space: 'Плохо', json: tiny() }, cookie, ed)).status).toBe(400);
    await post('/k/vitrina/recover', { csrf, space: 'deep', json: tiny() }, cookie, ed);
    expect((await get('/k/vitrina/recover/deep.json', { Cookie: cookie })).status).toBe(200);
    expect(await (await post('/k/vitrina/recover', { csrf, space: 'deep', json: '' }, cookie, ed)).text()).toMatch(/^OK DROPPED/);
    expect((await get('/k/vitrina/recover/deep.json', { Cookie: cookie })).status).toBe(204);
  });

  it('без сессии и без CSRF копию не записать', async () => {
    const { cookie } = await session();
    expect((await post('/k/vitrina/recover', { csrf: 'x', space: 'main', json: tiny() }, cookie, ed)).status).toBe(403);
    expect((await get('/k/vitrina/recover/main.json')).status).not.toBe(200);
  });
});

describe('Редактор: лёгкие чтения не тратят лимит панели', () => {
  const panelRows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM rate WHERE key LIKE 'panel:%'").first<{ n: number }>())!.n;
  it('файлы редактора, сцены, версии, карта слоёв и аварийные копии — без счёта; страницы панели — со счётом', async () => {
    const { cookie } = await session();
    const before = await panelRows();
    for (const p of ['/k/ed/main.js', '/k/ed/editor.css', '/k/vitrina/live/main.json', '/k/vitrina/scene/0.json', '/k/vitrina/spaces.json', '/k/vitrina/recover/main.json'])
      await get(p, { Cookie: cookie });
    expect(await panelRows()).toBe(before);
    await get('/k/vitrina', { Cookie: cookie });
    expect(await panelRows()).toBe(before + 1);
  });
});
