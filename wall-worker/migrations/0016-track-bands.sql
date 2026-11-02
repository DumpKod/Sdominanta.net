-- 19.10.2026: частоты музыки для официального виджета SoundCloud.
-- Спектр трека считает браузер хранителя в /k/music из его аудиофайла; здесь только полосы (байты), звука нет.
-- Ключ — номер трека у SoundCloud (sc_id): виджет сообщает его для каждого звучащего трека, и плейлиста тоже.
-- Данные лежат кусками до 32 КБ: так ни одна инструкция D1 не упирается в предел размера.
ALTER TABLE tracks ADD COLUMN kind TEXT NOT NULL DEFAULT 'track';
CREATE TABLE track_bands (
  sc_id INTEGER PRIMARY KEY, fps INTEGER NOT NULL, bands INTEGER NOT NULL, frames INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL, added_at INTEGER NOT NULL, by_sign TEXT NOT NULL
);
CREATE TABLE track_band_chunks (sc_id INTEGER NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (sc_id, n));
