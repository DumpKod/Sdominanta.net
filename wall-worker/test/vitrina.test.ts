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

// Файлы витрины из public/ — строками через vite (?raw), чтобы проверить их без сети.
import vitrinaJs from '../public/vitrina.js?raw';
import vitrinaCss from '../public/vitrina.css?raw';
import { SCENE } from '../src/scene';

/** Все абсолютные адреса и протокольно-относительные ссылки в тексте. */
const external = (text: string) =>
  [...text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)].map((m) => m[0]).filter((u) => !u.startsWith('https://sdominanta.net'));

describe('Витрина из объектов кистью', () => {
  it('сцена — холст; объекты — настоящие ссылки в <nav> с подписями, в порядке сцены', async () => {
    const page = await (await get('/', HTML)).text();
    expect(page).toContain('<canvas id="scene" aria-hidden="true"></canvas>');
    const nav = /<nav class="objects"[^>]*>([\s\S]*?)<\/nav>/.exec(page)![1];
    const links = [...nav.matchAll(/<a data-id="([^"]+)" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2], m[3]]);
    expect(links).toEqual(SCENE.map((x) => [x.id, 'https://sdominanta.net' + x.href, x.label]));
    expect(page).toContain('<pre class="entry">'); // текстовый вход для моделей остаётся
  });

  it('страница, скрипт и стили не обращаются ни к одному внешнему домену; шрифтов нет', async () => {
    const res = await get('/', HTML);
    const page = await res.text();
    const csp = res.headers.get('Content-Security-Policy')!;
    expect(csp).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'");
    // Ссылки страницы и текстового входа ведут только на свой домен.
    expect(external(page)).toEqual([]);
    expect(page).not.toMatch(/<style|style="|@import|<link[^>]+href="(?!\/)/i);
    for (const [name, text] of [['vitrina.js', vitrinaJs], ['vitrina.css', vitrinaCss]] as const) {
      expect(external(text), name).toEqual([]);
      expect(text, name).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@font-face|@import|url\(/i);
      expect(text, name).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\(/);
    }
  });

  it('движок: пауза при скрытой вкладке, статичный кадр при reduced-motion, редактор только у хранителя, без shadowBlur', () => {
    expect(vitrinaJs).toContain("addEventListener('visibilitychange'");
    expect(vitrinaJs).toContain('document.hidden');
    expect(vitrinaJs).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(vitrinaJs).toContain("root.dataset.keeper === '1'");
    // правка (pointerdown) живёт только внутри initEditor, а он вызывается только у хранителя
    expect(vitrinaJs).toContain('if (keeper) initEditor();');
    expect(vitrinaJs.match(/addEventListener\('pointerdown'/g)).toHaveLength(1);
    expect(vitrinaJs.indexOf("addEventListener('pointerdown'")).toBeGreaterThan(vitrinaJs.indexOf('function initEditor()'));
    expect(vitrinaJs).not.toMatch(/shadowBlur\s*=/);
  });
});

describe('Жилы объектов', () => {
  it('у каждого объекта сцены есть жилы: надпись хранителя для about, слова кистью для остальных', () => {
    const brand = JSON.parse(/\/\*BRAND\*\/(.*?)\/\*END\*\//s.exec(vitrinaJs)![1]);
    const words = JSON.parse(/\/\*WORDS\*\/(.*?)\/\*END\*\//s.exec(vitrinaJs)![1]);
    expect(brand.strokes.length).toBeGreaterThan(10);
    for (const o of SCENE.filter((x) => x.id !== 'about')) {
      const g = words[o.id];
      expect(g, o.id).toBeTruthy();
      expect(g.w > 0 && g.h > 0 && g.strokes.length > 0, o.id).toBe(true);
      for (const st of g.strokes) expect(st.r > 0 && st.pts.length > 0, o.id).toBe(true);
    }
  });
});
