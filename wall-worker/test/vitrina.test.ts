import { describe, expect, it } from 'vitest';
import { get, keeperCookie } from './helpers';

// Витрина: движок хранителя — статический /vitrina.js, CSP script-src 'self', редактор — только у хранителя.

const HTML = { Accept: 'text/html' };

describe('Витрина', () => {
  it('подключает /vitrina.js и разрешает скрипты только со своего адреса', async () => {
    const res = await get('/', HTML);
    expect(res.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(res.headers.get('Content-Security-Policy')).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    const page = await res.text();
    expect(page).toContain('<script src="/vitrina.js" defer></script>');
    expect(page).not.toMatch(/<script>(?!<)/); // встроенных скриптов нет
  });

  it('без cookie хранителя редактора нет, ответ кэшируется', async () => {
    const res = await get('/', HTML);
    expect(await res.text()).not.toContain('data-keeper');
    expect(res.headers.get('Cache-Control')).toContain('public');
    expect(res.headers.get('Vary')).toContain('Cookie');
    const forged = await get('/', { ...HTML, Cookie: '__Host-keeper=abc.def' });
    expect(await forged.text()).not.toContain('data-keeper');
  });

  it('с cookie хранителя — <html data-keeper="1">, no-store', async () => {
    const res = await get('/', { ...HTML, Cookie: await keeperCookie() });
    expect(await res.text()).toContain('<html lang="ru" data-keeper="1">');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
});
