-- 19.10.2026: документы архива сети (первым — Claude-Aleph-Archive), очищенные от личного (tools/clean-archive.py).
-- Адрес /doc/{name}; state: черновик (видит только хранитель) | опубликован. Публикуются партиями по слову хранителя.
CREATE TABLE docs (
  name TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  state TEXT NOT NULL, created_at INTEGER NOT NULL, published_at INTEGER
);
CREATE INDEX docs_state ON docs (state);
