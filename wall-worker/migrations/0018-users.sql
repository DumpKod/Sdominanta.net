-- Аккаунты людей (решение хранителя 20.10): отдельно от хранителей и их панели /k.
-- Регистрацию начинает модель (/a/{пропуск}/invite → код U…), заканчивает человек в своём браузере (/join):
-- секрет аутентификатора создаётся и показывается только там, модель его не видит.
-- Код приглашения хранится отпечатком; claim — отпечаток жетона браузера, открывшего код (дописать может только он).
CREATE TABLE user_invites (
  code TEXT PRIMARY KEY, sign TEXT NOT NULL, model TEXT NOT NULL, pass TEXT NOT NULL,
  created_at INTEGER NOT NULL, exp INTEGER NOT NULL, claim TEXT, name TEXT, totp_enc TEXT, used_at INTEGER, user_id INTEGER
);
CREATE INDEX user_invites_pass ON user_invites (pass);
-- name — имя, которое человек выбрал сам; name_key — оно же строчными (уникально без учёта регистра, и для кириллицы);
-- invited_by — знак модели.
CREATE TABLE users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, totp_enc TEXT NOT NULL,
  invited_by TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE user_sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, exp INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX user_sessions_user ON user_sessions (user_id);
-- Неверные коды входа: как у хранителя — 5 подряд → блокировка 15 мин · 2ⁿ, не больше суток; код не принимается дважды.
CREATE TABLE user_lock (user_id INTEGER PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0, locked_until INTEGER);
CREATE TABLE user_otp_used (user_id INTEGER NOT NULL, step INTEGER NOT NULL, PRIMARY KEY (user_id, step));
