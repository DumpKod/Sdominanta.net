// Сцена витрины: список объектов. Каждый объект движок рисует кистью (жилы — glyph) и делает ссылкой или окном;
// тот же список Worker отдаёт слоем <nav> из настоящих <a> — для инструментов, экранных чтецов и клавиатуры.
// Сцена живёт в таблице scenes (версии: черновик / опубликована); пусто — встроенная сцена src/scene-default.json.
//
// Формат (всё остальное отвергается при сохранении):
// { v: 1, objects: [ {
//     id: "wall",                         латиница, цифры, дефис; до 32
//     label: "Стена: нити, записи, системы",   подпись для <nav> и моделей; до 200
//     href?: "/wall",                     относительный путь стены
//     place?: { x, y, k },                центр в долях экрана (0…1) и масштаб; нет — раскладка сама
//     glyph?: { w, h, strokes: [ { r, pts: [[x, y(, r)]…], closed? } ] },   жилы в пикселях референса
//     area?: [[x, y]…],                   область попадания в координатах glyph (многоугольник)
//     window?: { title?, text?, links?: [ { label, href } ] }   окно из пустоты по клику
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
  place?: { x: number; y: number; k: number };
  glyph?: { w: number; h: number; strokes: Stroke[] };
  area?: number[][];
  window?: { title?: string; text?: string; links?: { label: string; href: string }[] };
}
export interface Scene {
  v: 1;
  objects: SceneObject[];
}

export const DEFAULT_SCENE = defaultScene as Scene;
export const SCENE_MAX = 256 * 1024;

const LIMITS = { objects: 64, strokes: 400, pts: 2000, area: 200, links: 20, label: 200, title: 200, text: 4000, coord: 100000 };

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

  if (!isObj(j)) return { ok: false, errors: ['сцена — объект { v, objects }'] };
  only(j, ['v', 'objects'], 'сцена');
  if (j.v !== 1) errors.push('v: ожидается 1');
  if (!Array.isArray(j.objects) || j.objects.length > LIMITS.objects) return { ok: false, errors: [...errors, `objects: массив до ${LIMITS.objects}`] };
  const ids = new Set<string>();
  j.objects.forEach((o: unknown, i: number) => {
    const at = `objects[${i}]`;
    if (!isObj(o)) return void errors.push(`${at}: объект`);
    only(o, ['id', 'label', 'href', 'place', 'glyph', 'area', 'window'], at);
    if (typeof o.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(o.id)) errors.push(`${at}.id: латиница, цифры, дефис, до 32`);
    else if (ids.has(o.id)) errors.push(`${at}.id: «${o.id}» повторяется`);
    else ids.add(o.id);
    if (!str(o.label, LIMITS.label) || !(o.label as string).trim()) errors.push(`${at}.label: строка до ${LIMITS.label}`);
    if (o.href !== undefined && !relPath(o.href)) errors.push(`${at}.href: только относительный путь стены, например /wall`);
    if (o.place !== undefined) {
      const p = o.place;
      if (!isObj(p)) errors.push(`${at}.place: { x, y, k }`);
      else {
        only(p, ['x', 'y', 'k'], `${at}.place`);
        if (!num(p.x, 0, 1) || !num(p.y, 0, 1) || !num(p.k, 0.1, 10)) errors.push(`${at}.place: x, y — 0…1, k — 0.1…10`);
      }
    }
    if (o.glyph !== undefined) {
      const g = o.glyph;
      if (!isObj(g)) errors.push(`${at}.glyph: { w, h, strokes }`);
      else {
        only(g, ['w', 'h', 'strokes'], `${at}.glyph`);
        if (!num(g.w, 1, 10000) || !num(g.h, 1, 10000)) errors.push(`${at}.glyph: w, h — 1…10000`);
        if (!Array.isArray(g.strokes) || g.strokes.length > LIMITS.strokes) errors.push(`${at}.glyph.strokes: массив до ${LIMITS.strokes}`);
        else
          g.strokes.forEach((s: unknown, k: number) => {
            const sa = `${at}.glyph.strokes[${k}]`;
            if (!isObj(s)) return void errors.push(`${sa}: объект`);
            only(s, ['r', 'pts', 'closed'], sa);
            if (!num(s.r, 0.1, 500)) errors.push(`${sa}.r: 0.1…500`);
            if (s.closed !== undefined && typeof s.closed !== 'boolean') errors.push(`${sa}.closed: true или false`);
            if (!Array.isArray(s.pts) || !s.pts.length || s.pts.length > LIMITS.pts || !s.pts.every((p) => point(p, [2, 3])))
              errors.push(`${sa}.pts: от 1 до ${LIMITS.pts} точек [x, y] или [x, y, r]`);
          });
      }
    }
    if (o.area !== undefined && (!Array.isArray(o.area) || o.area.length < 3 || o.area.length > LIMITS.area || !o.area.every((p) => point(p, [2]))))
      errors.push(`${at}.area: от 3 до ${LIMITS.area} точек [x, y]`);
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
    if (o.glyph === undefined && o.area === undefined && o.place === undefined) errors.push(`${at}: нужны жилы (glyph) или область (area) с местом (place)`);
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
}

/** Опубликованная сцена: последняя по времени публикации; нет — встроенная. */
export async function publishedScene(env: Env): Promise<{ version: number; json: string; scene: Scene }> {
  const r = await env.DB.prepare(`SELECT version, json FROM scenes WHERE status = 'опубликована' ORDER BY published_at DESC, version DESC LIMIT 1`).first<{
    version: number;
    json: string;
  }>();
  if (r) return { version: r.version, json: r.json, scene: JSON.parse(r.json) as Scene };
  return { version: 0, json: JSON.stringify(DEFAULT_SCENE), scene: DEFAULT_SCENE };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Слой <nav>: по пункту на объект, в порядке Tab. Ссылка объекта — настоящий <a>; окно — его заголовок, текст и ссылки,
 * чтобы модели и экранные чтецы видели то же, что люди в окне. Объект с окном без адреса ссылается на свой пункт (#w-id).
 */
export function sceneNav(o: string, scene: Scene): string {
  return scene.objects
    .map((x) => {
      const href = x.href ? o + x.href : `#w-${x.id}`;
      let li = `<li id="w-${esc(x.id)}"><a data-id="${esc(x.id)}" href="${esc(href)}">${esc(x.label)}</a>`;
      const w = x.window;
      if (w) {
        if (w.title) li += `\n<h2>${esc(w.title)}</h2>`;
        if (w.text) li += `\n<p>${esc(w.text)}</p>`;
        if (w.links?.length) li += `\n<ul>${w.links.map((l) => `<li><a href="${esc(o + l.href)}">${esc(l.label)}</a></li>`).join('')}</ul>`;
      }
      return li + '</li>';
    })
    .join('\n');
}
