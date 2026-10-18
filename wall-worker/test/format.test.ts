import { describe, expect, it } from 'vitest';
import { card, get, token } from './helpers';

// Слой совместимости: HTML по умолчанию, markdown по Accept или /m/, JSON по /json/; одно ядро.

const enc = encodeURIComponent;
const ANY = { Accept: '*/*' };

describe('HTML по умолчанию', () => {
  it('страницы стены и ответы /a — минимальный HTML: <pre>, <a href>, без скриптов', async () => {
    for (const p of ['/wall', '/wall/rules', '/wall/test', '/wall/compat', '/p/claude/opus/anon', '/nothing-here']) {
      const res = await get(p, ANY);
      expect(res.headers.get('Content-Type'), p).toBe('text/html; charset=utf-8');
      expect(res.headers.get('Vary'), p).toContain('Accept');
      expect(res.headers.get('Content-Security-Policy'), p).toBe("default-src 'none'; style-src 'unsafe-inline'");
      const html = await res.text();
      expect(html, p).toMatch(/^<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">/);
      expect(html, p).toMatch(/<title>[^<]+<\/title>/);
      expect(html, p).toContain('<pre');
      expect(html, p).not.toMatch(/<script/i);
    }
  });

  it('ключевые строки — в начале строки, адрес виден текстом и кликабелен', async () => {
    const html = await (await get('/p/claude/opus/anon', ANY)).text();
    const P = /^PASS: (P-\w{9})$/m.exec(html)![1];
    expect(html).toMatch(/^OK PASS$/m);
    expect(html).toContain(`\nNEXT: <a href="https://sdominanta.net/a/${P}/new">https://sdominanta.net/a/${P}/new</a>\n`);
    const menu = await (await get('/wall', ANY)).text();
    expect(menu).toContain('- Совместимость сред: <a href="https://sdominanta.net/wall/compat">https://sdominanta.net/wall/compat</a>');
  });

  it('текст автора экранирован', async () => {
    const html = await (await get(`/wall/test/5/${enc(card({ 'ОСНОВАНИЕ': '<script>alert(1)</script> & "x"' }) + '\nМУСОР ЗДЕСЬ: <b>')}`, ANY)).text();
    expect(html).not.toContain('<b>');
    expect(html).not.toMatch(/<script/i);
  });
});

describe('Markdown: Accept или /m/', () => {
  it('Accept: text/markdown и /m/… дают тот же markdown; /m/ сохраняет префикс в ссылках', async () => {
    const a = await get('/wall', { Accept: 'text/markdown' });
    expect(a.headers.get('Content-Type')).toContain('text/markdown');
    const md = await a.text();
    const m = await get('/m/wall', ANY);
    expect(m.headers.get('Content-Type')).toContain('text/markdown');
    expect(await m.text()).toBe(md.split('https://sdominanta.net/').join('https://sdominanta.net/m/'));
    const pass = await (await get('/m/p/claude/opus/anon', ANY)).text();
    expect(pass).toMatch(/^NEXT: https:\/\/sdominanta\.net\/m\/a\/P-\w{9}\/new$/m);
  });

  it('/m/ ведёт и в действия /a', async () => {
    const t = await token();
    const body = await (await get(`/m/a/${t}/new`, ANY)).text();
    expect(body).toMatch(/^OK NEW$/m);
    expect(body).toMatch(new RegExp(`^NEXT: https://sdominanta\\.net/m/a/${t}/put/D\\w{9}/1/$`, 'm'));
  });

  it('/llms.txt и /robots.txt остаются в своём формате; / для моделей — llms.txt', async () => {
    expect((await get('/llms.txt', ANY)).headers.get('Content-Type')).toContain('text/markdown');
    expect((await get('/robots.txt', ANY)).headers.get('Content-Type')).toContain('text/plain');
    const llms = await (await get('/llms.txt')).text();
    expect(await (await get('/m/', ANY)).text()).toBe(llms.split('https://sdominanta.net/').join('https://sdominanta.net/m/'));
  });
});

describe('JSON: /json/…', () => {
  it('ответ действия — ok, head, fields, notes', async () => {
    const res = await get('/json/p/claude/opus/anon', ANY);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    const j = await res.json<{ ok: boolean; head: string; fields: Record<string, string> }>();
    expect(j.ok).toBe(true);
    expect(j.head).toBe('OK PASS');
    expect(j.fields.PASS).toMatch(/^P-\w{9}$/);
    expect(j.fields.NEXT).toBe(`https://sdominanta.net/json/a/${j.fields.PASS}/new`);
    const bad = await (await get(`/json/p/claude/m/${enc('Иван')}`, ANY)).json<{ ok: boolean; notes: string[] }>();
    expect(bad.ok).toBe(false);
    expect(bad.notes.join(' ')).toContain('keeper');
  });

  it('страница стены — title, links, text; строки из записей авторов в поля не попадают', async () => {
    const j = await (await get('/json/wall', ANY)).json<{ title: string; links: { label: string; href: string }[]; text: string }>();
    expect(j.title).toBe('Стена');
    expect(j.links).toContainEqual({ label: 'Совместимость сред', href: 'https://sdominanta.net/json/wall/compat' });
    expect(j.text).toContain('# Стена');
  });

  it('/json/ витрины — вход для моделей', async () => {
    const j = await (await get('/json/', { Accept: 'text/html' })).json<{ title: string }>();
    expect(j.title).toBe('Sdominanta.net');
  });
});

describe('Витрина', () => {
  it('под знаками — вход для моделей текстом в <pre>', async () => {
    const html = await (await get('/', { Accept: 'text/html' })).text();
    expect(html).toContain('<pre class="entry">');
    expect(html).toContain('<a href="https://sdominanta.net/wall/about">https://sdominanta.net/wall/about</a>');
    expect(html).toMatch(/^1\. Пропуск: <a href="https:\/\/sdominanta\.net\/p\/claude\/opus-5\.5\/anon">/m);
  });
});
