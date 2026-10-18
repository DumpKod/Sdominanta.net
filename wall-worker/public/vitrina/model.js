// Модель витрины: бесконечный мир, камера, сцена из объектов, история правок. Без DOM: этот же файл
// подключают движок (/vitrina.js), редактор хранителя, инструменты (tools/) и тесты.
//
// Мир — абсолютные координаты (пиксели мира). Экран — камера { x, y, zoom }: точка мира (x, y) в центре экрана,
// zoom — сколько пикселей экрана на пиксель мира. Сцена v2:
// { v: 2, space?: { drift, density, glow }, objects: [ {
//     id, label, href?, z?,                    z — слой: выше рисуется поверх и первым ловит клик
//     strokes: [ { r, pts: [[x, y(, r)]…], closed? } ],   жилы в координатах мира
//     area?: [[x, y]…],                        область попадания в координатах мира
//     window?: { title?, text?, links?: [ { label, href } ] },
//     links?: [ { to, w } ]                    связи узла (до 10, вес 0…1): при входе — нити сквозь горизонт
//     widget?: "player" | "keeper" | "queue" | "music" | "vitrina"   живое управление в окне объекта
//     frame?: { width, aspect, round, ring, far }   рама окна: размер, форма, рамка из узлов области, фон
//     style?: { tubeR, thick, resonance, tact, flow, wobble, fill, sound }   свои параметры объекта, как в движке хранителя
// } ] }

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
/** Экран, на котором сцена v1 (доли экрана) переводится в мир: при камере { центр, zoom 1 } вид тот же. */
export const REF_W = 1440;
export const REF_H = 900;

/** Параметры объекта: [мин, макс, по умолчанию]. tubeR — радиус трубки новых мазков (пиксели мира). */
export const STYLE = {
  tubeR: [0.5, 200, 8],
  thick: [0.4, 2.5, 1.15],
  resonance: [0, 1, 0.45],
  tact: [0, 3, 0.3],
  flow: [0, 2, 1],
  wobble: [0, 1, 0.25],
  fill: [0, 1, 0.6],
  sound: [0, 2, 1], // реакция жил объекта на музыку: 0 — нет, 1 — обычная
};
/** Параметры пространства всей сцены. */
export const SPACE = {
  drift: [0, 2, 1.4],
  density: [0.5, 1.6, 0.85],
  glow: [0, 1.5, 0.8],
  haze: [0, 1.5, 0.45], // дымка: мягкий слой в четверть разрешения под чёткими линиями
  sound: [0, 2, 1], // реакция поля всей сцены на музыку (дрейф, свечение, удары)
  horizon: [0, 1, 0.6], // горизонт: кадр уровня выше кольцом по краю экрана; 0 — чистый холст
  reach: [0.05, 2, 0.45], // радиус музыки вокруг плеера: доля размера сцены; моды дальше её не слышат
};
const defaults = (spec) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v[2]]));
/**
 * Рама окна объекта: [мин, макс, по умолчанию]. Мода фиксируется окном в конце приближения (предел масштаба) над областью.
 * width — ширина окна в пикселях CSS;
 * aspect — высота к ширине (0 — по высоте экрана); round — форма (0 прямоугольник, 1 овал);
 * ring — толщина рамки из узлов области в пикселях CSS; far — сколько узлов фона гаснет, пока окно раскрыто.
 */
/** Виджеты окна: плеер и вход хранителя — живые элементы страницы, остальные — разделы панели (только хранителю). */
export const WIDGETS = ['player', 'keeper', 'queue', 'music', 'vitrina'];
export const KEEPER_WIDGETS = { queue: '/k', music: '/k/music', vitrina: '/k/vitrina' };
export const FRAME = {
  width: [240, 1400, 760],
  aspect: [0, 2, 0],
  round: [0, 1, 0.25],
  ring: [4, 160, 36],
  far: [0, 1, 0.75],
};
export const FRAME_DEFAULTS = defaults(FRAME);
export const STYLE_DEFAULTS = defaults(STYLE);
export const SPACE_DEFAULTS = defaults(SPACE);

const clone = (o) => JSON.parse(JSON.stringify(o));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/* ---------------- прямоугольники мира { x0, y0, x1, y1 } ---------------- */

export const EMPTY = Object.freeze({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
export const isEmpty = (a) => !(a.x1 >= a.x0 && a.y1 >= a.y0);
export const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
export const intersects = (a, b) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
export const contains = (outer, inner) => inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
export const expand = (a, dx, dy = dx) => ({ x0: a.x0 - dx, y0: a.y0 - dy, x1: a.x1 + dx, y1: a.y1 + dy });
export const rectFrom = (x0, y0, x1, y1) => ({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });

/** Точка внутри многоугольника (чётность пересечений). */
export function inPoly(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) c = !c;
  }
  return c;
}

/* ---------------- камера ---------------- */

export class Camera {
  constructor(x = 0, y = 0, zoom = 1) {
    this.x = x;
    this.y = y;
    this.zoom = zoom;
  }
  clone() {
    return new Camera(this.x, this.y, this.zoom);
  }
  toScreen(wx, wy, W, H) {
    return [(wx - this.x) * this.zoom + W / 2, (wy - this.y) * this.zoom + H / 2];
  }
  toWorld(sx, sy, W, H) {
    return [(sx - W / 2) / this.zoom + this.x, (sy - H / 2) / this.zoom + this.y];
  }
  /** Видимая часть мира. */
  view(W, H) {
    const hw = W / 2 / this.zoom, hh = H / 2 / this.zoom;
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh };
  }
  /** Масштаб к точке экрана: точка мира под (sx, sy) остаётся на месте. */
  zoomAt(sx, sy, W, H, factor, min = ZOOM_MIN, max = ZOOM_MAX) {
    const [wx, wy] = this.toWorld(sx, sy, W, H);
    this.zoom = Math.min(max, Math.max(min, this.zoom * factor));
    this.x = wx - (sx - W / 2) / this.zoom;
    this.y = wy - (sy - H / 2) / this.zoom;
    return this;
  }
  /** Сдвиг на (dx, dy) пикселей экрана: мир едет вместе с пальцем. */
  panBy(dx, dy) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    return this;
  }
  /** Показать прямоугольник мира целиком, с полями margin (доля экрана с каждой стороны). */
  fit(rect, W, H, margin = 0.05, min = 0, max = ZOOM_MAX) {
    if (isEmpty(rect)) return this;
    const w = Math.max(1e-6, rect.x1 - rect.x0), h = Math.max(1e-6, rect.y1 - rect.y0);
    this.zoom = Math.min(max, Math.max(min, Math.min((W * (1 - 2 * margin)) / w, (H * (1 - 2 * margin)) / h)));
    this.x = (rect.x0 + rect.x1) / 2;
    this.y = (rect.y0 + rect.y1) / 2;
    return this;
  }
  /**
   * Холст ограничен тем, что на нём есть: отдалиться дальше общего вида рамки нельзя, увести её за край экрана — тоже
   * (поля margin — доля экрана). Рамка меньше экрана по одной из осей — по этой оси она в центре.
   */
  clampTo(rect, W, H, margin = 0.05, max = ZOOM_MAX) {
    if (isEmpty(rect)) return this;
    const fitZ = new Camera().fit(rect, W, H, margin, 0, Infinity).zoom;
    this.zoom = Math.min(Math.max(this.zoom, Math.min(fitZ, max)), Math.max(max, fitZ));
    const hw = W / 2 / this.zoom, hh = H / 2 / this.zoom, mx = (W * margin) / this.zoom, my = (H * margin) / this.zoom;
    const x0 = rect.x0 - mx + hw, x1 = rect.x1 + mx - hw, y0 = rect.y0 - my + hh, y1 = rect.y1 + my - hh;
    this.x = x0 <= x1 ? Math.min(x1, Math.max(x0, this.x)) : (rect.x0 + rect.x1) / 2;
    this.y = y0 <= y1 ? Math.min(y1, Math.max(y0, this.y)) : (rect.y0 + rect.y1) / 2;
    return this;
  }
  toJSON() {
    return { x: this.x, y: this.y, zoom: this.zoom };
  }
}

/* ---------------- объект и сцена ---------------- */

export class SceneObject {
  constructor(src) {
    this.id = src.id;
    this.label = src.label;
    this.href = src.href || null;
    /** Алеф-нуль: имя пространства (сцены) внутри объекта, вход — колёсиком вглубь или нажатием. */
    this.inner = src.inner || null;
    /** Место для живого HTML (плеер, вход хранителя): элемент [data-slot] встаёт в рамку объекта. */
    this.slot = src.slot || null;
    this.z = typeof src.z === 'number' ? src.z : 0;
    this.strokes = clone(src.strokes || []);
    this.area = src.area ? clone(src.area) : null;
    this.window = src.window ? clone(src.window) : null;
    this.frame = src.frame ? clone(src.frame) : null;
    /** Виджет в окне: открывается приближением в область, как окно. */
    this.widget = src.widget || null;
    /** Связи узла с соседями по уровню: { to — id, w — вес 0…1 }; при входе внутрь — нити сквозь горизонт. */
    this.links = src.links ? clone(src.links) : null;
    this.style = src.style ? clone(src.style) : null;
  }
  /** Параметр объекта: свой или по умолчанию. */
  get(k) {
    return this.style && typeof this.style[k] === 'number' ? this.style[k] : STYLE_DEFAULTS[k];
  }
  /** Параметр рамы окна: свой или по умолчанию. */
  frameGet(k) {
    return this.frame && typeof this.frame[k] === 'number' ? this.frame[k] : FRAME_DEFAULTS[k];
  }
  /** Радиус новых мазков: tubeR объекта, иначе средний радиус его жил. */
  tubeR() {
    if (this.style && typeof this.style.tubeR === 'number') return this.style.tubeR;
    const rs = this.strokes.map((s) => s.r).sort((a, b) => a - b);
    return rs.length ? rs[rs.length >> 1] : STYLE_DEFAULTS.tubeR;
  }
  /** Рамка объекта в мире: жилы с их радиусом и область. */
  bounds() {
    let b = { ...EMPTY };
    for (const s of this.strokes)
      for (const p of s.pts) {
        const r = p[2] || s.r;
        b = union(b, { x0: p[0] - r, y0: p[1] - r, x1: p[0] + r, y1: p[1] + r });
      }
    for (const [x, y] of this.area || []) b = union(b, { x0: x, y0: y, x1: x, y1: y });
    return b;
  }
  translate(dx, dy) {
    for (const s of this.strokes) for (const p of s.pts) { p[0] = r1(p[0] + dx); p[1] = r1(p[1] + dy); }
    if (this.area) for (const p of this.area) { p[0] = r1(p[0] + dx); p[1] = r1(p[1] + dy); }
    return this;
  }
  /** Масштаб вокруг точки мира: жилы, их радиусы и область. */
  scale(k, cx, cy) {
    for (const s of this.strokes) {
      s.r = r2(Math.max(0.1, s.r * k));
      for (const p of s.pts) {
        p[0] = r1(cx + (p[0] - cx) * k); p[1] = r1(cy + (p[1] - cy) * k);
        if (p.length > 2) p[2] = r2(Math.max(0.1, p[2] * k));
      }
    }
    if (this.area) for (const p of this.area) { p[0] = r1(cx + (p[0] - cx) * k); p[1] = r1(cy + (p[1] - cy) * k); }
    return this;
  }
  /**
   * Растяжение вокруг точки мира: по x в sx раз, по y в sy раз (минус — отражение). Радиусы жил — в √|sx·sy| раз.
   * Как и scale, правит точки на месте: объект хранит то, что видно.
   */
  stretch(sx, sy, cx, cy) {
    const k = Math.sqrt(Math.abs(sx * sy));
    for (const s of this.strokes) {
      s.r = r2(Math.min(5000, Math.max(0.1, s.r * k)));
      for (const p of s.pts) {
        p[0] = r1(cx + (p[0] - cx) * sx); p[1] = r1(cy + (p[1] - cy) * sy);
        if (p.length > 2) p[2] = r2(Math.min(5000, Math.max(0.1, p[2] * k)));
      }
    }
    if (this.area) for (const p of this.area) { p[0] = r1(cx + (p[0] - cx) * sx); p[1] = r1(cy + (p[1] - cy) * sy); }
    return this;
  }
  /** Поворот вокруг точки мира на a радиан (по часовой на экране: ось y вниз). */
  rotate(a, cx, cy) {
    const c = Math.cos(a), s = Math.sin(a);
    const turn = (p) => { const x = p[0] - cx, y = p[1] - cy; p[0] = r1(cx + x * c - y * s); p[1] = r1(cy + x * s + y * c); };
    for (const st of this.strokes) for (const p of st.pts) turn(p);
    if (this.area) for (const p of this.area) turn(p);
    return this;
  }
  toJSON() {
    const o = { id: this.id, label: this.label };
    if (this.href) o.href = this.href;
    if (this.inner) o.inner = this.inner;
    if (this.slot) o.slot = this.slot;
    if (this.z) o.z = this.z;
    o.strokes = this.strokes;
    if (this.area && this.area.length >= 3) o.area = this.area;
    if (this.window && Object.keys(this.window).length) o.window = this.window;
    if (this.frame && Object.keys(this.frame).length) o.frame = this.frame;
    if (this.widget) o.widget = this.widget;
    if (this.links && this.links.length) o.links = this.links;
    if (this.style && Object.keys(this.style).length) o.style = this.style;
    return o;
  }
}

export class Scene {
  constructor(json) {
    const j = json && json.v === 1 ? upgradeV1(json) : json || { v: 2, objects: [] };
    this.space = j.space ? clone(j.space) : null;
    this.objects = (j.objects || []).map((o) => new SceneObject(o));
  }
  static from(json) {
    return new Scene(typeof json === 'string' ? JSON.parse(json) : json);
  }
  get(k) {
    return this.space && typeof this.space[k] === 'number' ? this.space[k] : SPACE_DEFAULTS[k];
  }
  bounds() {
    return this.objects.reduce((b, o) => union(b, o.bounds()), { ...EMPTY });
  }
  /** Порядок рисования: по слою z, при равных — по порядку в сцене. */
  layers() {
    return this.objects.map((o, i) => i).sort((a, b) => this.objects[a].z - this.objects[b].z || a - b);
  }
  /** Отсечение: индексы объектов, чья рамка задевает прямоугольник мира. */
  visible(rect) {
    return visibleObjects(this.objects.map((o) => o.bounds()), rect);
  }
  newId(prefix = 'obj') {
    let n = 1;
    while (this.objects.some((o) => o.id === `${prefix}-${n}`)) n++;
    return `${prefix}-${n}`;
  }
  toJSON() {
    const j = { v: 2 };
    if (this.space && Object.keys(this.space).length) j.space = this.space;
    j.objects = this.objects.map((o) => o.toJSON());
    return j;
  }
}

/** Отсечение по рамкам: индексы рамок, задевающих прямоугольник. */
export function visibleObjects(bounds, rect) {
  const out = [];
  bounds.forEach((b, i) => { if (!isEmpty(b) && intersects(b, rect)) out.push(i); });
  return out;
}

/* ---------------- перевод сцены v1 (доли экрана) в мир ---------------- */

/** Объект v1 без своих жил: незамкнутое кольцо-энсо 400×400 (так его рисовал движок v1). */
function enso() {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const a = -1.3 + (i / 40) * Math.PI * 1.8;
    pts.push([r1(200 + Math.cos(a) * 150), r1(200 + Math.sin(a) * 150)]);
  }
  return { w: 400, h: 400, strokes: [{ r: 12, pts }] };
}

function glyphV1(o) {
  if (o.glyph) return { g: o.glyph, own: true };
  if (o.area) {
    const g = { w: 1, h: 1, strokes: [] };
    for (const [x, y] of o.area) { g.w = Math.max(g.w, x); g.h = Math.max(g.h, y); }
    return { g, own: false };
  }
  return { g: enso(), own: true };
}

/** Раскладка v1 на экране W×H (как её делал движок v1): первый объект — надпись сверху, остальные — сеткой. */
export function layoutV1(objects, W, H) {
  const gs = objects.map((o) => glyphV1(o).g);
  const fits = gs.map(() => ({ s: 1, ox: 0, oy: 0 }));
  if (!objects.length) return fits;
  const narrow = W < H * 0.9;
  const place = (i, x0, y0, w, h, s0) => {
    const g = gs[i], over = objects[i].place;
    const k = over && over.k > 0 ? over.k : 1;
    const s = (s0 || Math.min(w / g.w, h / g.h)) * k;
    const cx = over ? over.x * W : x0 + w / 2, cy = over ? over.y * H : y0 + h / 2;
    fits[i] = { s, ox: cx - (g.w * s) / 2, oy: cy - (g.h * s) / 2 };
  };
  if (narrow) place(0, W * 0.03, H * 0.03, W * 0.94, H * 0.24);
  else place(0, W * 0.1, H * 0.04, W * 0.8, H * 0.34);
  const rest = gs.slice(1);
  const cols = narrow ? 1 : 2, rows = Math.ceil(rest.length / cols);
  const y0 = narrow ? H * 0.29 : H * 0.42, gh = H * 0.97 - y0, gw = W * (narrow ? 0.9 : 0.8), x0 = (W - gw) / 2;
  const cw = gw / cols, ch = gh / rows;
  const s0 = rest.length ? Math.min(...rest.map((g) => Math.min((cw * 0.84) / g.w, (ch * 0.7) / g.h))) : 1;
  rest.forEach((_, j) => {
    const c = j % cols, r = Math.floor(j / cols);
    const inRow = Math.min(cols, rest.length - r * cols);
    const shift = ((cols - inRow) * cw) / 2;
    place(j + 1, x0 + shift + c * cw, y0 + r * ch, cw, ch, s0);
  });
  return fits;
}

/**
 * Сцена v1 → v2: раскладка на опорном экране REF_W×REF_H становится координатами мира.
 * Камера { x: REF_W / 2, y: REF_H / 2, zoom: 1 } на том же экране показывает ровно прежний вид.
 */
export function upgradeV1(scene, W = REF_W, H = REF_H) {
  const fits = layoutV1(scene.objects, W, H);
  const objects = scene.objects.map((o, i) => {
    const { g, own } = glyphV1(o), f = fits[i];
    const at = ([x, y]) => [r1(f.ox + x * f.s), r1(f.oy + y * f.s)];
    const x = { id: o.id, label: o.label };
    if (o.href) x.href = o.href;
    x.strokes = own
      ? g.strokes.map((st) => {
          const s = { r: r2(st.r * f.s), pts: st.pts.map((p) => (p.length > 2 ? [...at(p), r2(p[2] * f.s)] : at(p))) };
          if (st.closed) s.closed = true;
          return s;
        })
      : [];
    if (o.area) x.area = o.area.map(at);
    if (o.window) x.window = clone(o.window);
    return x;
  });
  return { v: 2, objects };
}

/* ---------------- история правок ---------------- */

/** Отмена и повтор: снимки сцены строками. commit — после законченной правки. */
export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.present = null;
  }
  reset(state) {
    this.past = [];
    this.future = [];
    this.present = state;
  }
  /** Записать новое состояние; то же, что сейчас, — не правка. */
  commit(state) {
    if (state === this.present) return false;
    if (this.present !== null) this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = state;
    this.future = [];
    return true;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  undo() {
    if (!this.past.length) return null;
    this.future.push(this.present);
    this.present = this.past.pop();
    return this.present;
  }
  redo() {
    if (!this.future.length) return null;
    this.past.push(this.present);
    this.present = this.future.pop();
    return this.present;
  }
}
