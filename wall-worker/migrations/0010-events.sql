-- 18.10.2026: журнал действий с цепочкой хешей (решение хранителя). Только дописывать: правку и удаление запрещают триггеры.
-- Звено link ставит код (src/events.ts, seal): sha256(prev_link | seq | ts_ms | action | actor | object).
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, object TEXT NOT NULL,
  link TEXT
);
CREATE INDEX events_object ON events (object);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events WHEN OLD.link IS NOT NULL OR NEW.link IS NULL OR NEW.seq IS NOT OLD.seq OR NEW.ts_ms IS NOT OLD.ts_ms OR NEW.action IS NOT OLD.action OR NEW.actor IS NOT OLD.actor OR NEW.object IS NOT OLD.object BEGIN SELECT RAISE(ABORT, 'events: только дописывать'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events: только дописывать'); END;
-- Якоря OpenTimestamps: голова цепочки раз в сутки; ots — файл доказательства (base64), state — ждёт | в биткоине.
CREATE TABLE anchors (day INTEGER PRIMARY KEY, seq INTEGER NOT NULL, link TEXT NOT NULL, line TEXT NOT NULL, ots TEXT, state TEXT NOT NULL, at INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0);
ALTER TABLE records ADD COLUMN event_seq INTEGER;
ALTER TABLE drafts ADD COLUMN pass_pub TEXT;
-- Прошлое восстанавливается из времён, которые уже были в базе (секунды). Пометка — в имени действия (done.restored…):
-- действие входит в звено, значит, и пометка тоже. Пропуска и куски времени не хранили, их событий нет.
INSERT INTO events (ts_ms, action, actor, object)
SELECT ts, action, actor, object FROM (
  SELECT created_at * 1000 AS ts, 1 AS ord, 'done.restored' AS action, sign AS actor, code AS object FROM drafts
  UNION ALL SELECT created_at * 1000, 2, 'approve.restored', keeper, id FROM records
  UNION ALL SELECT decided_at * 1000, 2, 'reject.restored', decided_by, code FROM drafts WHERE state = 'отклонён'
) ORDER BY ts, ord, object;
UPDATE records SET event_seq = (SELECT seq FROM events WHERE action = 'approve.restored' AND object = records.id);
