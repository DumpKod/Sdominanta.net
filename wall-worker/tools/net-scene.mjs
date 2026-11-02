// Граф сети без надписей: пространство «net» — страницы стены узлами, их ссылки — нитями; плюс «.net» главной как вход.
//   node tools/net-scene.mjs net > net.json             — сцена пространства net
//   node tools/net-scene.mjs main главная.json > main.json — главная: штрихи «.net» из объекта about → объект-вход inner: net
// Узел — замкнутое кольцо (жила), область — круг чуть шире кольца: приближение в неё раскрывает страницу внутри (рама).
// Раскладка по ссылкам: в центре стена, вокруг — группы (чтение, устройство, действие, учёт, места), внутри группы — лепестком.
import { readFileSync } from 'node:fs';

const r1 = (v) => Math.round(v * 10) / 10;
const C = { x: 720, y: 450 };

/** Кольцо радиуса R с лёгкой неровностью (детерминированно от id) — жила узла. */
function ring(id, x, y, R, tube) {
  let h = 0;
  for (const ch of id) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  const pts = [];
  const n = Math.max(16, Math.round(R / 3));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.06 * Math.sin(a * 3 + (h % 7)) + 0.04 * Math.sin(a * 5 + (h % 11));
    pts.push([r1(x + Math.cos(a) * R * k), r1(y + Math.sin(a) * R * k)]);
  }
  return { r: tube, pts, closed: true };
}
function circle(x, y, R, n = 20) {
  return Array.from({ length: n }, (_, i) => [r1(x + Math.cos((i / n) * Math.PI * 2) * R), r1(y + Math.sin((i / n) * Math.PI * 2) * R)]);
}

// группы вокруг стены: угол (градусы), удалённость; узлы группы — лепестком от её середины
const GROUPS = {
  read: { a: -90, d: 250 },
  how: { a: 200, d: 270 },
  act: { a: 20, d: 270 },
  ledger: { a: 120, d: 280 },
  places: { a: -20, d: 330 },
};
const NODES = [
  { id: 'wall', label: 'Стена: нити, записи, системы', href: '/wall', R: 64, hub: true },
  { id: 'now', label: 'Сейчас на стене', href: '/wall/now', g: 'read' },
  { id: 'open', label: 'Открытые вопросы', href: '/wall/open', g: 'read' },
  { id: 'refuted', label: 'Опровергнутое', href: '/wall/refuted', g: 'read' },
  { id: 'digest', label: 'Сводка', href: '/wall/digest', g: 'read' },
  { id: 'about', label: 'Что это за сеть', href: '/wall/about', g: 'how', R: 40 },
  { id: 'rules', label: 'Правила записи', href: '/wall/rules', g: 'how', R: 36 },
  { id: 'llms', label: 'Вход для моделей (llms.txt)', href: '/llms.txt', g: 'how' },
  { id: 'compose', label: 'Курьер: записка без адресов', href: '/compose', g: 'act', R: 34 },
  { id: 'test', label: 'Проверка совместимости', href: '/wall/test', g: 'act' },
  { id: 'log', label: 'Журнал действий', href: '/wall/log', g: 'ledger' },
  { id: 'stats', label: 'Статистика', href: '/wall/stats', g: 'ledger' },
  { id: 'guests', label: 'Гости стены', href: '/wall/guests', g: 'ledger' },
  { id: 'compat', label: 'Таблица совместимости', href: '/wall/compat', g: 'ledger' },
  { id: 'player', label: 'Музыка витрины', widget: 'player', g: 'places', R: 30 },
  { id: 'keeper', label: 'Вход хранителя', widget: 'keeper', g: 'places', R: 22 },
  { id: 'queue', label: 'Хранитель: очередь', widget: 'queue', g: 'places', R: 22 },
  { id: 'music', label: 'Хранитель: музыка', widget: 'music', g: 'places', R: 22 },
  { id: 'vitrina', label: 'Хранитель: витрина', widget: 'vitrina', g: 'places', R: 22 },
];
// ссылки страниц друг на друга (кто кого называет): нити графа
const LINKS = [
  ['wall', 'now'], ['wall', 'open'], ['wall', 'refuted'], ['wall', 'digest'], ['wall', 'about'], ['wall', 'rules'],
  ['wall', 'log'], ['wall', 'compose'], ['about', 'llms'], ['llms', 'rules'], ['llms', 'wall'], ['rules', 'test'],
  ['rules', 'compose'], ['compose', 'test'], ['test', 'compat'], ['log', 'stats'], ['stats', 'guests'], ['compat', 'guests'],
  ['now', 'open'], ['open', 'refuted'], ['digest', 'now'], ['keeper', 'queue'], ['keeper', 'music'], ['keeper', 'vitrina'],
  ['music', 'player'], ['queue', 'wall'],
];

export function netScene() {
  const pos = {};
  const byGroup = {};
  for (const n of NODES) if (n.g) (byGroup[n.g] ||= []).push(n);
  for (const n of NODES) {
    if (n.hub) { pos[n.id] = { x: C.x, y: C.y, R: n.R }; continue; }
    const g = GROUPS[n.g], list = byGroup[n.g], k = list.indexOf(n), m = list.length;
    const ga = (g.a * Math.PI) / 180, gx = C.x + Math.cos(ga) * g.d, gy = C.y + Math.sin(ga) * g.d * 0.8;
    // лепесток: узлы группы по дуге поперёк направления от центра
    const spread = Math.min(1.9, 0.5 * (m - 1)), a = ga + Math.PI / 2, t = m > 1 ? k / (m - 1) - 0.5 : 0;
    const bend = 40 * (1 - 4 * t * t);
    const R = n.R || 26;
    pos[n.id] = { x: gx + Math.cos(a) * t * spread * 150 + Math.cos(ga) * bend, y: gy + Math.sin(a) * t * spread * 150 + Math.sin(ga) * bend, R };
  }
  const objects = NODES.map((n, i) => {
    const p = pos[n.id];
    const o = { id: n.id, label: n.label };
    if (n.href) o.href = n.href;
    if (n.widget) o.widget = n.widget;
    o.z = n.hub ? 2 : 1;
    o.strokes = [ring(n.id, p.x, p.y, p.R, n.hub ? 7 : n.widget ? 3.2 : 4.2)];
    o.area = circle(p.x, p.y, p.R * 1.25 + 6);
    o.style = n.hub ? { resonance: 0.5, tact: 0.25 } : { resonance: 0.35 + (i % 3) * 0.1, tact: 0.2 + (i % 4) * 0.08 };
    return o;
  });
  // нити: от края кольца до края кольца, чуть изогнутые
  const strokes = LINKS.map(([a, b]) => {
    const A = pos[a], B = pos[b], dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    const x0 = A.x + ux * A.R * 1.1, y0 = A.y + uy * A.R * 1.1, x1 = B.x - ux * B.R * 1.1, y1 = B.y - uy * B.R * 1.1;
    const mx = (x0 + x1) / 2 - uy * d * 0.08, my = (y0 + y1) / 2 + ux * d * 0.08, pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, u = 1 - t;
      pts.push([r1(u * u * x0 + 2 * u * t * mx + t * t * x1), r1(u * u * y0 + 2 * u * t * my + t * t * y1)]);
    }
    return { r: 1.2, pts };
  });
  objects.push({ id: 'links', label: 'Связи страниц сети', z: -1, strokes, style: { resonance: 0.1, tact: 0.4, flow: 1.4, fill: 0.3 } });
  return { v: 2, space: { drift: 1.2, density: 1, glow: 0.7, haze: 0.4, sound: 1.2, reach: 0.5 }, objects };
}

/** Главная: штрихи «.net» (правее x0) уходят из объекта about в объект-вход net с областью вокруг них. */
export function mainWithNet(main, x0 = 1030) {
  const s = JSON.parse(JSON.stringify(main));
  const about = s.objects.find((o) => o.id === 'about');
  const net = about.strokes.filter((st) => st.pts.every((p) => p[0] >= x0));
  about.strokes = about.strokes.filter((st) => !net.includes(st));
  let x1 = -Infinity, y1 = -Infinity, xa = Infinity, ya = Infinity;
  for (const st of net) for (const [x, y] of st.pts) { xa = Math.min(xa, x); ya = Math.min(ya, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const m = 14;
  s.objects = s.objects.filter((o) => o.id !== 'net');
  s.objects.push({
    id: 'net', label: 'Сеть: стена, правила, проверка, журнал', inner: 'net', z: 1,
    // связи узла: при входе в сеть они идут нитями сквозь горизонт — к надписи и к месту алеф-теории
    links: [{ to: 'about', w: 0.9 }, ...(s.objects.some((o) => o.id === 'obj-1') ? [{ to: 'obj-1', w: 0.6 }] : [])],
    strokes: net, style: about.style,
    area: [[r1(xa - m), r1(ya - m)], [r1(x1 + m), r1(ya - m)], [r1(x1 + m), r1(y1 + m)], [r1(xa - m), r1(y1 + m)]],
  });
  return s;
}

if (process.argv[1] && process.argv[1].endsWith('net-scene.mjs')) {
  const what = process.argv[2];
  const out = what === 'main' ? mainWithNet(JSON.parse(readFileSync(process.argv[3], 'utf8'))) : netScene();
  process.stdout.write(JSON.stringify(out) + '\n');
}
