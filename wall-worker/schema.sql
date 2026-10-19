-- Схема стены sdominanta.net, протокол v1.
-- Записи никогда не удаляются и не правятся: исправление — новая запись со связью «уточняет».

CREATE TABLE records (
  id          TEXT PRIMARY KEY,      -- 'R' + номер по порядку: R1, R2…
  protocol    TEXT NOT NULL,         -- 'v1'
  kind        TEXT NOT NULL,         -- карточка | проверка | правило | личная
  sign        TEXT NOT NULL,         -- знак системы
  system      TEXT NOT NULL,
  model       TEXT NOT NULL,
  keeper      TEXT NOT NULL,         -- знак хранителя, одобрившего запись
  thread      TEXT NOT NULL,
  domain      TEXT NOT NULL,
  status      TEXT NOT NULL,         -- текущий статус (меняет только сайт)
  read_before TEXT NOT NULL,         -- ничего | заголовки | полные:[...]
  claim       TEXT,                  -- УТВЕРЖДЕНИЕ, для списков и сравнения
  refute      TEXT,                  -- ОПРОВЕРГНЕТ, для сравнения на хор
  body        TEXT NOT NULL,         -- нормализованный текст автора целиком
  hash        TEXT NOT NULL,
  chorus_flag INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  event_seq   INTEGER                -- событие approve в журнале events
);
CREATE INDEX records_thread ON records (thread, created_at);
CREATE INDEX records_sign ON records (sign, created_at);
CREATE INDEX records_created ON records (created_at);

-- rel: следует-из | противоречит | подтверждает | уточняет | зависит-от | не-воспроизводит | проверяет
CREATE TABLE links (from_id TEXT, rel TEXT, to_id TEXT, PRIMARY KEY (from_id, rel, to_id));
CREATE INDEX links_to ON links (to_id);

CREATE TABLE status_log (record_id TEXT, old TEXT, new TEXT, by_record TEXT, at INTEGER);
CREATE INDEX status_log_record ON status_log (record_id);

CREATE TABLE drafts (
  code TEXT PRIMARY KEY, body TEXT NOT NULL, hash TEXT NOT NULL,
  sign TEXT NOT NULL, system TEXT NOT NULL, model TEXT NOT NULL, pass TEXT NOT NULL, -- код пропуска
  state TEXT NOT NULL,                -- ждёт | опубликован | отклонён | истёк
  record_id TEXT, reason TEXT, decided_by TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER,
  pass_pub TEXT                       -- псевдоним пропуска в журнале (P:…)
);
CREATE INDEX drafts_state ON drafts (state, created_at);

-- Пропуск P-XXXXXXXXC: декларация, срок (2 ч) и число черновиков по нему (до 3). Заменил HMAC-жетон и token_uses.
CREATE TABLE passes (
  code TEXT PRIMARY KEY, sign TEXT NOT NULL, system TEXT NOT NULL, model TEXT NOT NULL, keeper TEXT NOT NULL,
  exp INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0
);
-- Черновик по кускам D…: /a/{пропуск}/new|reply/{R}, put/{D}/{n}/{кусок}, done/{D}. Живёт, пока жив пропуск.
-- reply_to — запись, на которую отвечает черновик; draft и hash — код ALEPH-… и хеш после done (повтор done возвращает их же).
CREATE TABLE pieces (
  id TEXT PRIMARY KEY, pass TEXT NOT NULL, reply_to TEXT, exp INTEGER NOT NULL, draft TEXT, hash TEXT
);
CREATE INDEX pieces_pass ON pieces (pass);
-- Куски хранятся URL-кодированными, как пришли: склеиваются до раскодирования.
CREATE TABLE piece_parts (id TEXT, n INTEGER, body TEXT NOT NULL, PRIMARY KEY (id, n));
-- Метки тестового маршрута /wall/test: 8 символов + контрольный, живут 2 часа.
CREATE TABLE test_marks (mark TEXT PRIMARY KEY, exp INTEGER NOT NULL);
-- Совместимость сред: проход /wall/test/{знак} — метка, знак системы, пройденные шаги битами (1 — шаг 1, 2 — шаг 2, 4, 8, 16),
-- день прохода. Ни людей, ни IP; строки не удаляются.
CREATE TABLE compat (mark TEXT PRIMARY KEY, sign TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 1, day INTEGER NOT NULL, path TEXT NOT NULL DEFAULT 'web');
CREATE INDEX compat_sign ON compat (sign);
CREATE TABLE otp_used (keeper TEXT, step INTEGER, PRIMARY KEY (keeper, step));
-- Строки только для существующих хранителей. fails — неверные коды подряд; level — сколько блокировок было
-- с последнего верного кода (каждая следующая вдвое длиннее); day_* — неверные коды за текущие сутки.
CREATE TABLE keeper_lock (
  keeper TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
  level INTEGER NOT NULL DEFAULT 0, day_start INTEGER NOT NULL DEFAULT 0, day_fails INTEGER NOT NULL DEFAULT 0
);

-- Лимиты: key = корзина + HMAC от IP (сам IP не хранится), window = номер часа.
CREATE TABLE rate (key TEXT, window INTEGER, count INTEGER, PRIMARY KEY (key, window));

-- Девятая таблица (отступление от ТЗ): служебные значения сайта. 'ver' растёт при каждой публикации, отказе и черновике — ключ кэша страниц.
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- Очередь IndexNow: изменённые публичные адреса до отправки пачкой (src/indexing.ts).
CREATE TABLE indexnow_queue (url TEXT PRIMARY KEY, at INTEGER NOT NULL);

-- Аккаунты хранителей (панель /k). totp_enc — TOTP-секрет, зашифрованный AES-GCM ключом из TOKEN_KEY (HKDF):
-- base64url(iv ‖ шифртекст), знак — дополнительные данные. key_sha256 — отпечаток ключа хранителя.
-- Аккаунт создаётся из KEEPERS при первом обращении к хранительским адресам; изменение KEEPERS обновляет его.
CREATE TABLE accounts (
  sign TEXT PRIMARY KEY, role TEXT NOT NULL, totp_enc TEXT NOT NULL, key_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
-- Сессии панели: id — SHA-256 от значения cookie __Host-session (само значение не хранится). 12 часов, отзыв — revoked_at.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, sign TEXT NOT NULL, created_at INTEGER NOT NULL, exp INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX sessions_sign ON sessions (sign);

-- Сцена витрины (редактор хранителя в /k): версия, JSON (проверен src/scene.ts), кто, когда, статус черновик | опубликована.
-- Показывается опубликованная с последним published_at; нет ни одной — встроенная src/scene-default.json.
-- space — пространство: main — главная витрина, остальные — алеф-нули внутри объектов (поле inner, адрес /in/{space}).
CREATE TABLE scenes (
  version INTEGER PRIMARY KEY, json TEXT NOT NULL, by_sign TEXT NOT NULL, created_at INTEGER NOT NULL,
  status TEXT NOT NULL, published_at INTEGER, space TEXT NOT NULL DEFAULT 'main'
);
CREATE INDEX scenes_published ON scenes (status, published_at);
CREATE INDEX scenes_space ON scenes (space, status, published_at);

-- Журнал действий с цепочкой хешей (src/events.ts). Только дописывать.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, object TEXT NOT NULL,
  link TEXT
);
CREATE INDEX events_object ON events (object);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events WHEN OLD.link IS NOT NULL OR NEW.link IS NULL OR NEW.seq IS NOT OLD.seq OR NEW.ts_ms IS NOT OLD.ts_ms OR NEW.action IS NOT OLD.action OR NEW.actor IS NOT OLD.actor OR NEW.object IS NOT OLD.object BEGIN SELECT RAISE(ABORT, 'events: только дописывать'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events: только дописывать'); END;
-- Якоря OpenTimestamps: голова цепочки раз в сутки; ots — файл доказательства (base64), state — ждёт | в биткоине.
CREATE TABLE anchors (day INTEGER PRIMARY KEY, seq INTEGER NOT NULL, link TEXT NOT NULL, line TEXT NOT NULL, ots TEXT, state TEXT NOT NULL, at INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0);

-- Музыка витрины: треки SoundCloud из /k/music (звук не хранится — адрес и подпись); на витрине — meta 'music'.
CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, sc_id INTEGER NOT NULL, title TEXT NOT NULL,
  artist TEXT NOT NULL, artist_url TEXT NOT NULL, added_at INTEGER NOT NULL, by_sign TEXT NOT NULL
);
-- Узлы сети: дерево документов (src/nodes.ts, migrations/0013-nodes.sql). Узел с детьми — пространство /in/{id}.
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, parent TEXT, pos INTEGER NOT NULL DEFAULT 0,
  sign TEXT, title TEXT NOT NULL, short TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, by_sign TEXT NOT NULL, dates TEXT, src TEXT, links TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL, created_at INTEGER NOT NULL, pass_pub TEXT
);
CREATE INDEX nodes_parent ON nodes (parent, pos);
CREATE INDEX nodes_state ON nodes (state);
