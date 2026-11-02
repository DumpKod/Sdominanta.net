-- 18.10.2026: язык действий в адресах /a/{пропуск}/… — черновики по кускам.
-- Для базы, созданной по прежней schema.sql. Новая база создаётся сразу по schema.sql.
CREATE TABLE pieces (
  id TEXT PRIMARY KEY, pass TEXT NOT NULL, reply_to TEXT, exp INTEGER NOT NULL, draft TEXT, hash TEXT
);
CREATE INDEX pieces_pass ON pieces (pass);
CREATE TABLE piece_parts (id TEXT, n INTEGER, body TEXT NOT NULL, PRIMARY KEY (id, n));
