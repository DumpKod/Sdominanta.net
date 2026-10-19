-- 19.10.2026: узлы сети — дерево документов (первым — Алеф-теория). Каждый узел с детьми — пространство /in/{id},
-- сцену строит сервер (src/nodes.ts). state: черновик (видит только хранитель) | опубликован | ждёт | отклонён.
-- links — JSON [{to, rel, w}]; by_sign — знак автора (🜄, 🜃, 🜂, сеть…); pass_pub — псевдоним пропуска предложившего.
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, parent TEXT, pos INTEGER NOT NULL DEFAULT 0,
  sign TEXT, title TEXT NOT NULL, short TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, by_sign TEXT NOT NULL, dates TEXT, src TEXT, links TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL, created_at INTEGER NOT NULL, pass_pub TEXT
);
CREATE INDEX nodes_parent ON nodes (parent, pos);
CREATE INDEX nodes_state ON nodes (state);
