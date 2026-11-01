import { Env, buildId } from './util';
import { publishedScene, Scene, validateScene } from './scene';
import { NodeRow, visibleNodes } from './nodes';
import main from './editor/main.js.txt';
import dom from './editor/dom.js.txt';
import doc from './editor/doc.js.txt';
import geom from './editor/geom.js.txt';
import io from './editor/io.js.txt';
import shell from './editor/shell.js.txt';
import layers from './editor/layers.js.txt';
import inspector from './editor/inspector.js.txt';
import insert from './editor/insert.js.txt';
import tools from './editor/tools.js.txt';
import keeper from './editor/keeper.js.txt';
import css from './editor/editor.css.txt';

// Редактор витрины v2 (решения хранителя 19.10): модули ES, отдаются только в сессии хранителя (/k/ed/…).
// Сервер добавляет к нему карту слоёв (/k/vitrina/spaces.json) и аварийную ячейку слоя (/k/vitrina/recover…).

const FILES: Record<string, [string, string]> = {
  'main.js': [main, 'js'], 'dom.js': [dom, 'js'], 'doc.js': [doc, 'js'], 'geom.js': [geom, 'js'], 'io.js': [io, 'js'],
  'shell.js': [shell, 'js'], 'layers.js': [layers, 'js'], 'inspector.js': [inspector, 'js'], 'insert.js': [insert, 'js'],
  'tools.js': [tools, 'js'], 'keeper.js': [keeper, 'js'], 'editor.css': [css, 'css'],
};

/** Файл редактора: ETag — номер выкладки, браузер сверяется каждый раз (304, пока деплоя не было). */
export function editorFile(env: Env, req: Request, name: string): Response | null {
  const f = FILES[name];
  if (!f) return null;
  const tag = `"ed-${buildId(env)}"`;
  const headers = {
    'Content-Type': f[1] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
    'Cache-Control': 'private, no-cache', ETag: tag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  };
  if (req.headers.get('If-None-Match') === tag) return new Response(null, { status: 304, headers });
  return new Response(f[0], { headers });
}

export interface SpaceItem {
  space: string;
  parent: string | null;
  /** объект родителя, через который входят; у узла — сам узел */
  from: string | null;
  label: string;
  /** опубликован | черновик | пусто | узел */
  state: string;
  version: number;
  /** последняя версия слоя (черновик или опубликованная) */
  last: number;
  /** есть черновик новее опубликованной версии */
  draft: boolean;
}

/**
 * Карта слоёв для навигатора: нарисованные пространства (связь — inner у объекта или области родителя),
 * пространства узлов сети (узел с детьми) и пространства без входа. Корень — main.
 */
export async function spacesTree(env: Env): Promise<SpaceItem[]> {
  const rows = (await env.DB.prepare(
    `SELECT space, MAX(version) AS last, MAX(CASE WHEN status = 'опубликована' THEN version END) AS pub FROM scenes GROUP BY space`,
  ).all<{ space: string; last: number; pub: number | null }>()).results;
  const items = new Map<string, SpaceItem>();
  const add = (it: SpaceItem) => { if (!items.has(it.space)) items.set(it.space, it); };
  const edges: { parent: string; child: string; from: string; label: string }[] = [];
  const spaces = new Set(['main', ...rows.map((r) => r.space)]);
  for (const sp of spaces) {
    const { scene, version } = await publishedScene(env, sp);
    const r = rows.find((x) => x.space === sp);
    add({ space: sp, parent: null, from: null, label: sp === 'main' ? 'Главная' : sp, state: version ? 'опубликован' : r ? 'черновик' : 'пусто', version, last: r ? r.last : 0, draft: !!r && r.last > (r.pub ?? 0) });
    for (const o of (scene as Scene).objects) {
      if (o.inner) edges.push({ parent: sp, child: o.inner, from: o.id, label: o.label || o.inner });
      for (const d of o.doors ?? []) if (d.inner) edges.push({ parent: sp, child: d.inner, from: o.id, label: d.label || o.label || d.inner });
    }
  }
  const nodes = await visibleNodes(env, true);
  const kids = new Map<string, NodeRow[]>();
  for (const n of nodes.values()) if (n.parent && nodes.has(n.parent)) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
  for (const n of nodes.values()) {
    if (!kids.has(n.id)) continue;
    const it = items.get(n.id);
    const label = n.sign ? `${n.sign} ${n.title}` : n.title;
    if (it) { it.label = label; it.state = it.state === 'пусто' ? 'узел' : it.state; }
    else add({ space: n.id, parent: null, from: n.id, label, state: 'узел', version: 0, last: 0, draft: false });
    if (n.parent && kids.has(n.parent)) edges.push({ parent: n.parent, child: n.id, from: n.id, label });
  }
  for (const e of edges) {
    if (e.child === 'main' || e.child === e.parent) continue;
    const it = items.get(e.child) ?? (add({ space: e.child, parent: null, from: null, label: e.label, state: 'пусто', version: 0, last: 0, draft: false }), items.get(e.child)!);
    if (!it.parent) { it.parent = e.parent; it.from = e.from; if (it.label === it.space) it.label = e.label; }
  }
  // петли (слой внутри самого себя через цепочку) рвутся: такой слой показывается без родителя
  for (const it of items.values()) {
    const seen = new Set<string>();
    for (let p = it.parent; p; p = items.get(p)?.parent ?? null) {
      if (seen.has(p) || p === it.space) { it.parent = null; break; }
      seen.add(p);
    }
  }
  return [...items.values()];
}

/** Аварийная копия слоя: проверяется как сцена, ячейка одна на пространство. null — сохранено, иначе ошибки. */
export async function saveRecovery(env: Env, space: string, raw: string, by: string, now: number): Promise<string[] | null> {
  const v = validateScene(raw);
  if (!v.ok) return v.errors;
  await env.DB.prepare(
    'INSERT INTO scene_recovery (space, json, at, by_sign) VALUES (?, ?, ?, ?) ON CONFLICT (space) DO UPDATE SET json = excluded.json, at = excluded.at, by_sign = excluded.by_sign',
  ).bind(space, JSON.stringify(v.scene), now, by).run();
  return null;
}

export const getRecovery = (env: Env, space: string) =>
  env.DB.prepare('SELECT json, at, by_sign FROM scene_recovery WHERE space = ?').bind(space).first<{ json: string; at: number; by_sign: string }>();

export const dropRecovery = (env: Env, space: string) => env.DB.prepare('DELETE FROM scene_recovery WHERE space = ?').bind(space);
