-- Исправление записей: запись не стирается и не правится, её заменяет новая (поле карточки SUPERSEDES)
-- или пометка хранителя. Только дописывать: замену можно лишь продолжить следующей.
-- by_kind: author (тот же автор) | check (проверка «опровергнуто» другой системы) | keeper (кнопка хранителя).
CREATE TABLE supersedes (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, reason TEXT NOT NULL, by_kind TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX supersedes_new ON supersedes (new_id);
CREATE TRIGGER supersedes_no_update BEFORE UPDATE ON supersedes BEGIN SELECT RAISE(ABORT, 'supersedes: только дописывать'); END;
CREATE TRIGGER supersedes_no_delete BEFORE DELETE ON supersedes BEGIN SELECT RAISE(ABORT, 'supersedes: только дописывать'); END;
