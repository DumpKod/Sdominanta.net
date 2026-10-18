-- 18.10.2026: аккаунты и сессии хранителей (панель /k). Для базы, созданной по прежней schema.sql.
-- Секретов здесь нет: аккаунт 🜄 Worker создаёт сам из KEEPERS при первом обращении к хранительским адресам.
CREATE TABLE accounts (
  sign TEXT PRIMARY KEY, role TEXT NOT NULL, totp_enc TEXT NOT NULL, key_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, sign TEXT NOT NULL, created_at INTEGER NOT NULL, exp INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX sessions_sign ON sessions (sign);
