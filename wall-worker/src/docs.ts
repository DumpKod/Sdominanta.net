import { keeperSession } from './panel';
import { Env, md, next, nowSec } from './util';

// Документы архива сети: файлы Claude-Aleph-Archive, очищенные от личного (tools/clean-archive.py), — /doc/{name}.
// Узлы ссылаются на них полем files[].doc; опубликованный документ узел показывает ссылкой, черновик — только именем.

export const DOC_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}$/;

export interface DocRow {
  name: string;
  path: string;
  title: string;
  body: string;
  state: string;
  created_at: number;
  published_at: number | null;
}

/** Имена опубликованных документов (для ссылок из окон узлов). */
export async function publishedDocs(env: Env): Promise<Set<string>> {
  const r = await env.DB.prepare(`SELECT name FROM docs WHERE state = 'опубликован'`).all<{ name: string }>();
  return new Set(r.results.map((x) => x.name));
}

/** /doc/{name}: текст документа как есть (markdown); черновик — только хранителю; узлы, которые на него ссылаются, — внизу. */
export async function docPage(req: Request, env: Env, o: string, name: string): Promise<Response | null> {
  if (!DOC_RE.test(name)) return null;
  const d = await env.DB.prepare('SELECT * FROM docs WHERE name = ?').bind(name).first<DocRow>();
  if (!d) return null;
  const keeper = d.state !== 'опубликован' && !!(await keeperSession(env, req, nowSec()));
  if (d.state !== 'опубликован' && !keeper) return null;
  const nodes = (await env.DB.prepare(`SELECT id, sign, title, parent FROM nodes WHERE state = 'опубликован' AND files LIKE ? ORDER BY id`)
    .bind(`%"doc":"${name}"%`).all<{ id: string; sign: string | null; title: string; parent: string | null }>()).results;
  const head = `> Архив сети: \`${d.path}\`${keeper ? ' · черновик — видит только хранитель' : ''}\n\n`;
  const body = d.body.trimEnd() + '\n';
  const links: [string, string][] = nodes.map((n) => [`Узел: ${n.sign ? n.sign + ' ' : ''}${n.title}`, `${o}/in/${n.parent ?? n.id}`]);
  return md(head + body + next([...links, ['Ядро Алеф-теории', `${o}/in/aleph`], ['Вход для моделей', `${o}/llms.txt`]]), { maxAge: keeper ? 0 : 300, noStore: keeper });
}
