// Подписи объектов витрины → жилы кисти. Запускается вручную, в браузере (Playwright + Chromium):
//   node tools/trace-words.mjs
// Слово рисуется системным шрифтом на скрытом холсте, автотрассировка движка хранителя (tools/trace.js)
// находит осевые линии и радиусы, результат вписывается в public/vitrina.js между /*WORDS*/ и /*END*/.
// Шрифт нужен только здесь, при генерации: витрина шрифтов не грузит, она рисует уже готовые жилы.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright'));
}

// Слова кистью по id объекта (src/scene.ts). about — эталонная надпись хранителя, её не трассируем.
const WORDS = {
  wall: 'стена',
  test: 'проверка',
  rules: 'правила',
  compose: 'курьер',
  compat: 'среды',
  llms: 'llms.txt',
};
const FONT = process.env.WORD_FONT || 'italic 700 220px Inter, sans-serif';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage();
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
await page.addScriptTag({ content: readFileSync(here('./trace.js'), 'utf8') + '\nwindow.traceSource = traceSource;' });
const out = await page.evaluate(
  async ({ WORDS, FONT }) => {
    const res = {};
    for (const [id, text] of Object.entries(WORDS)) {
      try {
        await document.fonts.load(FONT, text);
      } catch {}
      const c = document.createElement('canvas'), x = c.getContext('2d');
      x.font = FONT;
      c.width = Math.ceil(x.measureText(text).width + 120);
      c.height = 340;
      x.fillStyle = '#000';
      x.fillRect(0, 0, c.width, c.height);
      x.font = FONT;
      x.fillStyle = '#fff';
      x.textBaseline = 'middle';
      x.fillText(text, 60, c.height / 2);
      const g = window.traceSource(c, c.width, c.height, { thr: 128, maxW: 1400, spur: 1.1 } /* короткие ветки шрифта (хвост «а», перекладина «т») не усы */);
      const r1 = (v) => Math.round(v * 10) / 10;
      g.strokes.forEach((s) => {
        s.r = r1(s.r * 0.9);
        s.pts = s.pts.map((p) => p.map(r1));
      });
      // рамка по самим жилам с полем в два радиуса: пустые края холста не занимают места на сцене
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, rm = 0;
      for (const s of g.strokes) {
        rm = Math.max(rm, s.r);
        for (const [px, py] of s.pts) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
      }
      const pad = rm * 2;
      g.strokes.forEach((s) => { s.pts = s.pts.map(([px, py]) => [r1(px - x0 + pad), r1(py - y0 + pad)]); });
      g.w = Math.ceil(x1 - x0 + 2 * pad);
      g.h = Math.ceil(y1 - y0 + 2 * pad);
      res[id] = g;
    }
    return res;
  },
  { WORDS, FONT },
);
await browser.close();

const file = here('../public/vitrina.js');
const src = readFileSync(file, 'utf8');
const block = /\/\*WORDS\*\/[\s\S]*?\/\*END\*\//;
if (!block.test(src)) throw new Error('в public/vitrina.js нет блока /*WORDS*/…/*END*/');
writeFileSync(file, src.replace(block, () => '/*WORDS*/' + JSON.stringify(out) + '/*END*/'));
for (const [id, g] of Object.entries(out)) console.log(id, WORDS[id], `${g.w}×${g.h}`, g.strokes.length, 'жил');
