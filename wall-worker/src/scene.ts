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
//     doors?: [ { area, label?, href?, inner?, widget?, window?, frame? } ]   ещё области объекта — каждая свой вход (до 16)
//     window?: { title?, text?, links?: [ { label, href } ] }   окно из пустоты по клику
//     links?: [ { to: "wall", w: 0.8 } ]  связи узла (до 10): при входе внутрь — нити сквозь горизонт к портам
//     widget?: "player"                   живое управление в окне: player, keeper, queue, music, vitrina (три последних — хранителю)
//     frame?: { width, aspect, round, ring, far, push, depth }   окно: колонка, тишина поля, порог напора, глубина провала (FRAME в public/vitrina/model.js)
//     slot?: "player"                     место для живого HTML: player — плеер, keeper — вход хранителя
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
/** Ещё одна область объекта со своим содержимым: приближение в неё — провал в своё окно, страницу, виджет или алеф-нуль. */
export interface Door {
  area: number[][];
  label?: string;
  href?: string;
  inner?: string;
  widget?: (typeof WIDGETS)[number];
  window?: { title?: string; text?: string; links?: { label: string; href: string }[] };
  frame?: Record<string, number>;
}
export interface SceneObject {
  id: string;
  label: string;
  href?: string;
  z?: number;
  strokes: Stroke[];
  area?: number[][];
  doors?: Door[];
  window?: { title?: string; text?: string; links?: { label: string; href: string }[] };
  style?: Record<string, number>;
  frame?: Record<string, number>;
  widget?: (typeof WIDGETS)[number];
  links?: { to: string; w?: number }[];
  inner?: string;
  slot?: (typeof SLOTS)[number];
}
export interface Scene {
  v: 2;
  space?: Record<string, number>;
  objects: SceneObject[];
}

export const DEFAULT_SCENE = defaultScene as Scene;
export const SCENE_MAX = 256 * 1024;

const LIMITS = { objects: 200, strokes: 400, pts: 2000, area: 200, doors: 16, links: 20, label: 200, title: 200, text: 4000, coord: 1e6 };
/** Пределы параметров — те же, что у ползунков редактора (STYLE и SPACE в public/vitrina/model.js). */
export const STYLE_RANGE: Record<string, [number, number]> = {
  tubeR: [0.5, 200], thick: [0.4, 2.5], resonance: [0, 1], tact: [0, 3], flow: [0, 2], wobble: [0, 1], fill: [0, 1], sound: [0, 2],
};
export const FRAME_RANGE: Record<string, [number, number]> = {
  width: [240, 1400], aspect: [0, 2], round: [0, 1], ring: [4, 160], far: [0, 1], push: [60, 4000], depth: [0.05, 1],
};
export const SPACE_RANGE: Record<string, [number, number]> = { drift: [0, 2], density: [0.5, 1.6], glow: [0, 1.5], haze: [0, 1.5], sound: [0, 2], reach: [0.05, 2], horizon: [0, 1] };

/** Имя пространства: main — главная витрина, остальные — алеф-нули. */
export const SPACE_RE = /^[a-z0-9-]{1,32}$/;
/** Места для живого HTML в сцене: плеер и вход хранителя. */
export const SLOTS = ['player', 'keeper'] as const;
/** Виджеты окна (WIDGETS в public/vitrina/model.js). */
export const WIDGETS = ['player', 'keeper', 'queue', 'music', 'vitrina'] as const;
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
  const areaOk = (a: unknown) => Array.isArray(a) && a.length >= 3 && a.length <= LIMITS.area && a.every((p) => point(p, [2]));
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
    only(o, ['id', 'label', 'href', 'z', 'strokes', 'area', 'doors', 'window', 'frame', 'widget', 'links', 'style', 'inner', 'slot'], at);
    if (o.links !== undefined) {
      if (!Array.isArray(o.links) || o.links.length > 10) errors.push(`${at}.links: массив до 10 связей { to, w }`);
      else
        o.links.forEach((l: unknown, k: number) => {
          const la = `${at}.links[${k}]`;
          if (!isObj(l)) return void errors.push(`${la}: { to, w }`);
          only(l, ['to', 'w'], la);
          if (typeof l.to !== 'string' || !/^[a-z0-9-]{1,32}$/.test(l.to)) errors.push(`${la}.to: id объекта`);
          if (l.w !== undefined && !num(l.w, 0, 1)) errors.push(`${la}.w: 0…1`);
        });
    }
    content(o, at);
    if (o.doors !== undefined) {
      if (!Array.isArray(o.doors) || o.doors.length > LIMITS.doors) errors.push(`${at}.doors: массив до ${LIMITS.doors} областей`);
      else
        o.doors.forEach((d: unknown, k: number) => {
          const da = `${at}.doors[${k}]`;
          if (!isObj(d)) return void errors.push(`${da}: { area, … }`);
          only(d, ['area', 'label', 'href', 'inner', 'widget', 'window', 'frame'], da);
          if (!areaOk(d.area)) errors.push(`${da}.area: от 3 до ${LIMITS.area} точек [x, y]`);
          if (d.label !== undefined && !str(d.label, LIMITS.label)) errors.push(`${da}.label: строка до ${LIMITS.label}`);
          content(d, da);
        });
    }
    if (o.slot !== undefined && !(SLOTS as readonly unknown[]).includes(o.slot)) errors.push(`${at}.slot: место — ${SLOTS.join(' или ')}`);
    if (typeof o.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(o.id)) errors.push(`${at}.id: латиница, цифры, дефис, до 32`);
    else if (ids.has(o.id)) errors.push(`${at}.id: «${o.id}» повторяется`);
    else ids.add(o.id);
    if (!str(o.label, LIMITS.label) || !(o.label as string).trim()) errors.push(`${at}.label: строка до ${LIMITS.label}`);
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
    if (o.area !== undefined && !areaOk(o.area)) errors.push(`${at}.area: от 3 до ${LIMITS.area} точек [x, y]`);
    if (o.style !== undefined) params(o.style, STYLE_RANGE, `${at}.style`);
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return { ok: true, scene: j as unknown as Scene };

  /** Содержимое входа — у объекта и у каждой его области: адрес, алеф-нуль, виджет, окно, рама. */
  function content(o: Record<string, unknown>, at: string) {
    if (o.widget !== undefined && !(WIDGETS as readonly unknown[]).includes(o.widget)) errors.push(`${at}.widget: ${WIDGETS.join(', ')}`);
    if (o.inner !== undefined && (typeof o.inner !== 'string' || !SPACE_RE.test(o.inner) || o.inner === 'main'))
      errors.push(`${at}.inner: имя пространства — латиница, цифры, дефис, до 32, не main`);
    if (o.href !== undefined && !relPath(o.href)) errors.push(`${at}.href: только относительный путь стены, например /wall`);
    if (o.frame !== undefined) params(o.frame, FRAME_RANGE, `${at}.frame`);
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
  }
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
      // области-входы объекта: каждая своей ссылкой (и текстом окна) — моделям и чтецам без камеры
      const doors = (x.doors ?? []).map((d) => {
        const dh = d.inner ? `${o}/in/${d.inner}` : d.href ? o + d.href : null, label = d.label || d.window?.title || x.label;
        let di = dh ? `<li><a href="${esc(dh)}">${esc(label)}</a>` : `<li>${esc(label)}`;
        if (d.window?.text) di += `\n<p>${esc(d.window.text)}</p>`;
        if (d.window?.links?.length) di += `\n<ul>${d.window.links.map((l) => `<li><a href="${esc(o + l.href)}">${esc(l.label)}</a></li>`).join('')}</ul>`;
        return di + '</li>';
      });
      if (doors.length) li += `\n<ul>${doors.join('')}</ul>`;
      return li + '</li>';
    });
  if (back !== undefined) items.unshift(`<li><a data-back="1" href="${esc(o + back)}">Наружу</a></li>`);
  return items.join('\n');
}
