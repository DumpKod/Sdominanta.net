import { Env } from './util';
import { Scene, SceneObject } from './scene';

// Узлы сети: дерево документов (первым — Алеф-теория, tools/aleph-nodes.mjs). Узел — один документ: знак, название,
// краткий текст, тело, статус, автор, даты, источник, связи с другими узлами. Каждый узел — своё пространство /in/{id}:
// в центре он сам (окно с текстом), вокруг — его дети кольцами; ребёнок с детьми — портал глубже, без детей — окно.
// Сцену пространства строит сервер (nodeScene); нарисованное хранителем в том же пространстве остаётся поверх.
// Состояния: черновик (видит только хранитель) → опубликован; предложенный моделью или человеком — ждёт → решение хранителя.

export const NODE_RE = /^[a-z0-9-]{1,32}$/;
export const NODE_STATUSES = ['postulate', 'theorem', 'computed', 'hypothesis', 'live', 'refuted'] as const;
export const NODE_RELS = ['follows-from', 'supports', 'refines', 'depends-on', 'contradicts'] as const;
export const NODE_LIMITS = { sign: 8, title: 120, short: 2000, body: 20000, by: 32, dates: 80, src: 300, links: 20 };
export const STATUS_NAMES: Record<string, string> = {
  postulate: 'постулат', theorem: 'доказано', computed: 'вычислено', hypothesis: 'гипотеза', live: 'живое предсказание', refuted: 'опровергнуто',
};
const REL_NAMES: Record<string, [string, string]> = {
  'follows-from': ['следует из', 'из него следует'],
  supports: ['подтверждает', 'его подтверждает'],
  refines: ['уточняет', 'его уточняет'],
  'depends-on': ['зависит от', 'от него зависит'],
  contradicts: ['противоречит', 'ему противоречит'],
};

export interface NodeLink { to: string; rel: string; w?: number }
export interface NodeRow {
  id: string;
  parent: string | null;
  pos: number;
  sign: string | null;
  title: string;
  short: string;
  body: string;
  status: string;
  by_sign: string;
  dates: string | null;
  src: string | null;
  links: string; // JSON NodeLink[]
  state: string; // черновик | опубликован | ждёт | отклонён
  created_at: number;
  pass_pub: string | null;
  files?: string; // JSON [{name, drive?, url?}] — первоисточники в архиве (migrations/0014-node-files.sql)
}

/** Узлы, видимые зрителю: гостю — опубликованные; хранителю — ещё черновики и ждущие решения. */
export async function visibleNodes(env: Env, keeper: boolean): Promise<Map<string, NodeRow>> {
  const states = keeper ? ['опубликован', 'черновик', 'ждёт'] : ['опубликован'];
  const r = await env.DB.prepare(`SELECT * FROM nodes WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY parent, pos, created_at`)
    .bind(...states).all<NodeRow>();
  return new Map(r.results.map((n) => [n.id, n]));
}

export const linksOf = (n: NodeRow): NodeLink[] => {
  try {
    const l = JSON.parse(n.links);
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
};
const childrenOf = (all: Map<string, NodeRow>, id: string) => [...all.values()].filter((n) => n.parent === id);
/** Где узел виден: свой узел с детьми — его пространство, иначе — пространство родителя. */
export const spaceOfNode = (all: Map<string, NodeRow>, id: string) => {
  const n = all.get(id);
  if (!n) return null;
  return childrenOf(all, id).length || !n.parent ? id : n.parent;
};
const titleOf = (n: NodeRow) => (n.sign ? `${n.sign} ${n.title}` : n.title);

/** Текст окна узла: краткий текст, тело, строка учёта; ссылки — связи в обе стороны и путь наверх. */
/** Первоисточники узла: имена — всем; адреса архива (Drive, позже R2) — только хранителю, пока архив не открыт. */
function filesLine(n: NodeRow, keeper: boolean): string {
  let f: { name?: string; url?: string }[] = [];
  try {
    f = JSON.parse(n.files || '[]');
  } catch { /* битое поле — без первоисточников */ }
  const list = (Array.isArray(f) ? f : []).filter((x) => x && typeof x.name === 'string');
  if (!list.length) return '';
  const item = (x: { name?: string; url?: string }) =>
    keeper && typeof x.url === 'string' && /^https:\/\//.test(x.url) ? `[${x.name}](${x.url})` : `\`${x.name}\``;
  return 'Первоисточники: ' + list.map(item).join(', ');
}

export function nodeWindow(all: Map<string, NodeRow>, n: NodeRow, keeper = false): NonNullable<SceneObject['window']> {
  const meta = [`Статус: ${STATUS_NAMES[n.status] ?? n.status}`, `Автор: ${n.by_sign}`];
  if (n.dates) meta.push(`Даты: ${n.dates}`);
  if (n.src) meta.push(`Источник: ${n.src}`);
  if (n.state !== 'опубликован') meta.push(`Видит только хранитель: ${n.state}`);
  const text = [n.short, n.body, [meta.join(' · '), filesLine(n, keeper)].filter(Boolean).join('\n')].filter((s) => s && s.trim()).join('\n\n---\n\n');
  const links: { label: string; href: string }[] = [];
  const href = (id: string) => `/in/${spaceOfNode(all, id)}`;
  for (const l of linksOf(n)) {
    const t = all.get(l.to);
    if (t) links.push({ label: `${REL_NAMES[l.rel]?.[0] ?? l.rel}: ${titleOf(t)}`, href: href(t.id) });
  }
  for (const m of all.values())
    for (const l of linksOf(m)) if (l.to === n.id) links.push({ label: `${REL_NAMES[l.rel]?.[1] ?? l.rel}: ${titleOf(m)}`, href: href(m.id) });
  // внутри: дети со своими пространствами (листья — кольца рядом, их окна открываются приближением)
  for (const c of childrenOf(all, n.id)) if (spaceOfNode(all, c.id) === c.id) links.push({ label: `Внутри: ${titleOf(c)}`, href: href(c.id) });
  if (n.parent && all.has(n.parent)) links.push({ label: `Выше: ${titleOf(all.get(n.parent)!)}`, href: href(n.parent) });
  return { title: titleOf(n), text, ...(links.length ? { links: links.slice(0, 40) } : {}) };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
/** Кольцо узла с лёгкой неровностью (детерминированно от id) — та же жила, что у графа сети (tools/net-scene.mjs). */
function ring(id: string, x: number, y: number, R: number, tube: number) {
  let h = 0;
  for (const ch of id) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  const pts: number[][] = [];
  const n = Math.max(16, Math.round(R / 3));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.06 * Math.sin(a * 3 + (h % 7)) + 0.04 * Math.sin(a * 5 + (h % 11));
    pts.push([r1(x + Math.cos(a) * R * k), r1(y + Math.sin(a) * R * k)]);
  }
  return { r: tube, pts, closed: true };
}
const circle = (x: number, y: number, R: number, n = 20) =>
  Array.from({ length: n }, (_, i) => [r1(x + Math.cos((i / n) * Math.PI * 2) * R), r1(y + Math.sin((i / n) * Math.PI * 2) * R)]);
/** Нить между кольцами: от края до края, чуть изогнутая. */
function strand(A: { x: number; y: number; R: number }, B: { x: number; y: number; R: number }, r: number) {
  const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  const x0 = A.x + ux * A.R * 1.15, y0 = A.y + uy * A.R * 1.15, x1 = B.x - ux * B.R * 1.15, y1 = B.y - uy * B.R * 1.15;
  const mx = (x0 + x1) / 2 - uy * d * 0.08, my = (y0 + y1) / 2 + ux * d * 0.08, pts: number[][] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, u = 1 - t;
    pts.push([r1(u * u * x0 + 2 * u * t * mx + t * t * x1), r1(u * u * y0 + 2 * u * t * my + t * t * y1)]);
  }
  return { r, pts };
}
// статус — характер жилы: постулат толще, опровергнутое тонкое и дрожит, живое предсказание резонирует
const STATUS_STYLE: Record<string, Record<string, number>> = {
  postulate: { thick: 1.7, resonance: 0.3 },
  theorem: { thick: 1.4, resonance: 0.35 },
  computed: { resonance: 0.4 },
  hypothesis: { wobble: 0.45, resonance: 0.4 },
  live: { resonance: 0.85, tact: 0.6 },
  refuted: { thick: 0.6, fill: 0.3, wobble: 0.6, resonance: 0.1 },
};

/** Объекты пространства узла id: он в центре, дети по кругу, нити — к детям и связи между ними. Пусто — узла нет. */
export function nodeObjects(all: Map<string, NodeRow>, id: string, keeper = false): SceneObject[] {
  const n = all.get(id);
  if (!n) return [];
  const kids = childrenOf(all, id);
  const size = (k: string): number => 1 + childrenOf(all, k).reduce((s, c) => s + size(c.id), 0);
  const C = { x: 720, y: 450, R: 54 };
  const D = Math.max(230, 70 + kids.length * 36);
  const pos = new Map<string, { x: number; y: number; R: number }>([[id, C]]);
  kids.forEach((k, i) => {
    const a = -Math.PI / 2 + (i / kids.length) * Math.PI * 2;
    pos.set(k.id, { x: C.x + Math.cos(a) * D, y: C.y + Math.sin(a) * D * 0.82, R: Math.min(48, 22 + 7 * Math.sqrt(size(k.id))) });
  });
  const obj = (k: NodeRow, center: boolean): SceneObject => {
    const p = pos.get(k.id)!;
    const o: SceneObject = { id: k.id, label: titleOf(k), z: center ? 2 : 1, strokes: [ring(k.id, p.x, p.y, p.R, center ? 6 : 3.6)] };
    o.area = circle(p.x, p.y, p.R * 1.3 + 6);
    if (!center && childrenOf(all, k.id).length) o.inner = k.id;
    else o.window = nodeWindow(all, k, keeper);
    o.style = STATUS_STYLE[k.status] ?? {};
    const near = linksOf(k).filter((l) => l.to !== k.id && pos.has(l.to)).map((l) => ({ to: l.to, w: Math.max(0, Math.min(1, l.w ?? 0.5)) }));
    if (near.length) o.links = near.slice(0, 10);
    return o;
  };
  const objects = [obj(n, true), ...kids.map((k) => obj(k, false))];
  const strokes = kids.map((k) => strand(C, pos.get(k.id)!, 1.2));
  for (const k of [n, ...kids])
    for (const l of linksOf(k)) if (l.to !== k.id && l.to !== id && k.id !== id && pos.has(l.to)) strokes.push(strand(pos.get(k.id)!, pos.get(l.to)!, 0.6 + 1.2 * (l.w ?? 0.5)));
  if (strokes.length) objects.push({ id: `${id}-links`, label: `Связи: ${titleOf(n)}`, z: -1, strokes, style: { resonance: 0.1, tact: 0.4, flow: 1.4, fill: 0.3 } });
  for (const o of objects) o.auto = 'node';
  return objects;
}

/**
 * Сцена пространства с узлами: нарисованное (drawn) поверх, узлы — под ним; совпадающие id остаются за нарисованным.
 * Узла с таким именем нет — сцена как была.
 */
export function withNodes(drawn: Scene, all: Map<string, NodeRow>, space: string, keeper = false): Scene {
  if (spaceOfNode(all, space) !== space) return drawn; // лист дерева — окно в пространстве родителя, не своё пространство
  const gen = nodeObjects(all, space, keeper);
  if (!gen.length) return drawn;
  const own = new Set(drawn.objects.map((o) => o.id));
  return { ...drawn, objects: [...gen.filter((o) => !own.has(o.id)), ...drawn.objects] };
}

/** Откуда входят в пространство узла: пространство родителя (у корня дерева — не отсюда, ищет сцена). */
export function nodeParent(all: Map<string, NodeRow>, space: string): { space: string; id: string } | null {
  const n = all.get(space);
  if (!n || !n.parent || !all.has(n.parent)) return null;
  return { space: spaceOfNode(all, n.parent)!, id: space };
}
