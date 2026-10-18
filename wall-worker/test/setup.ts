import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import schema from '../schema.sql?raw';

// Журнал только дописывается (триггеры); между тестами триггеры снимаются, таблица чистится и триггеры ставятся снова.
const TRIGGERS = schema.match(/^CREATE TRIGGER .*$/gm)!;

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = ['records', 'links', 'status_log', 'drafts', 'passes', 'pieces', 'piece_parts', 'test_marks', 'compat', 'otp_used', 'keeper_lock', 'rate', 'meta', 'accounts', 'sessions', 'scenes', 'indexnow_queue', 'anchors'];
beforeEach(async () => {
  await env.DB.batch([
    ...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare('DROP TRIGGER IF EXISTS events_no_update'),
    env.DB.prepare('DROP TRIGGER IF EXISTS events_no_delete'),
    env.DB.prepare('DELETE FROM events'),
    env.DB.prepare(`DELETE FROM sqlite_sequence WHERE name = 'events'`),
    ...TRIGGERS.map((t) => env.DB.prepare(t)),
  ]);
  // Кэш страниц переживает очистку базы: своя версия у каждого теста, чтобы не читать чужие страницы.
  await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('ver', ?)`).bind(String(1e6 + Math.floor(Math.random() * 1e9))).run();
});
