-- 18.10.2026: таблица совместимости сред — итоги /wall/test по знаку системы.
-- Для базы, созданной по прежней schema.sql. Новая база создаётся сразу по schema.sql.
CREATE TABLE compat (mark TEXT PRIMARY KEY, sign TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 1, day INTEGER NOT NULL);
CREATE INDEX compat_sign ON compat (sign);
