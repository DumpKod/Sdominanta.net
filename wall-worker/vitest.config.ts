import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Схема из schema.sql — одна миграция для тестовой базы.
const queries = readFileSync('./schema.sql', 'utf8')
  .replace(/--.*$/gm, '')
  .split(';')
  .map((q) => q.trim())
  .filter(Boolean);

// Фиктивные секреты, создаются заново при каждом запуске тестов и нигде не сохраняются.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const totpSecret = Array.from(randomBytes(20), (b) => B32[b % 32]).join('');
const keeperKey = randomBytes(24).toString('base64url');
const keySha256 = createHash('sha256').update(keeperKey, 'utf8').digest('hex');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: [{ name: 'schema.sql', queries }],
          TOKEN_KEY: randomBytes(32).toString('base64url'),
          // Знак — JSON-escape, как может прийти из панели Cloudflare.
          KEEPERS: JSON.stringify({ '🜄': { totp: totpSecret, key_sha256: keySha256 } }).replace('🜄', '\\ud83d\\udf04'),
          TEST_KEEPER_KEY: keeperKey,
          // Пинг IndexNow в тестах не отправляется; тесты пинга передают свой адрес и подменяют fetch.
          INDEXNOW_URL: 'off',
        },
      },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
