// Дерево узлов (JSON формата aleph-tree: nodes[] с id, sign, title, short, body, status, by, dates, links, children, src)
// → SQL для таблицы nodes (migrations/0013-nodes.sql). Узлы встают черновиком: их видит только хранитель, публикует — он.
//   node tools/aleph-nodes.mjs aleph-tree-v1.json [state] > nodes.sql
//   npx wrangler d1 execute sdominanta --remote --file=nodes.sql
// Повторная заливка заменяет узлы с теми же id (INSERT OR REPLACE): правки дерева — новой версией файла.
import { readFileSync } from 'node:fs';

const [file, state = 'черновик'] = process.argv.slice(2);
const tree = JSON.parse(readFileSync(file, 'utf8'));
const ID = /^[a-z0-9-]{1,32}$/;
const STATUSES = ['postulate', 'theorem', 'computed', 'hypothesis', 'live', 'refuted'];
const RELS = ['follows-from', 'supports', 'refines', 'depends-on', 'contradicts'];
const byId = new Map(tree.nodes.map((n) => [n.id, n]));
const parent = new Map(), pos = new Map();
for (const n of tree.nodes) (n.children || []).forEach((c, i) => { parent.set(c, n.id); pos.set(c, i); });

const errors = [];
for (const n of tree.nodes) {
  if (!ID.test(n.id)) errors.push(`${n.id}: id — латиница, цифры, дефис, до 32`);
  if (!STATUSES.includes(n.status)) errors.push(`${n.id}: статус ${n.status}`);
  for (const c of n.children || []) if (!byId.has(c)) errors.push(`${n.id}: ребёнка ${c} нет`);
  for (const l of n.links || []) if (!byId.has(l.to) || !RELS.includes(l.rel)) errors.push(`${n.id}: связь ${JSON.stringify(l)}`);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

const q = (v) => (v === null || v === undefined || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const now = Math.floor(Date.now() / 1000);
const rows = tree.nodes.map((n) => {
  const links = (n.links || []).map((l) => ({ to: l.to, rel: l.rel, w: typeof l.w === 'number' ? l.w : 0.5 }));
  return `INSERT OR REPLACE INTO nodes (id, parent, pos, sign, title, short, body, status, by_sign, dates, src, links, state, created_at) VALUES (` +
    [q(n.id), q(parent.get(n.id)), pos.get(n.id) ?? 0, q(n.sign), q(n.title), `'${(n.short || '').replace(/'/g, "''")}'`, `'${(n.body || '').replace(/'/g, "''")}'`,
      q(n.status), q(n.by || 'сеть'), q(n.dates), q(n.src), `'${JSON.stringify(links).replace(/'/g, "''")}'`, q(state), now].join(', ') + ');';
});
console.log(rows.join('\n'));
