declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TOKEN_KEY: string;
    KEEPERS: string;
    TEST_KEEPER_KEY: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}

// Файлы витрины из public/ читаются в тестах строками через vite (?raw).
declare module '*?raw' {
  const text: string;
  export default text;
}
