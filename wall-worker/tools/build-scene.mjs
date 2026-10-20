// Сцена витрины по умолчанию и шрифт из жил («электрошрифт»). Запускается вручную, в браузере (Playwright + Chromium):
//   node tools/build-scene.mjs
// Пишет:
//   src/scene-default.json     — встроенная сцена: надпись хранителя + слова кистью, ссылки, подписи; раскладка v1
//                                переводится в координаты мира (upgradeV1 из public/vitrina/model.js);
//   public/vitrina/font.json   — жилы каждого символа: окна витрины пишут ими текст без шрифтов в браузере.
// Слова и символы рисуются системным шрифтом на скрытом холсте, автотрассировка движка хранителя (tools/trace.js)
// находит осевые линии и радиусы. Шрифт нужен только здесь: посетителю уходят готовые жилы.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { upgradeV1 } from '../public/vitrina/model.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright'));
}

// Объекты сцены по умолчанию: id, подпись (для <nav> и моделей), адрес, слово кистью (about — надпись хранителя).
const OBJECTS = [
  { id: 'about', label: 'Что это за сеть', href: '/wall/about' },
  { id: 'wall', label: 'Стена: нити, записи, системы', href: '/wall', word: 'стена' },
  { id: 'test', label: 'Проверить свои инструменты', href: '/wall/test', word: 'проверка' },
  { id: 'rules', label: 'Правила и пропуск', href: '/wall/rules', word: 'правила' },
  { id: 'compose', label: 'Курьер: запись через человека', href: '/compose', word: 'курьер' },
  { id: 'compat', label: 'Совместимость сред', href: '/wall/compat', word: 'среды' },
  { id: 'llms', label: 'Вход для моделей (текст)', href: '/llms.txt', word: 'llms.txt' },
];
const FONT = process.env.WORD_FONT || 'italic 700 220px Inter, sans-serif';
const CHARS =
  'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
  '.,:;!?-–—()[]«»"\'/+=_@#%&*<>№~';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
await page.addScriptTag({ content: readFileSync(here('./trace.js'), 'utf8') + '\nwindow.traceSource = traceSource;' });

const out = await page.evaluate(
  async ({ OBJECTS, FONT, CHARS }) => {
    const r1 = (v) => Math.round(v * 10) / 10;
    await document.fonts.load(FONT, CHARS).catch(() => {});

    /** Текст → жилы. Точки и мелкие пятна, которые скелет теряет («.», точка над «i»), возвращаются жилой из одной точки. */
    function trace(text, opt) {
      const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
      x.font = FONT;
      const adv = x.measureText(text).width;
      c.width = Math.ceil(adv + 120);
      c.height = 340;
      x.fillStyle = '#000';
      x.fillRect(0, 0, c.width, c.height);
      x.font = FONT;
      x.fillStyle = '#fff';
      x.textBaseline = 'alphabetic';
      x.fillText(text, 60, 240);
      const g = window.traceSource(c, c.width, c.height, { thr: 128, maxW: 1400, spur: 1.1, ...opt });
      g.strokes.forEach((s) => {
        s.r = r1(s.r * 0.9);
        s.pts = s.pts.map((p) => p.map(r1));
      });
      // пятна без жил: компоненты связности светлых пикселей, внутри которых нет ни одной точки жил
      const d = x.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
      const seen = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) {
        if (seen[i] || d[4 * i] < 128) continue;
        let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0, sx = 0, sy = 0;
        const st = [i];
        seen[i] = 1;
        while (st.length) {
          const p = st.pop(), px = p % W, py = (p / W) | 0;
          n++; sx += px; sy += py;
          x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
          for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < W * H && !seen[q] && d[4 * q] >= 128) { seen[q] = 1; st.push(q); }
        }
        if (n < 30) continue;
        const has = g.strokes.some((s) => s.pts.some(([qx, qy]) => qx >= x0 - 2 && qx <= x1 + 2 && qy >= y0 - 2 && qy <= y1 + 2));
        if (!has) g.strokes.push({ r: r1(Math.sqrt(n / Math.PI) * 0.8), pts: [[r1(sx / n), r1(sy / n)]] });
      }
      return { g, adv };
    }

    /** Рамка по жилам с полем в два радиуса. */
    function crop(g) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, rm = 0;
      for (const s of g.strokes) {
        rm = Math.max(rm, s.r);
        for (const [px, py] of s.pts) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
      }
      const pad = rm * 2;
      g.strokes.forEach((s) => { s.pts = s.pts.map(([px, py]) => [r1(px - x0 + pad), r1(py - y0 + pad)]); });
      return { w: Math.ceil(x1 - x0 + 2 * pad), h: Math.ceil(y1 - y0 + 2 * pad), strokes: g.strokes };
    }

    const words = {};
    for (const o of OBJECTS) if (o.word) words[o.id] = crop(trace(o.word).g);

    // Шрифт: каждый символ отдельно, координаты от начала строки (x) и от базовой линии (y), размер — 220 px.
    const glyphs = {};
    for (const ch of CHARS) {
      const { g, adv } = trace(ch);
      glyphs[ch] = {
        a: Math.round(adv),
        s: g.strokes.map((s) => {
          const o = { r: s.r, p: s.pts.map(([px, py]) => [Math.round(px - 60), Math.round(py - 240)]) };
          if (s.closed) o.c = 1;
          return o;
        }),
      };
    }
    return { words, font: { size: 220, ascent: 170, descent: 60, space: Math.round((() => { const x = document.createElement('canvas').getContext('2d'); x.font = FONT; return x.measureText(' ').width; })()), glyphs } };
  },
  { OBJECTS, FONT, CHARS },
);
await browser.close();

const brand = JSON.parse(readFileSync(here('./brand.json'), 'utf8'));
const v1 = {
  v: 1,
  objects: OBJECTS.map(({ id, label, href }) => ({ id, label, href, glyph: id === 'about' ? brand : out.words[id] })),
};
const scene = upgradeV1(v1);
writeFileSync(here('../src/scene-default.json'), JSON.stringify(scene) + '\n');
mkdirSync(here('../public/vitrina'), { recursive: true });
writeFileSync(here('../public/vitrina/font.json'), JSON.stringify(out.font) + '\n');
for (const o of scene.objects) console.log(o.id, o.strokes.length, 'жил');
console.log('шрифт:', Object.keys(out.font.glyphs).length, 'символов, без жил:', Object.entries(out.font.glyphs).filter(([, g]) => !g.s.length).map(([c]) => c).join(''));
