declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TOKEN_KEY: string;
    KEEPERS: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
