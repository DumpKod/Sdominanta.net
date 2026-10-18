import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: [{ name: 'schema.sql', queries }],
          TOKEN_KEY: randomBytes(32).toString('base64url'),
          KEEPERS: JSON.stringify({ '🜄': totpSecret }),
        },
      },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
