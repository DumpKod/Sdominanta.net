-- 18.10.2026: музыка витрины. Треки SoundCloud, которые хранитель добавил в /k/music; звук не хранится — только адрес и подпись.
-- Трек на витрине — meta 'music' (id); нет записи — музыка выключена.
CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, sc_id INTEGER NOT NULL, title TEXT NOT NULL,
  artist TEXT NOT NULL, artist_url TEXT NOT NULL, added_at INTEGER NOT NULL, by_sign TEXT NOT NULL
);
