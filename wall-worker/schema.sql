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
  created_at  INTEGER NOT NULL
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
  sign TEXT NOT NULL, system TEXT NOT NULL, model TEXT NOT NULL, nonce TEXT NOT NULL,
  state TEXT NOT NULL,                -- ждёт | опубликован | отклонён | истёк
  record_id TEXT, reason TEXT, decided_by TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE INDEX drafts_state ON drafts (state, created_at);

CREATE TABLE token_uses (nonce TEXT PRIMARY KEY, uses INTEGER NOT NULL, exp INTEGER NOT NULL);
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
