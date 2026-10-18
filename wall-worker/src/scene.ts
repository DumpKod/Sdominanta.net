// Сцена витрины: список объектов в координатах бесконечного мира. Каждый объект движок рисует кистью (жилы)
// и делает ссылкой или окном; экран — камера над миром. Тот же список Worker отдаёт слоем <nav> из настоящих <a>
// для инструментов, экранных чтецов и клавиатуры — без камеры, все объекты всегда.
// Сцена живёт в таблице scenes (версии: черновик / опубликована); пусто — встроенная сцена src/scene-default.json.
// Модель для браузера (камера, отсечение, история) — public/vitrina/model.js.
//
// Формат v2 (всё остальное отвергается при сохранении):
// { v: 2, space?: { drift, density, glow, sound }, objects: [ {
//     id: "wall",                         латиница, цифры, дефис; до 32
//     label: "Стена: нити, записи, системы",   подпись для <nav> и моделей; до 200
//     href?: "/wall",                     относительный путь стены
//     z?: 0,                              слой: -100…100
//     strokes: [ { r, pts: [[x, y(, r)]…], closed? } ],   жилы в координатах мира
//     area?: [[x, y]…],                   область попадания в координатах мира (многоугольник)
//     window?: { title?, text?, links?: [ { label, href } ] }   окно из пустоты по клику
//     inner?: "aleph"                     алеф-нуль: колёсико или клик внутрь — пространство aleph (/in/aleph)
//     style?: { tubeR, thick, resonance, tact, flow, wobble, fill, sound }   свои параметры объекта
// } ] }
import { Env } from './util';
import defaultScene from './scene-default.json';

export interface Stroke {
  r: number;
  pts: number[][];
  closed?: boolean;
}
export interface SceneObject {
  id: string;
  label: string;
  href?: string;
  z?: number;
  strokes: Stroke[];
  area?: number[][];
  window?: { title?: string; text?: string; links?: { label: string; href: string }[] };
  style?: Record<string, number>;
  inner?: string;
}
export interface Scene {
  v: 2;
  space?: Record<string, number>;
  objects: SceneObject[];
}

export const DEFAULT_SCENE = defaultScene as Scene;
export const SCENE_MAX = 256 * 1024;

const LIMITS = { objects: 200, strokes: 400, pts: 2000, area: 200, links: 20, label: 200, title: 200, text: 4000, coord: 1e6 };
/** Пределы параметров — те же, что у ползунков редактора (STYLE и SPACE в public/vitrina/model.js). */
export const STYLE_RANGE: Record<string, [number, number]> = {
  tubeR: [0.5, 200], thick: [0.4, 2.5], resonance: [0, 1], tact: [0, 3], flow: [0, 2], wobble: [0, 1], fill: [0, 1], sound: [0, 2],
};
export const SPACE_RANGE: Record<string, [number, number]> = { drift: [0, 2], density: [0.5, 1.6], glow: [0, 1.5], sound: [0, 2] };

/** Имя пространства: main — главная витрина, остальные — алеф-нули. */
export const SPACE_RE = /^[a-z0-9-]{1,32}$/;
export const EMPTY_SCENE: Scene = { v: 2, objects: [] };

/** Относительный путь своего сайта: «/…», без «//», «..», схемы, строки запроса и пробелов. */
export const relPath = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 200 && /^\/(?!\/)[A-Za-z0-9._~\-\/]*$/.test(s) && !s.split('/').includes('..');

type Check = { ok: true; scene: Scene } | { ok: false; errors: string[] };

/** Проверка сцены: только ожидаемые поля, конечные числа в пределах, строки в пределах, ссылки — относительные пути. */
export function validateScene(raw: string): Check {
  const errors: string[] = [];
  if (new TextEncoder().encode(raw).length > SCENE_MAX) return { ok: false, errors: [`сцена больше ${SCENE_MAX / 1024} КБ`] };
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['не JSON'] };
  }
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const only = (x: Record<string, unknown>, keys: string[], at: string) => {
    for (const k of Object.keys(x)) if (!keys.includes(k)) errors.push(`${at}: лишнее поле «${k.slice(0, 40)}»`);
  };
  const num = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  const str = (x: unknown, max: number) => typeof x === 'string' && x.length <= max;
  const point = (p: unknown, n: number[]) => Array.isArray(p) && n.includes(p.length) && p.every((v) => num(v, -LIMITS.coord, LIMITS.coord));
  const params = (x: unknown, range: Record<string, [number, number]>, at: string) => {
    if (!isObj(x)) return void errors.push(`${at}: объект параметров`);
    only(x, Object.keys(range), at);
    for (const [k, [lo, hi]] of Object.entries(range)) if (x[k] !== undefined && !num(x[k], lo, hi)) errors.push(`${at}.${k}: ${lo}…${hi}`);
  };

  if (!isObj(j)) return { ok: false, errors: ['сцена — объект { v, objects }'] };
  only(j, ['v', 'space', 'objects'], 'сцена');
  if (j.v !== 2) errors.push('v: ожидается 2 (координаты мира)');
  if (j.space !== undefined) params(j.space, SPACE_RANGE, 'space');
  if (!Array.isArray(j.objects) || j.objects.length > LIMITS.objects) return { ok: false, errors: [...errors, `objects: массив до ${LIMITS.objects}`] };
  const ids = new Set<string>();
  j.objects.forEach((o: unknown, i: number) => {
    const at = `objects[${i}]`;
    if (!isObj(o)) return void errors.push(`${at}: объект`);
    only(o, ['id', 'label', 'href', 'z', 'strokes', 'area', 'window', 'style', 'inner'], at);
    if (o.inner !== undefined && (typeof o.inner !== 'string' || !SPACE_RE.test(o.inner) || o.inner === 'main'))
      errors.push(`${at}.inner: имя пространства — латиница, цифры, дефис, до 32, не main`);
    if (typeof o.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(o.id)) errors.push(`${at}.id: латиница, цифры, дефис, до 32`);
    else if (ids.has(o.id)) errors.push(`${at}.id: «${o.id}» повторяется`);
    else ids.add(o.id);
    if (!str(o.label, LIMITS.label) || !(o.label as string).trim()) errors.push(`${at}.label: строка до ${LIMITS.label}`);
    if (o.href !== undefined && !relPath(o.href)) errors.push(`${at}.href: только относительный путь стены, например /wall`);
    if (o.z !== undefined && !num(o.z, -100, 100)) errors.push(`${at}.z: −100…100`);
    if (!Array.isArray(o.strokes) || o.strokes.length > LIMITS.strokes) errors.push(`${at}.strokes: массив до ${LIMITS.strokes}`);
    else
      o.strokes.forEach((s: unknown, k: number) => {
        const sa = `${at}.strokes[${k}]`;
        if (!isObj(s)) return void errors.push(`${sa}: объект`);
        only(s, ['r', 'pts', 'closed'], sa);
        if (!num(s.r, 0.1, 5000)) errors.push(`${sa}.r: 0.1…5000`);
        if (s.closed !== undefined && typeof s.closed !== 'boolean') errors.push(`${sa}.closed: true или false`);
        if (!Array.isArray(s.pts) || !s.pts.length || s.pts.length > LIMITS.pts || !s.pts.every((p) => point(p, [2, 3])))
          errors.push(`${sa}.pts: от 1 до ${LIMITS.pts} точек [x, y] или [x, y, r]`);
      });
    if (o.area !== undefined && (!Array.isArray(o.area) || o.area.length < 3 || o.area.length > LIMITS.area || !o.area.every((p) => point(p, [2]))))
      errors.push(`${at}.area: от 3 до ${LIMITS.area} точек [x, y]`);
    if (o.style !== undefined) params(o.style, STYLE_RANGE, `${at}.style`);
    if (o.window !== undefined) {
      const w = o.window;
      if (!isObj(w)) errors.push(`${at}.window: { title, text, links }`);
      else {
        only(w, ['title', 'text', 'links'], `${at}.window`);
        if (w.title !== undefined && !str(w.title, LIMITS.title)) errors.push(`${at}.window.title: строка до ${LIMITS.title}`);
        if (w.text !== undefined && !str(w.text, LIMITS.text)) errors.push(`${at}.window.text: строка до ${LIMITS.text}`);
        if (w.links !== undefined) {
          if (!Array.isArray(w.links) || w.links.length > LIMITS.links) errors.push(`${at}.window.links: массив до ${LIMITS.links}`);
          else
            w.links.forEach((l: unknown, k: number) => {
              const la = `${at}.window.links[${k}]`;
              if (!isObj(l)) return void errors.push(`${la}: { label, href }`);
              only(l, ['label', 'href'], la);
              if (!str(l.label, LIMITS.label) || !(l.label as string).trim()) errors.push(`${la}.label: строка до ${LIMITS.label}`);
              if (!relPath(l.href)) errors.push(`${la}.href: только относительный путь стены`);
            });
        }
      }
    }
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return { ok: true, scene: j as unknown as Scene };
}

export interface SceneRow {
  version: number;
  json: string;
  by_sign: string;
  created_at: number;
  status: string;
  published_at: number | null;
  space: string;
}

/** Опубликованная сцена пространства: последняя по времени публикации; нет — встроенная (main) или пустая (алеф-нуль). */
export async function publishedScene(env: Env, space = 'main'): Promise<{ version: number; json: string; scene: Scene }> {
  const r = await env.DB.prepare(`SELECT version, json FROM scenes WHERE space = ? AND status = 'опубликована' ORDER BY published_at DESC, version DESC LIMIT 1`)
    .bind(space).first<{ version: number; json: string }>();
  if (r) return { version: r.version, json: r.json, scene: JSON.parse(r.json) as Scene };
  const empty = space === 'main' ? DEFAULT_SCENE : EMPTY_SCENE;
  return { version: 0, json: JSON.stringify(empty), scene: empty };
}

/** Опубликованные пространства. */
export async function publishedSpaces(env: Env): Promise<string[]> {
  const r = await env.DB.prepare(`SELECT DISTINCT space FROM scenes WHERE status = 'опубликована'`).all<{ space: string }>();
  return r.results.map((x) => x.space);
}

/**
 * Откуда входят в пространство: опубликованное пространство, где у объекта inner = space (сначала main).
 * Нет такого — null: в пространство попадают только по прямому адресу.
 */
export async function parentOf(env: Env, space: string): Promise<{ space: string; id: string } | null> {
  const spaces = ['main', ...(await publishedSpaces(env)).filter((s) => s !== 'main' && s !== space)];
  for (const sp of spaces) {
    const { scene } = await publishedScene(env, sp);
    const o = scene.objects.find((x) => x.inner === space);
    if (o) return { space: sp, id: o.id };
  }
  return null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Слой <nav>: по пункту на объект, в порядке Tab. Ссылка объекта — настоящий <a>; окно — его заголовок, текст и ссылки,
 * чтобы модели и экранные чтецы видели то же, что люди в окне. Объект с окном без адреса ссылается на свой пункт (#w-id).
 */
export function sceneNav(o: string, scene: Scene, back?: string): string {
  const items = scene.objects
    .map((x) => {
      // Алеф-нуль ведёт в своё пространство: там его содержимое, и у пространства свой адрес.
      const href = x.inner ? `${o}/in/${x.inner}` : x.href ? o + x.href : `#w-${x.id}`;
      let li = `<li id="w-${esc(x.id)}"><a data-id="${esc(x.id)}" href="${esc(href)}">${esc(x.label)}</a>`;
      const w = x.window;
      if (w) {
        if (w.title) li += `\n<h2>${esc(w.title)}</h2>`;
        if (w.text) li += `\n<p>${esc(w.text)}</p>`;
        if (w.links?.length) li += `\n<ul>${w.links.map((l) => `<li><a href="${esc(o + l.href)}">${esc(l.label)}</a></li>`).join('')}</ul>`;
      }
      return li + '</li>';
    });
  if (back !== undefined) items.unshift(`<li><a data-back="1" href="${esc(o + back)}">Наружу</a></li>`);
  return items.join('\n');
}
