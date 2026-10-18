-- 18.10.2026: путь прохода проверки инструментов — web (адреса /wall/test) или mcp (инструмент test_step).
ALTER TABLE compat ADD COLUMN path TEXT NOT NULL DEFAULT 'web';
