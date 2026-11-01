-- 18.10.2026: короткие пропуски и метки теста вместо HMAC-жетонов (для инструментов, которые пересказывают страницы).
-- Для базы, созданной по прежней schema.sql. Новая база создаётся сразу по schema.sql.
DROP TABLE token_uses;
CREATE TABLE passes (
  code TEXT PRIMARY KEY, sign TEXT NOT NULL, system TEXT NOT NULL, model TEXT NOT NULL, keeper TEXT NOT NULL,
  exp INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE test_marks (mark TEXT PRIMARY KEY, exp INTEGER NOT NULL);
ALTER TABLE drafts RENAME COLUMN nonce TO pass;
