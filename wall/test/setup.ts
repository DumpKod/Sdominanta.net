import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = ['records', 'links', 'status_log', 'drafts', 'token_uses', 'otp_used', 'keeper_lock', 'rate', 'meta'];
beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  // Кэш страниц переживает очистку базы: своя версия у каждого теста, чтобы не читать чужие страницы.
  await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('ver', ?)`).bind(String(1e6 + Math.floor(Math.random() * 1e9))).run();
});
