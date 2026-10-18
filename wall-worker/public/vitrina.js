// Витрина sdominanta.net на движке кисти хранителя (VOID BRUSH ENGINE) — бесконечный холст.
// Сцена = объекты в координатах мира {id, жилы, ссылка, подпись, область, окно, параметры} из data-scene холста
// (опубликованная версия — /vitrina/scene.json, её правит хранитель в /k). Экран — камера над миром (model.js).
// <nav> под холстом Worker строит из той же сцены — все объекты всегда, без камеры.
// Жила — осевая линия + радиус; пустота жилы резонирует и расталкивает узлы живого поля, на стенках
// узлы уплотняются в светящийся контур. Шрифтов нет: подписи — те же жилы, текст окон — жилы символов (/vitrina/font.json).
// Колёсико — масштаб к курсору, перетаскивание — сдвиг, два пальца — щипок и сдвиг, двойной клик или кнопка — вся сцена.
// Холст ограничен тем, что на нём есть (рамка всех объектов): дальше общего вида не отдалиться, за край не уйти.
// У хранителя в инструментах правки рамка шире — место, чтобы рисовать рядом.
// Клик открывает ссылку объекта или его окно из пустоты; Tab подсвечивает объекты по очереди (фокус на ссылке <nav>).
// Считается только то, что видит камера: жилы — кусками, поле — клетками мира; частицы — по уровню масштаба.
// Пауза при скрытой вкладке, при prefers-reduced-motion — статичный кадр. Внешних адресов нет: только свой домен.
import * as M from '/vitrina/model.js';

const { Camera, Scene, ZOOM_MAX, contains, expand, inPoly, intersects, isEmpty } = M;

(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const cv = document.getElementById('scene');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d', { alpha: false });
  const glowCv = document.createElement('canvas');
  const gctx = glowCv.getContext('2d');
  const glow2 = document.createElement('canvas'), g2ctx = glow2.getContext('2d');
  const keeper = root.dataset.keeper === '1';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------------------------------------------------------------
     0. СЦЕНА И КАМЕРА
     --------------------------------------------------------------------- */
  let scene = new Scene({ v: 2, objects: [] });
  const cam = new Camera();
  let W = 0, H = 0, DPR = 1, T = 0;
  let hl = -1; // индекс подсвеченного объекта
  let userMoved = false; // камеру двигал человек: при смене размера окна не возвращать к общему виду
  let tween = null; // плавный перелёт камеры { from, to, t }
  const S = { drift: 1.4, density: 0.85, glow: 0.8, haze: 0.45, sound: 1, reach: 0.45, horizon: 0.6 }; // пространство всей сцены
  // Слух: music.js отдаёт раз в кадр полосы частот, басы/середину/верх, громкость и удар (0..1). Без музыки — нули.
  const SILENT = { bands: new Float32Array(1), low: 0, mid: 0, high: 0, level: 0, beat: 0, on: false };
  let hearFn = null, snd = SILENT;

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function hashInts(a, b, c) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function mulberry(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Уровень масштаба: степень двойки, ближайшая к zoom. Внутри уровня жилы и поле не пересобираются,
     u — сколько единиц мира в пикселе экрана на этом уровне; все «пиксельные» постоянные движка умножаются на u. */
  let lv = 1, u = 1;
  let built = null; // { lv, rect } — прямоугольник мира, для которого собраны жилы и поле
  let fieldPx = 14, fieldSp = 14; // шаг поля: на экране и в мире

  /* ---------------------------------------------------------------------
     1. ЖИЛЫ: осевые линии в координатах мира, равномерный шаг; куски по CH точек — единица отсечения
     --------------------------------------------------------------------- */
  const STEP = 3, CH = 64, SHIFT = 20, MASK = (1 << SHIFT) - 1;
  let veins = [];
  let chunks = []; // { v, j0, j1, bb, vis, key }
  let segGrid = null, segCell = 32, segCols = 0, segRows = 0, gx0 = 0, gy0 = 0;
  let liveStroke = null; // { obj, st } — мазок хранителя, который рисуется прямо сейчас

  function resample(pts, step) {
    const out = [pts[0][0], pts[0][1], pts[0][2]];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-9) continue;
      let pos = step - acc;
      while (pos <= L) {
        const t = pos / L;
        out.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
        pos += step;
      }
      acc = L - (pos - step);
    }
    const lp = pts[pts.length - 1], n = out.length;
    if (Math.hypot(lp[0] - out[n - 3], lp[1] - out[n - 2]) > step * 0.25) out.push(lp[0], lp[1], lp[2]);
    return out;
  }

  /** Параметры объекта для жилы: свои у объекта или по умолчанию. */
  function styleOf(o) {
    return { thick: o.get('thick'), resonance: o.get('resonance'), tact: o.get('tact'), flow: o.get('flow'), wobble: o.get('wobble'), fill: o.get('fill'), sound: o.get('sound') };
  }

  function buildVeins() {
    soundKey = null; // сцена правилась: пересчитать, кто какую полосу играет и где стоит
    veins = [];
    chunks = [];
    if (!built) return;
    const objs = scene.objects;
    const reach = fieldSp * 3;
    const area = expand(built.rect, reach);
    const add = (st, oi, si) => {
      if (!st.pts || st.pts.length < 1 || veins.length >= 2047) return;
      const o = objs[oi];
      let pts = st.pts.map((p) => [p[0], p[1], p[2] || st.r]);
      if (st.closed && pts.length > 2) pts.push(pts[0]);
      if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.5 * u, pts[0][1], pts[0][2]]];
      let step = STEP * u, len0 = 0;
      for (let i = 1; i < pts.length; i++) len0 += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      step = Math.max(step, len0 / 200000);
      const f = resample(pts, step), n = Math.min(MASK, f.length / 3);
      const x = new Float32Array(n), y = new Float32Array(n), rb = new Float32Array(n);
      let R = 0;
      for (let i = 0; i < n; i++) {
        x[i] = f[3 * i]; y[i] = f[3 * i + 1]; rb[i] = Math.max(2.5 * u, f[3 * i + 2]); R = Math.max(R, rb[i]);
      }
      const closed = !!st.closed;
      const k = si < 0 ? 7 : hashStr(o.id) ^ Math.imul(si + 1, 7919);
      const rnd = mulberry(k);
      const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
      const nx = new Float32Array(n), ny = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        if (closed && (i === 0 || i === n - 1)) { a = n - 2; b = 1; }
        const tx = x[b] - x[a], ty = y[b] - y[a], l = Math.hypot(tx, ty) || 1;
        nx[i] = -ty / l; ny[i] = tx / l;
      }
      // статичная «рукописная» волнистость стенки
      const wob = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const s = (i * step) / R;
        wob[i] = Math.sin(s * 1.9 + ph[0]) * 0.55 + Math.sin(s * 4.7 + ph[1]) * 0.3 + Math.sin(s * 0.53 + ph[2]) * 0.4;
      }
      // формы мод вдоль линии: стоячие волны у открытой, вращающаяся у замкнутой
      const len = Math.max(step, (n - 1) * step), m1 = new Float32Array(n), m2 = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = ((closed ? 6.283 : Math.PI) * i * step) / len;
        m1[i] = closed ? Math.cos(a) : Math.sin(a); m2[i] = closed ? Math.sin(a) : Math.sin(2 * a);
      }
      const v = {
        x, y, nx, ny, rb, n, R, len, step, wob, m1, m2, rad: new Float32Array(n), ph, k, closed, live: si < 0,
        region: 0, obj: oi, si, st: styleOf(o), lod: o.$lod, vis: true, chunks: [],
      };
      const vi = veins.length;
      veins.push(v);
      // куски жилы: только задевающие собранный прямоугольник мира
      const m = R * v.st.thick * 2 + fieldSp * 2;
      for (let j0 = 0, c = 0; j0 < n - 1 || (n === 1 && j0 === 0); j0 += CH, c++) {
        const j1 = Math.min(n - 1, j0 + CH);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = j0; i <= j1; i++) { x0 = Math.min(x0, x[i]); y0 = Math.min(y0, y[i]); x1 = Math.max(x1, x[i]); y1 = Math.max(y1, y[i]); }
        const bb = { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
        if (!intersects(bb, area)) continue;
        const key = `${k}:${n}:${c}:${lv}:${x[0].toFixed(1)}:${y[0].toFixed(1)}`;
        v.chunks.push(chunks.length);
        chunks.push({ v: vi, j0, j1, bb, vis: true, key });
        if (n === 1) break;
      }
    };
    // какие объекты собирать: задевающие собранный прямоугольник; мелкие на экране — без частиц (только ось)
    for (const oi of scene.layers()) {
      const o = objs[oi], b = o.bounds();
      if (isEmpty(b) || !intersects(b, area)) continue;
      o.$lod = Math.max(b.x1 - b.x0, b.y1 - b.y0) * lv >= 36;
      o.strokes.forEach((st, si) => add(st, oi, si));
    }
    if (liveStroke) { objs[liveStroke.obj].$lod = true; add(liveStroke.st, liveStroke.obj, -1); }
    buildSegGrid();
    buildRegions();
    buildMembrane();
    buildField(true);
  }

  function maxRadius(v) { return v.R * v.st.thick * 1.3 * (1 + 0.25 * v.st.wobble + 0.7 * v.st.resonance) + 2 * u; }

  function buildSegGrid() {
    const rect = expand(built.rect, fieldSp * 3);
    segCell = 32 * u;
    gx0 = rect.x0; gy0 = rect.y0;
    segCols = Math.ceil((rect.x1 - rect.x0) / segCell) + 1; segRows = Math.ceil((rect.y1 - rect.y0) / segCell) + 1;
    segGrid = new Array(segCols * segRows);
    const reach = fieldSp * 2.2;
    for (const ch of chunks) {
      const vi = ch.v, v = veins[vi], m = maxRadius(v) + reach;
      for (let i = ch.j0; i < Math.max(ch.j0 + 1, ch.j1) && i < v.n - 1; i++) {
        const x0 = Math.min(v.x[i], v.x[i + 1]) - m, x1 = Math.max(v.x[i], v.x[i + 1]) + m;
        const y0 = Math.min(v.y[i], v.y[i + 1]) - m, y1 = Math.max(v.y[i], v.y[i + 1]) + m;
        const cx0 = Math.max(0, Math.floor((x0 - gx0) / segCell)), cx1 = Math.min(segCols - 1, Math.floor((x1 - gx0) / segCell));
        const cy0 = Math.max(0, Math.floor((y0 - gy0) / segCell)), cy1 = Math.min(segRows - 1, Math.floor((y1 - gy0) / segCell));
        const code = vi * (MASK + 1) + i;
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * segCols + cx;
          (segGrid[c] || (segGrid[c] = [])).push(code);
        }
      }
    }
  }

  /* Области: жилы, касающиеся друг друга, звучат как одно тело. Частота области ∝ 1 / её длина. */
  let regions = [];
  function buildRegions() {
    const par = veins.map((_, i) => i);
    const find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
    veins.forEach((v, vi) => {
      for (let i = 0; i < v.n; i += 2) {
        const cx = Math.floor((v.x[i] - gx0) / segCell), cy = Math.floor((v.y[i] - gy0) / segCell);
        if (cx < 0 || cy < 0 || cx >= segCols || cy >= segRows) continue;
        const list = segGrid[cy * segCols + cx];
        if (!list) continue;
        for (const code of list) {
          const vj = Math.floor(code / (MASK + 1));
          // такт и резонанс — свои у каждого объекта: области сливаются только внутри одного объекта
          if (vj === vi || veins[vj].obj !== v.obj || find(vj) === find(vi)) continue;
          const w = veins[vj], j = code & MASK;
          const ax = w.x[j], ay = w.y[j], ex = w.x[j + 1] - ax, ey = w.y[j + 1] - ay, el = ex * ex + ey * ey || 1e-9;
          const t = Math.max(0, Math.min(1, ((v.x[i] - ax) * ex + (v.y[i] - ay) * ey) / el));
          if (Math.hypot(v.x[i] - ax - ex * t, v.y[i] - ay - ey * t) < (v.rb[i] + w.rb[j]) * v.st.thick) par[find(vi)] = find(vj);
        }
      }
    });
    const idx = new Map();
    regions = [];
    veins.forEach((v, vi) => {
      const r = find(vi);
      if (!idx.has(r)) { idx.set(r, regions.length); regions.push({ len: 0, ph: (r * 2.399) % 6.283, tact: v.st.tact, obj: v.obj }); }
      v.region = idx.get(r);
      regions[v.region].len += v.len;
    });
    for (const r of regions) r.f = Math.max(0.12, Math.min(2.6, 220 / Math.max(1, r.len)));
  }

  /*
   * Музыка в пространстве. Источник — объект-плеер (slot player) или сам виджет плеера на экране.
   * Каждый объект слышит её по расстоянию до источника (space.reach — радиус, доля размера сцены) и в своей полосе:
   * толстые моды играют басы, чем тоньше (плотнее) мода — тем выше её частоты. Энергия o.$e ускоряет такт,
   * раскачивает резонанс и светит плазму объекта. Басы (удар) пускают волну от плеера сквозь всё.
   */
  const music = { on: false, x: 0, y: 0, r2: 0, k: 0 };
  let soundKey = null, lastBeat = 0;
  function soundMap() {
    const objs = scene.objects;
    const order = objs.map((o, i) => [o.strokes.length ? o.tubeR() : 0, i]).sort((a, b) => b[0] - a[0]);
    order.forEach(([, i], r) => { objs[i].$q = order.length > 1 ? r / (order.length - 1) : 0.5; });
    for (const o of objs) {
      const b = o.bounds();
      o.$cx = (b.x0 + b.x1) / 2; o.$cy = (b.y0 + b.y1) / 2; o.$ext = isEmpty(b) ? 0 : Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2;
    }
    soundKey = scene;
  }
  function hear(dt) {
    const objs = scene.objects;
    if (soundKey !== scene) soundMap();
    const on = snd.on || snd.level > 0.01;
    if (on) {
      const po = objs.find((o) => o.slot === 'player');
      if (po) { music.x = po.$cx; music.y = po.$cy; }
      else {
        const el = document.querySelector('[data-slot="player"]'), rc = el && el.getBoundingClientRect();
        if (rc && rc.width) [music.x, music.y] = cam.toWorld((rc.left + rc.width / 2) * VK, (rc.top + rc.height / 2) * VK, W, H);
        else [music.x, music.y] = [cam.x, cam.y];
      }
      const sb = scene.bounds(), R = Math.max(1, Math.hypot(sb.x1 - sb.x0, sb.y1 - sb.y0) * S.reach);
      music.r2 = 1 / (R * R);
      music.k = S.sound * snd.level * 1.5;
      if (snd.beat > 0.9 && lastBeat <= 0.9) {
        const [sx, sy] = cam.toScreen(music.x, music.y, W, H);
        pulse(sx, sy, Math.min(1.2, 0.5 + snd.low) * S.sound);
      }
    }
    lastBeat = snd.beat;
    music.on = on;
    const nb = snd.bands.length, s = 1 - Math.exp(-(dt || 0) * 10);
    for (const o of objs) {
      let e = 0;
      if (on && o.$ext !== undefined) {
        const d = Math.max(0, Math.hypot(o.$cx - music.x, o.$cy - music.y) - o.$ext), g = Math.exp(-d * d * music.r2);
        const c = Math.round(o.$q * (nb - 1));
        let sum = 0, n = 0;
        for (let k = Math.max(0, c - 2); k <= Math.min(nb - 1, c + 2); k++) { sum += snd.bands[k]; n++; }
        e = o.get('sound') * S.sound * g * (n ? sum / n : 0) * 1.6;
      }
      o.$e = (o.$e || 0) + (e - (o.$e || 0)) * s;
    }
  }

  /*
   * Басовая волна: кольцо, бегущее от точки по сети (мир → экран). Её пускают упор в пределе над пустым местом
   * (вместо дрожи экрана) и удары басов музыки (от плеера, сквозь всё). Узлы на фронте толкаются наружу и вспыхивают,
   * жилы на фронте набухают.
   */
  const waves = [];
  const WAVE_SPEED = 900, WAVE_W = 46;
  function pulse(sx, sy, amp, speed) {
    const [x, y] = cam.toWorld(sx, sy, W, H);
    if (waves.length >= 6) waves.shift();
    waves.push({ x, y, t: T, amp: reduce.matches ? 0 : amp, sp: speed || WAVE_SPEED });
    loop();
  }
  function stepWaves() {
    const far = Math.hypot(W, H) * 1.2;
    for (let k = waves.length - 1; k >= 0; k--) {
      const w = waves[k], age = T - w.t;
      w.r = age * w.sp * VK;
      w.a = w.amp * Math.exp(-age * 1.1 * (w.sp / WAVE_SPEED)); // медленная волна и гаснет медленнее
      if (w.r > far || w.a < 0.02) waves.splice(k, 1);
    }
  }
  /*
   * Колёсико в пределе: частая прокрутка — удар быстрее и сильнее, медленная — тихая медленная волна.
   * rate — пиксели колёсика в секунду (скользящая оценка); волн не чаще, чем позволяет темп.
   */
  const wheelRate = { v: 0, t: 0, last: -1 };
  function wheelPulse(sx, sy, dy) {
    const now = performance.now() / 1000, gap = Math.max(0.001, now - wheelRate.t);
    wheelRate.v = wheelRate.v * Math.exp(-gap * 3) + dy;
    wheelRate.t = now;
    const rate = wheelRate.v * 3; // ≈ пикселей в секунду
    const q = Math.min(1, rate / 3000);
    if (T - wheelRate.last < 0.5 - 0.38 * q) return;
    wheelRate.last = T;
    pulse(sx, sy, 0.35 + 1.1 * q, 380 + 1500 * q);
  }
  /** Сила волн в точке мира (0…): гаусс по расстоянию до фронта на экране. */
  function waveAt(x, y, z) {
    let f = 0;
    for (const w of waves) {
      const d = Math.hypot(x - w.x, y - w.y) * z - w.r, q = d / (WAVE_W * VK);
      if (q > -3 && q < 3) f += w.a * Math.exp(-q * q);
    }
    return f;
  }

  // Возбуждение моды под курсором — малым пятном (EXC_PX пикселей экрана): набухание, свет плазмы и узлов у стенки.
  const EXC_PX = 60, exc = { x: 0, y: 0, r2: 0, on: false };
  const excAt = (lo, x, y) => (lo < 0.01 ? 0 : exc.on ? lo * Math.exp(-((x - exc.x) ** 2 + (y - exc.y) ** 2) * exc.r2) : lo * 0.4);
  function updateRadii(dt) {
    const objs = scene.objects;
    const [lwx, lwy] = cam.toWorld(mouse.x, mouse.y, W, H), lR = (EXC_PX * VK) / cam.zoom, lR2 = 1 / (lR * lR);
    exc.x = lwx; exc.y = lwy; exc.r2 = lR2; exc.on = mouse.in;
    // Часы объекта: такт и мода идут своим ходом; музыка рядом (o.$e) ускоряет их в такт и раскачивает резонанс.
    for (const o of objs) {
      const e = o.$e || 0, tact = o.get('tact');
      o.$ra = (o.$ra || 0) + (dt || 0) * 6.283 * (0.4 + tact) * (1 + 1.2 * e);
      o.$tp = (o.$tp || 0) + (dt || 0) * 2.4 * tact * (1 + 1.5 * e);
    }
    const z = cam.zoom;
    for (const r of regions) {
      const ang = (objs[r.obj].$ra || 0) * r.f;
      r.S1 = Math.sin(ang + r.ph); r.C1 = Math.cos(ang + r.ph); r.S2 = Math.sin(2 * ang + r.ph * 1.7);
    }
    for (const v of veins) {
      if (!v.vis) continue;
      const r = regions[v.region], st = v.st, ob = objs[v.obj], tp = ob.$tp || 0, res = st.resonance * (1 + 0.8 * (ob.$e || 0));
      const modeA = v.closed ? r.S1 : r.S1 * 0.7, modeB = v.closed ? r.C1 : r.S2 * 0.45;
      // возбуждение моды под курсором: вся мода светлеет и чуть набухает, сильнее — только у самого курсора
      const lo = ob.$lift || 0;
      let lam = v.R * 10;
      if (v.closed) lam = v.len / Math.max(1, Math.round(v.len / lam));
      for (let i = 0; i < v.n; i++) {
        const s = i * v.step;
        const beat = 0.5 + 0.5 * Math.sin((s / lam) * 6.283 - tp + v.ph[3]);
        const pulse = beat * beat * beat * beat;
        const mode = v.m1[i] * modeA + v.m2[i] * modeB;
        let lift = 1;
        if (lo > 0.01) {
          if (mouse.in) { const dx = v.x[i] - lwx, dy = v.y[i] - lwy; lift = 1 + 0.25 * lo * Math.exp(-(dx * dx + dy * dy) * lR2); }
          else lift = 1 + 0.12 * lo;
        }
        if (waves.length) lift *= 1 + 0.4 * waveAt(v.x[i], v.y[i], z);
        v.rad[i] = v.rb[i] * st.thick * lift * (1 + 0.16 * st.wobble * v.wob[i] + res * (0.45 * pulse + 0.3 * mode));
      }
    }
  }

  // Запрос к полю пустоты: знаковое расстояние до стенки ближайшей жилы (мир)
  let qSd = 0, qNx = 0, qNy = 0, qTx = 0, qTy = 0, qV = -1;
  function queryVoid(px, py) {
    qSd = Infinity; qV = -1;
    const cx = Math.floor((px - gx0) / segCell), cy = Math.floor((py - gy0) / segCell);
    if (!segGrid || cx < 0 || cy < 0 || cx >= segCols || cy >= segRows) return;
    const list = segGrid[cy * segCols + cx];
    if (!list) return;
    for (let j = 0; j < list.length; j++) {
      const code = list[j], vi = Math.floor(code / (MASK + 1)), v = veins[vi], i = code & MASK;
      const ax = v.x[i], ay = v.y[i], ex = v.x[i + 1] - ax, ey = v.y[i + 1] - ay;
      const el = ex * ex + ey * ey || 1e-12;
      let t = ((px - ax) * ex + (py - ay) * ey) / el;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - ax - ex * t, dy = py - ay - ey * t;
      const d = Math.sqrt(dx * dx + dy * dy);
      const sd = d - (v.rad[i] + (v.rad[i + 1] - v.rad[i]) * t);
      if (sd < qSd) {
        qSd = sd; qV = vi;
        const l = Math.sqrt(el); qTx = ex / l; qTy = ey / l;
        if (d > 1e-6) { qNx = dx / d; qNy = dy / d; } else { qNx = -ey / l; qNy = ex / l; }
      }
    }
  }

  /* ---------------------------------------------------------------------
     2. ПОЛЕ: живые узлы пространства в мире. Редкая сетка — клетками мира (одни и те же узлы при сдвиге),
     плотная полоса вдоль каждого куска жилы. Состояние узлов переживает пересборку по ключам.
     --------------------------------------------------------------------- */
  let NF = 0;
  let fx, fy, fvx, fvy, fhx, fhy, fph, fb, fsc, fcode = new Int32Array(0);
  // ответ поля пустоты на узел — по очереди: каждый кадр пересчитывается треть узлов, остальные берут прошлый
  // (узел за кадр сдвигается на доли пикселя). Это главный расход кадра, и он растёт с толщиной жил.
  let vSd, vNx, vNy, vTx, vTy, vV, vTick = 0, fon = new Uint8Array(0);
  const VOID_EVERY = 3;
  let fkeys = new Map(); // ключ клетки или куска → [начало, число]

  function calcPx() { return Math.max(10, Math.sqrt((W * H) / 9000)) / S.density; }
  // Одна картина на любом экране: движок считает кадр для экрана-образца (не больше REF_AREA пикселей CSS),
  // холст растягивается на весь экран. Большой экран получает ту же композицию крупнее, а не в разы больше узлов.
  // W, H, мышь и камера внутри движка — в пикселях образца; наружу (редактору) — в пикселях CSS, множитель VK.
  // PIXEL_BUDGET — пикселей холста: хватает на экран ноутбука с ретиной (2880×1800); медленнее — снизит регулятор качества.
  const REF_AREA = 700000, PIXEL_BUDGET = 5200000, BAND_BUDGET = 7000;
  let VK = 1, SPARK = 1;

  // Качество под устройство — плавно и по месту. Узлы собираются всегда полностью; у каждого свой постоянный ранг.
  // Там, куда смотрят (курсор, раскрытая рама, центр экрана), считаются и рисуются все узлы, к краям экрана —
  // только доля qG. Движок меряет свой кадр: не успевает — qG понемногу снижается, запас — понемногу растёт.
  // Ни пересборки, ни смены размера холста: ничего не мигает.
  let qG = 1;
  const perf = { work: 8, gap: 16.7 };
  function govern(work, gap, dt) {
    perf.work += (work - perf.work) * 0.05;
    perf.gap += (Math.min(100, gap) - perf.gap) * 0.05;
    if (going) return;
    if (perf.work > 11 || perf.gap > 26) qG = Math.max(0.2, qG - dt * 0.3);
    else if (perf.work < 6 && perf.gap < 19) qG = Math.min(1, qG + dt * 0.06);
  }

  let fieldGen = 0; // номер сборки поля: рама пересобирает свою группу узлов после пересборки
  function buildField(keep) {
    fieldGen++;
    const old = keep && fx ? { fx, fy, fvx, fvy, fb, fkeys } : null;
    fieldPx = calcPx();
    fieldSp = fieldPx * u;
    const H_ = [], ph = [], groups = [];
    const rect = expand(built.rect, fieldSp * 2);
    const sp = fieldSp, rh = sp * 0.866;
    const r0 = Math.floor(rect.y0 / rh) - 1, r1 = Math.ceil(rect.y1 / rh) + 1;
    const c0 = Math.floor(rect.x0 / sp) - 1, c1 = Math.ceil(rect.x1 / sp) + 1;
    for (let r = r0; r <= r1; r++) {
      const key = `r${lv}:${r}:${c0}:${c1}`, start = H_.length / 3;
      for (let c = c0; c <= c1; c++) {
        const rnd = mulberry(hashInts(c, r, lv));
        H_.push((c + (r & 1) * 0.5) * sp + (rnd() - 0.5) * sp * 0.7, r * rh + (rnd() - 0.5) * sp * 0.7, sp);
        ph.push(rnd() * 6.283);
      }
      groups.push([key, start, c1 - c0 + 1]);
    }
    // Полосы узлов вдоль жил. Толщина расширяет полосу, но узлы в ней реже (шаг растёт как корень четвёртой
    // степени ширины), а все полосы вместе не больше BAND_BUDGET узлов: иначе толстые жилы съедают кадр.
    const plan = [];
    let total = 0;
    for (const ch of chunks) {
      const v = veins[ch.v];
      if (v.live || !v.lod) continue;
      const near = Math.min(fieldSp * 1.3, v.R * 2.5 + fieldSp * 0.5);
      // полоса узлов вокруг тонкой жилы уже: иначе мелкие слова тонут в ореоле
      const B = v.R * v.st.thick * 1.5 + near, B1 = v.R * 1.5 + near;
      const sf = (Math.max(4.2 * u, Math.min(fieldSp * 0.62, v.R * 0.55)) / Math.sqrt(S.density)) * Math.pow(Math.max(1, B / B1), 0.25);
      const span = Math.max(1, ch.j1 - ch.j0);
      const cnt = ((span * v.step * 2 * B) / (sf * sf)) * 0.65;
      plan.push({ ch, v, B, sf, span, cnt });
      total += cnt;
    }
    const kB = Math.min(1, BAND_BUDGET / Math.max(1, total)), kS = 1 / Math.sqrt(kB);
    for (const { ch, v, B, sf: sf0, span, cnt: c0 } of plan) {
      const start = H_.length / 3;
      const sf = sf0 * kS, cnt = Math.round(c0 * kB);
      const r2 = mulberry(hashStr(ch.key));
      for (let i = 0; i < cnt; i++) {
        const j = Math.min(v.n - 1, ch.j0 + ((r2() * span) | 0)), t = (r2() * 2 - 1) * B;
        H_.push(v.x[j] + v.nx[j] * t + (r2() - 0.5) * v.step, v.y[j] + v.ny[j] * t + (r2() - 0.5) * v.step, sf);
        ph.push(r2() * 6.283);
      }
      groups.push([ch.key, start, cnt]);
    }
    NF = H_.length / 3;
    fx = new Float32Array(NF); fy = new Float32Array(NF); fvx = new Float32Array(NF); fvy = new Float32Array(NF);
    fhx = new Float32Array(NF); fhy = new Float32Array(NF); fph = new Float32Array(NF); fb = new Float32Array(NF);
    fsc = new Float32Array(NF); fcode = new Int32Array(NF);
    vSd = new Float32Array(NF); vNx = new Float32Array(NF); vNy = new Float32Array(NF); vTx = new Float32Array(NF); vTy = new Float32Array(NF);
    vV = new Int32Array(NF).fill(-2); // -2 — ещё не спрашивали
    for (let k = 0; k < NF; k++) {
      fhx[k] = fx[k] = H_[3 * k]; fhy[k] = fy[k] = H_[3 * k + 1]; fsc[k] = H_[3 * k + 2]; fph[k] = ph[k];
    }
    fkeys = new Map();
    for (const [key, start, cnt] of groups) {
      fkeys.set(key, [start, cnt]);
      const o = old && old.fkeys.get(key);
      if (!o || o[1] !== cnt) continue;
      for (let i = 0; i < cnt; i++) {
        fx[start + i] = old.fx[o[0] + i]; fy[start + i] = old.fy[o[0] + i];
        fvx[start + i] = old.fvx[o[0] + i]; fvy[start + i] = old.fvy[o[0] + i]; fb[start + i] = old.fb[o[0] + i];
      }
    }
  }

  /* ---------------------------------------------------------------------
     3. МЕМБРАНА: плазма внутри жилы (s вдоль, u поперёк), кусками; положение считается из s и u каждый кадр
     --------------------------------------------------------------------- */
  let homeZ = 1; // масштаб общего вида: глубже — курсор действует на меньший круг
  let NM = 0, mv, mc, ms, mu, mph, mx, my, mb;
  function buildMembrane() {
    const list = [];
    chunks.forEach((ch, ci) => {
      const v = veins[ch.v];
      if (!v.lod) return;
      const rnd = mulberry(hashStr('m' + ch.key));
      const sp = Math.max(3.6 * u, v.R * 0.42);
      const span = Math.max(1, ch.j1 - ch.j0) * v.step;
      const count = Math.round((span * 2 * v.R) / (sp * sp)) + 1;
      for (let i = 0; i < count; i++) {
        let t = rnd() * 2 - 1;
        if (rnd() < 0.3) t = Math.sign(t || 1) * (0.82 + rnd() * 0.18); // ряды у стенок гуще — яркий кант
        list.push(ch.v, ci, ch.j0 * v.step + rnd() * span, t, rnd() * 6.283);
      }
    });
    NM = list.length / 5;
    mv = new Uint16Array(NM); mc = new Uint32Array(NM); ms = new Float32Array(NM); mu = new Float32Array(NM); mph = new Float32Array(NM);
    mx = new Float32Array(NM); my = new Float32Array(NM); mb = new Float32Array(NM);
    for (let i = 0; i < NM; i++) { mv[i] = list[5 * i]; mc[i] = list[5 * i + 1]; ms[i] = list[5 * i + 2]; mu[i] = list[5 * i + 3]; mph[i] = list[5 * i + 4]; }
  }

  /** Собрать жилы и поле для того, что видит камера: при смене уровня масштаба или выходе за собранный прямоугольник. */
  function ensureView(force) {
    if (!force && rama && rama.dive) return false; // провал в область: те же узлы растягиваются, новых нет
    const view = cam.view(W, H);
    const level = 2 ** Math.round(Math.log2(cam.zoom));
    if (!force && built && built.lv === level && contains(built.rect, view)) return false;
    const w = view.x1 - view.x0, h = view.y1 - view.y0;
    lv = level; u = 1 / level;
    fieldSp = calcPx() * u;
    built = { lv, rect: expand(view, w * 0.2, h * 0.2) };
    homeZ = cam.clone().fit(scene.bounds(), W, H, 0.05, 0, ZOOM_MAX).zoom;
    buildVeins();
    return true;
  }

  /** Отсечение кадра: куски жил и узлы вне камеры (с полями) не считаются и не рисуются. */
  let act = { x0: 0, y0: 0, x1: 0, y1: 0 };
  function cull() {
    act = expand(cam.view(W, H), fieldSp * 4);
    for (const v of veins) v.vis = false;
    for (const ch of chunks) { ch.vis = intersects(ch.bb, act); if (ch.vis) veins[ch.v].vis = true; }
  }

  /* ---------------------------------------------------------------------
     4. КАДР
     --------------------------------------------------------------------- */
  const mouse = { x: -1e4, y: -1e4, in: false };
  const NB = 10;
  const bucket = Array.from({ length: NB }, () => []);
  let hHead = null, hNext = null;

  function colorFor(f) {
    // тёмная бирюза → циан #00f2fe → почти белый
    let r, g, b;
    if (f < 0.55) { const t = f / 0.55; r = 8 * (1 - t); g = 80 + 162 * t; b = 96 + 158 * t; }
    else { const t = (f - 0.55) / 0.45; r = 220 * t; g = 242 + 13 * t; b = 254; }
    return `rgba(${r | 0},${g | 0},${b | 0},${(0.1 + 0.9 * f).toFixed(3)})`;
  }
  const COLORS = Array.from({ length: NB }, (_, k) => colorFor((k + 0.5) / NB));

  /**
   * Связи соседних узлов (экранные координаты): сетка ячеек, сила связи — в ведро своего цвета.
   * У узлов свой размах связи (SC·scK·1.6, не больше L). Крупные связываются в сетке с ячейкой L, а пары, где хоть
   * один узел мелкий (размах ≤ L/2), — в сетке с ячейкой L/2: в плотных полосах у жил вчетверо меньше пустых проверок.
   */
  let hReach = new Float32Array(0), hBig = new Uint8Array(0);
  function linkNodes(X, Y, B, n, L, gain, base, SC, scK, CODE) {
    if (hReach.length < n) { hReach = new Float32Array(Math.max(n, 1024)); hBig = new Uint8Array(hReach.length); }
    const half = L / 2;
    for (let i = 0; i < n; i++) { const r = SC ? Math.min(L, SC[i] * scK * 1.6) : L; hReach[i] = r; hBig[i] = r > half ? 1 : 0; }
    linkPass(X, Y, B, n, L, gain, base, CODE, 1);
    if (SC) linkPass(X, Y, B, n, half, gain, base, CODE, 0);
  }
  /** Один проход: big = 1 — только пары крупных; big = 0 — пары, где хоть один мелкий. */
  function linkPass(X, Y, B, n, cell, gain, base, CODE, big) {
    const cols = Math.ceil(W / cell) + 2, rows = Math.ceil(H / cell) + 2;
    if (!hHead || hHead.length < cols * rows) hHead = new Int32Array(cols * rows);
    if (!hNext || hNext.length < n) hNext = new Int32Array(Math.max(n, 1024));
    hHead.fill(-1, 0, cols * rows);
    for (let i = 0; i < n; i++) {
      if (big && !hBig[i]) { hNext[i] = -2; continue; }
      const cx = Math.floor(X[i] / cell) + 1, cy = Math.floor(Y[i] / cell) + 1;
      if (!(cx >= 0 && cy >= 0 && cx < cols && cy < rows)) { hNext[i] = -2; continue; }
      const c = cy * cols + cx; hNext[i] = hHead[c]; hHead[c] = i;
    }
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      for (let i = hHead[cy * cols + cx]; i >= 0; i = hNext[i]) {
        const xi = X[i], yi = Y[i], ri = hReach[i], bi = hBig[i], ci = CODE ? CODE[i] : 0, Bi = B[i];
        for (let k = 0; k < 5; k++) {
          const nx = cx + OFFX[k], ny = cy + OFFY[k];
          if (nx < 0 || nx >= cols || ny >= rows) continue;
          for (let j = k ? hHead[ny * cols + nx] : hNext[i]; j >= 0; j = hNext[j]) {
            if (!big && bi && hBig[j]) continue; // пара крупных — уже в первом проходе
            const dx = xi - X[j], dy = yi - Y[j], d2 = dx * dx + dy * dy;
            const Lp = ri < hReach[j] ? ri : hReach[j];
            if (d2 > Lp * Lp) continue;
            if (ci && ci === -CODE[j]) continue; // связь не перекидывается через пустоту
            const f = (1 - Math.sqrt(d2) / Lp) * (base + (1 - base) * (Bi > B[j] ? Bi : B[j])) * gain;
            if (f < 0.02) continue;
            bucket[Math.min(NB - 1, (f * NB) | 0)].push(xi, yi, X[j], Y[j]);
          }
        }
      }
    }
  }
  const OFFX = [0, 1, -1, 0, 1], OFFY = [0, 0, 1, 1, 1];

  function flush(widthBase) {
    for (let k = 0; k < NB; k++) {
      const a = bucket[k];
      if (!a.length) continue;
      ctx.strokeStyle = COLORS[k];
      ctx.lineWidth = (widthBase + (0.9 * k) / NB) * VK;
      ctx.beginPath();
      for (let i = 0; i < a.length; i += 4) { ctx.moveTo(a[i], a[i + 1]); ctx.lineTo(a[i + 2], a[i + 3]); }
      ctx.stroke();
      a.length = 0;
    }
  }

  let marks = []; // области, отмеченные редактором: узлы внутри светятся
  let hoverEntry = null; // вход (объект или его область) под курсором — раз в несколько кадров
  function litOf(poly, b) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return { poly, b, x0, y0, x1, y1 };
  }

  /*
   * Рама из узлов области. Группа — узлы поля внутри области объекта в миг раскрытия. Каждый узел помнит направление
   * от середины области и свою глубину в ней (доля от края области в этом направлении). Цель узла — луч из середины
   * окна в том же направлении до контура окна (суперэллипс: round 0 — почти прямоугольник, 1 — овал), плюс глубина × ring
   * наружу. Любая форма области так разворачивается в понятное окно: середина пустеет под новую моду, край — рамка.
   */
  let fcap = new Uint8Array(0), ftx = new Float32Array(0), fty = new Float32Array(0);
  function capture(f) {
    const a = f.o.area, L = litOf(a, 0);
    let cx = 0, cy = 0;
    for (const p of a) { cx += p[0]; cy += p[1]; }
    cx /= a.length; cy /= a.length;
    // направления — в долях рамки области: вытянутая область ложится по всему контуру окна, а не грудой на двух сторонах
    const hx = Math.max(1e-6, (L.x1 - L.x0) / 2), hy = Math.max(1e-6, (L.y1 - L.y0) / 2);
    if (fcap.length < NF) { fcap = new Uint8Array(NF); ftx = new Float32Array(NF); fty = new Float32Array(NF); } else fcap.fill(0);
    const BINS = 48, top = new Float32Array(BINS), idx = [], th = [], dd = [];
    for (let i = 0; i < NF; i++) {
      if (fx[i] < L.x0 || fx[i] > L.x1 || fy[i] < L.y0 || fy[i] > L.y1 || !inPoly(a, fx[i], fy[i])) continue;
      const dx = (fx[i] - cx) / hx, dy = (fy[i] - cy) / hy, d = Math.hypot(dx, dy), t = Math.atan2(dy, dx);
      const bin = Math.min(BINS - 1, (((t + Math.PI) / (2 * Math.PI)) * BINS) | 0);
      if (d > top[bin]) top[bin] = d;
      idx.push(i); th.push(t); dd.push(d);
    }
    const n = idx.length;
    f.cap = Int32Array.from(idx);
    f.cc = new Float32Array(n); f.cs = new Float32Array(n); f.cr = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const bin = Math.min(BINS - 1, (((th[j] + Math.PI) / (2 * Math.PI)) * BINS) | 0);
      f.cc[j] = Math.cos(th[j]); f.cs[j] = Math.sin(th[j]);
      f.cr[j] = Math.min(1, dd[j] / Math.max(1e-6, top[bin]));
      fcap[idx[j]] = 1;
    }
    f.gen = fieldGen;
  }
  /** Цели узлов группы на этот кадр: контур текущего прямоугольника рамы на экране → мир. */
  function ringTargets(f, z) {
    const a = Math.max(4, f.w / 2), b = Math.max(4, f.h / 2), mx = f.x + f.w / 2, my = f.y + f.h / 2;
    // частицы не пропадают: если их больше, чем помещается в рамку при плотности поля ×3, рамка утолщается внутрь
    // и наружу — иначе связи в тесной рамке считаются парами квадратично и кадр встаёт
    const sp = fieldPx * 0.6, need = (f.cap.length * sp * sp) / Math.max(1, 2 * (f.w + f.h));
    const n = 2 + (1 - f.round) * 14, ring = Math.max(f.ring * VK, need), iz = 1 / z;
    for (let j = 0; j < f.cap.length; j++) {
      const i = f.cap[j], c = f.cc[j], s = f.cs[j];
      // луч в долях окна до контура |X|^n + |Y|^n = 1, затем наружу на глубину узла × ring
      const t = Math.pow(Math.pow(Math.abs(c), n) + Math.pow(Math.abs(s), n), -1 / n);
      const off = (f.cr[j] * 0.9 + (fph[i] * 0.15915 - 0.5) * 0.25) * ring;
      ftx[i] = (mx + a * c * t + c * off - W / 2) * iz + cam.x;
      fty[i] = (my + b * s * t + s * off - H / 2) * iz + cam.y;
    }
  }

  function step() {
    cull();
    // басы раскачивают весь континуум; рядом с плеером поле живее (src.k — громкость × реакция пространства)
    const t = T, z = cam.zoom, iz = 1 / z, drift = S.drift * fieldSp * 0.55 * (1 + S.sound * (0.6 * snd.low + 0.3 * snd.beat));
    const src = music.on ? music : null;
    const objs = scene.objects;
    const nb = snd.bands.length;
    // Курсор расталкивает малую область: глубже по масштабу — меньше; у раскрытого окна и в алеф-нуле — ещё меньше;
    // на самой моде (ниже) — ещё уже и слабее.
    const crPx = Math.max(14, Math.min(28, Math.min(W, H) * 0.03)) * Math.max(0.4, Math.min(1, Math.pow(homeZ / z, 0.22))) * (rama || SPACE !== 'main' ? 0.6 : 1);
    const cr = crPx * iz, cr2 = cr * cr;
    const cursorOn = mouse.in && tool === 'view' && (!gesture || (gesture.kind === 'tap' && touchy.matches));
    const [mwx, mwy] = cam.toWorld(mouse.x, mouse.y, W, H);
    for (let i = 0; i < objs.length; i++) objs[i].$lift = (objs[i].$lift || 0) + ((i === hl ? 1 : 0) - (objs[i].$lift || 0)) * (reduce.matches ? 1 : 0.12);
    if (win) win.k += (1 - win.k) * (reduce.matches ? 1 : 0.1);
    // подсвеченные области: под курсором и отмеченные редактором; рамка многоугольника — дешёвая проверка до inPoly
    const lit = [];
    // светится та область объекта, над которой курсор: основная или область-вход
    if (hl >= 0 && objs[hl] && objs[hl].$lift > 0.02) {
      const he = hoverEntry && (hoverEntry === objs[hl] || hoverEntry.parent === objs[hl]) ? hoverEntry : null;
      const a = he ? he.area : objs[hl].area;
      if (a && a.length >= 3) lit.push(litOf(a, 0.6 * objs[hl].$lift));
    }
    for (const m of marks) if (m && m.length >= 3) lit.push(litOf(m, 0.55));
    // рама: узлы области растекаются в рамку окна, фон уходит вдаль
    const R = rama && !rama.dive && rama.o && rama.o.area && rama.o.area.length >= 3 ? rama : null;
    let kk = 0, far = 0;
    if (R) {
      if (R.gen !== fieldGen) capture(R);
      kk = ease(Math.min(1, R.k));
      far = kk * R.far;
      ringTargets(R, z);
    }
    // провал: узлы области — основа нового континуума, светятся ярче по мере падения; остальное поле гаснет
    const D = rama && rama.dive && rama.o && rama.o.area && rama.o.area.length >= 3 ? rama : null;
    let dk = 0;
    if (D) { if (D.gen !== fieldGen) capture(D); dk = Math.max(0, Math.min(1, D.k)); if (D.charge) dk = Math.max(dk, 0.6 * D.q); }
    diveK = rama && rama.dive ? Math.max(0, Math.min(1, rama.k)) : 0;
    const ax0 = act.x0, ay0 = act.y0, ax1 = act.x1, ay1 = act.y1;
    const hole = win || (rama && rama.hole);
    const morph = T < morphUntil; // после входа узлы летят с ободка: в пути не замирают и не спят
    vTick = (vTick + 1) % VOID_EVERY;
    // фокус детализации (мир): раскрытая рама, курсор или центр экрана
    const [qfx, qfy] = rama ? cam.toWorld(rama.x + rama.w / 2, rama.y + rama.h / 2, W, H) : mouse.in ? [mwx, mwy] : [cam.x, cam.y];
    const bandSc = fieldSp * 0.8;
    const qR = (rama ? Math.max(rama.w, rama.h) * 0.8 : Math.max(W, H) * 0.42) * iz, qR2 = 1 / (qR * qR), qLow = qG, qSpan = 1 - qG;
    if (fon.length < NF) fon = new Uint8Array(Math.max(NF, 1024));
    for (let i = 0; i < NF; i++) {
      const cap = R && fcap[i];
      if (!cap && !morph && (fx[i] < ax0 || fx[i] > ax1 || fy[i] < ay0 || fy[i] > ay1)) { fon[i] = 1; continue; } // вне камеры узел замирает
      if (!cap && far > 0 && fph[i] * 0.15915 > 1 - far) { fon[i] = 0; continue; } // фон за раскрытым окном редеет
      if (!cap && !morph && qLow < 1) {
        const ddx = fx[i] - qfx, ddy = fy[i] - qfy, t = 1 - (ddx * ddx + ddy * ddy) * qR2;
        // далеко от фокуса и ранг высок — узел спит; узлы у жил (слова) засыпают последними
        if (fph[i] * 0.15915 * (fsc[i] < bandSc ? 0.55 : 1) > qLow + qSpan * (t > 0 ? t : 0)) { fon[i] = 0; continue; }
      }
      fon[i] = 1;
      let dr = drift;
      if (src) { const dx = fhx[i] - src.x, dy = fhy[i] - src.y; dr *= 1 + src.k * Math.exp(-(dx * dx + dy * dy) * src.r2); }
      const hx = fhx[i] + dr * (Math.sin(fhy[i] * 0.009 * lv + t * 0.35 + fph[i] * 0.3) + 0.5 * Math.sin(fhx[i] * 0.017 * lv - t * 0.27));
      const hy = fhy[i] + dr * (Math.cos(fhx[i] * 0.008 * lv - t * 0.31) + 0.5 * Math.sin(fhy[i] * 0.021 * lv + t * 0.4 + fph[i] * 0.3));
      let ax = (hx - fx[i]) * 0.035, ay = (hy - fy[i]) * 0.035;
      if (vV[i] === -2 || (i + vTick) % VOID_EVERY === 0) {
        queryVoid(fx[i], fy[i]);
        vSd[i] = qSd; vNx[i] = qNx; vNy[i] = qNy; vTx[i] = qTx; vTy[i] = qTy; vV[i] = qV;
      } else { qSd = vSd[i]; qNx = vNx[i]; qNy = vNy[i]; qTx = vTx[i]; qTy = vTy[i]; qV = vV[i]; }
      let b = 0;
      // сторона стенки: узлы с разных берегов одной жилы не связываются
      fcode[i] = qSd < fsc[i] * 1.5 ? (qV + 1) * (qNx * -qTy + qNy * qTx >= 0 ? 1 : -1) : 0;
      if (qSd < Infinity) {
        const v = veins[qV];
        if (qSd < 0) { const p = -qSd * 0.32; ax += qNx * p; ay += qNy * p; b = 1; }
        else { const q = qSd / (fsc[i] * 1.6); b = Math.exp(-q * q); }
        // Параметры объекта (течение, такты, резонанс, звук) — его собственная жизнь, поле их не перенимает:
        // узлы пространства только расступаются перед стенкой и светятся у неё; ритм поля — свой (дрейф, space.sound).
        b *= 1 + 0.7 * excAt(objs[v.obj].$lift || 0, fx[i], fy[i]);
      }
      if (cap && kk > 0) {
        // узел области идёт на своё место в рамке; свой дрейф и стенки слабеют по мере раскрытия
        ax = ax * (1 - kk) + (ftx[i] - fx[i]) * 0.08 * kk;
        ay = ay * (1 - kk) + (fty[i] - fy[i]) * 0.08 * kk;
        b = Math.max(b * (1 - kk), 0.55 * kk);
      } else if (cursorOn) {
        const dx = fx[i] - mwx, dy = fy[i] - mwy, d2 = dx * dx + dy * dy;
        if (d2 < cr2) {
          // у моды (на стенке и внутри жилы) курсор слабее и уже: раздвигается часть, а не весь объект
          const onMode = qSd < fsc[i] * 2, rr = onMode ? cr * 0.6 : cr;
          const d = Math.sqrt(d2) || 1e-6;
          if (d < rr) {
            const q = 1 - d / rr, p = q * q * (onMode ? 0.45 : 1.6) * iz;
            ax += (dx / d) * p; ay += (dy / d) * p; b = Math.max(b, q * 0.5);
            // над узлом с детьми ободок дыры курсора дышит: здесь есть глубина
            if (portalHover) b = Math.max(b, 4 * q * (1 - q) * (0.45 + 0.3 * Math.sin(T * 2.6)));
          }
        }
      }
      if (waves.length && !cap) {
        for (const w of waves) {
          const dx = fx[i] - w.x, dy = fy[i] - w.y, dw = Math.sqrt(dx * dx + dy * dy) || 1e-6, q = (dw * z - w.r) / (WAVE_W * VK);
          if (q <= -3 || q >= 3) continue;
          const f = w.a * Math.exp(-q * q);
          ax += (dx / dw) * f * 3 * iz; ay += (dy / dw) * f * 3 * iz;
          b = Math.max(b, Math.min(1, 0.9 * f));
        }
      }
      if (far > 0 && !cap) b *= 1 - 0.6 * far;
      if (dk > 0) b = fcap[i] ? Math.max(b, 0.5 * dk) : b * (1 - 0.7 * dk);
      if (hole && !(cap && kk > 0)) {
        const p = voidPush(hole, (fx[i] - cam.x) * z + W / 2, (fy[i] - cam.y) * z + H / 2);
        if (p) { ax += p[0] * iz; ay += p[1] * iz; b = Math.max(b, p[2]); }
      }
      for (let m = 0; m < lit.length; m++) {
        const L = lit[m];
        if (fx[i] >= L.x0 && fx[i] <= L.x1 && fy[i] >= L.y0 && fy[i] <= L.y1 && inPoly(L.poly, fx[i], fy[i])) b = Math.max(b, L.b);
      }
      fvx[i] = fvx[i] * 0.8 + ax; fvy[i] = fvy[i] * 0.8 + ay;
      fx[i] += fvx[i]; fy[i] += fvy[i];
      fb[i] = fb[i] * 0.6 + b * 0.4;
    }
    // мембрана: координаты жилы → мир; куски вне камеры пропускаются
    for (let i = 0; i < NM; i++) {
      const v = veins[mv[i]];
      if (!v || !chunks[mc[i]].vis) { mb[i] = -1; continue; }
      const f = ms[i] / v.step, j = Math.min(v.n - 2, Math.max(0, f | 0)), w = Math.min(1, f - j), j1 = Math.min(v.n - 1, j + 1);
      const R = v.rad[j] + (v.rad[j1] - v.rad[j]) * w;
      const cx = v.x[j] + (v.x[j1] - v.x[j]) * w, cy = v.y[j] + (v.y[j1] - v.y[j]) * w;
      const band = objs[v.obj].$e || 0;
      const off = mu[i] * R * Math.min(0.97, 0.86 + 0.06 * Math.sin(t * 1.7 + mph[i]) + 0.1 * band);
      const jit = v.R * 0.12;
      mx[i] = cx + v.nx[j] * off + Math.sin(t * 1.3 + mph[i] * 3) * jit;
      my[i] = cy + v.ny[j] * off + Math.cos(t * 1.1 + mph[i] * 2) * jit;
      const tactB = 0.5 + 0.5 * Math.sin((ms[i] / (v.R * 10)) * 6.283 - t * 2.4 * v.st.tact + v.ph[3]);
      mb[i] = (0.45 + 0.4 * mu[i] * mu[i] + 0.25 * tactB * tactB) * (1 + 0.8 * excAt(objs[v.obj].$lift || 0, mx[i], my[i])) * (v.st.fill / 0.6) * (1 + 1.6 * band);
    }
  }

  // экранные копии координат узлов и мембраны (рисуется в пикселях экрана)
  let sfx = new Float32Array(0), sfy = new Float32Array(0), smx = new Float32Array(0), smy = new Float32Array(0);
  function project() {
    const z = cam.zoom, ox = W / 2 - cam.x * z, oy = H / 2 - cam.y * z;
    if (sfx.length < NF) { sfx = new Float32Array(NF); sfy = new Float32Array(NF); }
    if (smx.length < NM) { smx = new Float32Array(NM); smy = new Float32Array(NM); }
    for (let i = 0; i < NF; i++) {
      if (!fon[i]) { sfx[i] = -1e9; sfy[i] = -1e9; continue; } // спящий узел не связывается и не рисуется
      sfx[i] = fx[i] * z + ox; sfy[i] = fy[i] * z + oy;
    }
    for (let i = 0; i < NM; i++) {
      if (mb[i] < 0) { smx[i] = -1e9; smy[i] = -1e9; continue; }
      smx[i] = mx[i] * z + ox; smy[i] = my[i] * z + oy;
    }
  }

  function draw() {
    const z = cam.zoom, objs = scene.objects;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#010306';
    ctx.fillRect(0, 0, W, H);
    drawHorizon();
    const vg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(0, 40, 48, 0.35)');
    vg.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    project();

    ctx.globalCompositeOperation = 'lighter';
    // ось жил тонкой линией: по ней читаются мелкие слова; подсвеченный объект ярче
    ctx.lineWidth = 1.2 * VK; // линии — в пикселях экрана, как до виртуального разрешения: тонкие и чёткие
    ctx.lineCap = 'round';
    const ox = W / 2 - cam.x * z, oy = H / 2 - cam.y * z;
    let lastObj = -2;
    for (const ch of chunks) {
      if (!ch.vis) continue;
      const v = veins[ch.v];
      if (v.obj !== lastObj) {
        if (lastObj > -2) ctx.stroke();
        ctx.strokeStyle = `rgba(0, 242, 254, ${((0.16 + 0.12 * (objs[v.obj].$lift || 0) + (v.lod ? 0 : 0.3)) * (1 - 0.85 * diveK)).toFixed(3)})`;
        ctx.beginPath();
        lastObj = v.obj;
      }
      ctx.moveTo(v.x[ch.j0] * z + ox, v.y[ch.j0] * z + oy);
      for (let i = ch.j0 + 1; i <= ch.j1; i++) ctx.lineTo(v.x[i] * z + ox, v.y[i] * z + oy);
    }
    if (lastObj > -2) ctx.stroke();
    linkNodes(sfx, sfy, fb, NF, fieldSp * 1.6 * z, 1, 0.1, fsc, z, fcode);
    flush(0.35);
    if (NM && diveK < 0.97) {
      const R0 = (veins.find((v) => v.lod) || { R: 8 * u }).R * z;
      const L = Math.max(5, R0 * 0.42 * 1.75);
      linkNodes(smx, smy, mb, NM, L, 0.6 * (1 - diveK), 0.2);
      flush(0.3);
    }
    drawThreads();
    // искры: узлы на стенках и в плазме
    ctx.fillStyle = 'rgba(160, 250, 255, 0.85)';
    ctx.beginPath();
    for (let i = 0; i < NF; i++) {
      const b = fb[i];
      if (b < 0.35 - 0.2 * S.sound * snd.high) continue;
      const x = sfx[i], y = sfy[i];
      if (x < -4 || y < -4 || x > W + 4 || y > H + 4) continue;
      const s = (0.6 + b * 1.3 * (0.75 + 0.25 * Math.sin(T * 3 + fph[i] * 5))) * SPARK;
      ctx.rect(x - s / 2, y - s / 2, s, s);
    }
    ctx.fill();
    ctx.fillStyle = 'rgba(220, 255, 255, 0.54)';
    ctx.beginPath();
    for (let i = 0; diveK < 0.6 && i < NM; i += 3) {
      if (mb[i] < 0.05) continue;
      const tw = Math.sin(T * 2.2 + mph[i] * 7);
      if (tw < 0.55) continue;
      const s = (0.8 + tw * 1.6) * SPARK;
      ctx.rect(smx[i] - s / 2, smy[i] - s / 2, s, s);
    }
    ctx.fill();
    if (win) drawWindow();
    if (rama && rama.hole && rama.k > 0) {
      const f = rama, a = Math.min(1, f.k * 1.4);
      ctx.globalCompositeOperation = 'source-over';
      // середина окна пустеет под новую моду; край рисует сама группа узлов области (у рамы без области — тонкий контур)
      ctx.fillStyle = `rgba(1, 3, 6, ${(0.93 * a).toFixed(3)})`;
      ctx.beginPath();
      const rr = (f.round * Math.min(f.w, f.h)) / 2;
      if (f.kind === 'space') ctx.arc(f.x + f.w / 2, f.y + f.h / 2, f.w / 2, 0, Math.PI * 2);
      else if (ctx.roundRect) ctx.roundRect(f.x, f.y, f.w, f.h, rr); else ctx.rect(f.x, f.y, f.w, f.h);
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      if (f.kind === 'space' && f.preview) drawPreview(f);
      if (!f.cap || !f.cap.length) {
        ctx.strokeStyle = `rgba(0, 242, 254, ${(0.35 * a).toFixed(3)})`;
        ctx.lineWidth = VK;
        ctx.stroke();
      }
    }
    // свечение: размытый уменьшенный кадр поверх (дешевле shadowBlur)
    // Размытие без ctx.filter: в Firefox и на части видеокарт blur() считается на процессоре и съедает кадр.
    // Уменьшение в 4 раза, ещё в 2 и обратно — сглаживание растягивает свет в мягкий ореол.
    gctx.globalCompositeOperation = 'copy';
    gctx.drawImage(cv, 0, 0, glowCv.width, glowCv.height);
    // дымка: тот же кадр в четверть разрешения, растянутый обратно, — мягкий слой под чёткими линиями (space.haze)
    if (S.haze > 0.001) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, S.haze * (1 + S.sound * 0.4 * snd.level));
      ctx.drawImage(glowCv, 0, 0, cv.width, cv.height);
      ctx.globalAlpha = 1;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    g2ctx.globalCompositeOperation = 'copy';
    g2ctx.drawImage(glowCv, 0, 0, glow2.width, glow2.height);
    gctx.globalAlpha = 0.6;
    gctx.globalCompositeOperation = 'source-over';
    gctx.drawImage(glow2, 0, 0, glowCv.width, glowCv.height);
    gctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.min(1, S.glow * 0.9 * (1 + S.sound * (0.5 * snd.beat + 0.3 * snd.level)));
    ctx.drawImage(glowCv, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (overlay) { ctx.setTransform(DPR * VK, 0, 0, DPR * VK, 0, 0); overlay(ctx); ctx.setTransform(DPR, 0, 0, DPR, 0, 0); }
    if (flash > 0.003) {
      // вспышка взрыва: свет из середины области, кольцом расходится и гаснет
      const r = Math.max(W, H) * (0.25 + 0.9 * (1 - flash)), g = ctx.createRadialGradient(flashX, flashY, 0, flashX, flashY, r);
      g.addColorStop(0, `rgba(200, 255, 255, ${(0.55 * flash).toFixed(3)})`);
      g.addColorStop(0.35, `rgba(0, 242, 254, ${(0.28 * flash).toFixed(3)})`);
      g.addColorStop(1, 'rgba(0, 242, 254, 0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (fade.veil > 0.001) { ctx.fillStyle = `rgba(1, 3, 6, ${Math.min(1, fade.veil).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
    placeSlots();
  }

  /* ---------------------------------------------------------------------
     МЕСТА: объект сцены с полем slot (player, keeper) — место для живого HTML: плеера и входа хранителя.
     Элемент [data-slot] встаёт в рамку объекта на экране и движется с камерой; объект вне вида или мельче
     SLOT_MIN — элемент прячется. Места в сцене нет — элемент остаётся на своём месте из CSS.
     Пишем в DOM только когда рамка изменилась.
     --------------------------------------------------------------------- */
  const SLOT_MIN = 48;
  let slotKey = '';
  function placeSlots() {
    let key = going ? 'go' : '';
    const seen = {};
    for (const o of scene.objects) {
      if (!o.slot || seen[o.slot]) continue;
      const b = o.bounds();
      if (isEmpty(b)) continue;
      const [x0, y0] = cam.toScreen(b.x0, b.y0, W, H), [x1, y1] = cam.toScreen(b.x1, b.y1, W, H);
      seen[o.slot] = [x0 / VK, y0 / VK, (x1 - x0) / VK, (y1 - y0) / VK].map(Math.round);
      key += o.slot + seen[o.slot].join(',') + ';';
    }
    if (key === slotKey) return;
    slotKey = key;
    for (const el of document.querySelectorAll('[data-slot]')) {
      if (el.dataset.framed) continue; // живёт в раскрытом окне
      const r = seen[el.dataset.slot];
      if (!r) { el.classList.remove('slotted'); el.hidden = false; for (const k of ['left', 'top', 'width', 'height']) el.style[k] = ''; continue; }
      const [x, y, w, h] = r;
      const off = going || w < SLOT_MIN || x + w < 0 || y + h < 0 || x > innerWidth || y > innerHeight;
      el.classList.add('slotted');
      el.hidden = off;
      if (off) continue;
      el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
    }
  }

  /* ---------------------------------------------------------------------
     5. ДВИЖЕНИЕ: пауза при скрытой вкладке, статичный кадр при reduced-motion
     --------------------------------------------------------------------- */
  let raf = 0, lastTs = 0, hoverTick = 0, portalHover = false;
  function frame(ts) {
    raf = 0;
    if (document.hidden || reduce.matches) return;
    // не чаще 60 кадров в секунду: на экранах 120–144 Гц иначе тот же кадр считался бы вдвое-втрое чаще
    if (lastTs && ts - lastTs < 15) { loop(); return; }
    const gap = lastTs ? ts - lastTs : 16.7;
    const dt = lastTs ? Math.min(0.05, gap / 1000) : 0.016;
    lastTs = ts;
    const w0 = performance.now();
    T += dt;
    snd = hearFn ? hearFn(dt) || SILENT : SILENT;
    stepFade(dt);
    flash = flash > 0.003 ? flash * Math.exp(-dt * 3.2) : 0;
    if (tween) stepTween(dt);
    if (rama) stepFrame(dt);
    touchFocus();
    if (++hoverTick % 4 === 0) {
      hoverEntry = mouse.in && tool === 'view' && !rama ? portalAt(mouse.x, mouse.y) : null;
      portalHover = !!(hoverEntry && hoverEntry.inner);
    }
    hear(dt);
    stepWaves();
    updateRadii(dt);
    step();
    draw();
    govern(performance.now() - w0, gap, dt);
    loop();
  }
  function loop() {
    if (!raf && !document.hidden && !reduce.matches) raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastTs = 0;
  }
  /** Неподвижный кадр: поле успокаивается за n шагов без времени, затем один рисунок. */
  function still(n) {
    cull();
    updateRadii(0);
    for (let i = 0; i < n; i++) step();
    draw();
  }
  /** Перерисовать после изменения: в движении — следующий кадр сам, без движения — неподвижный кадр. */
  function refresh(n) {
    if (reduce.matches) still(n || 4);
    else loop();
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : loop()));
  reduce.addEventListener('change', () => {
    if (reduce.matches) { stop(); tween = null; still(60); } else loop();
  });

  /* ---------------------------------------------------------------------
     6. КАМЕРА: колёсико, перетаскивание, два пальца, общий вид
     --------------------------------------------------------------------- */
  const listeners = [];
  /** Рамка, в которой ходит камера: все объекты; в инструментах правки — с запасом в половину сцены. */
  function limitRect() {
    const b = scene.bounds();
    if (isEmpty(b) || tool === 'view') return b;
    const m = Math.max(b.x1 - b.x0, b.y1 - b.y0, 400) * 0.5;
    return expand(b, m);
  }
  function clampCam() { cam.clampTo(limitRect(), W, H, 0.05, ZOOM_MAX); }
  function cameraChanged(n) {
    clampCam();
    ensureView(false);
    for (const f of listeners) f(cam);
    refresh(n || 4);
  }
  function fitTarget(rect) {
    return cam.clone().fit(rect, W, H, 0.05, 0, ZOOM_MAX).clampTo(limitRect(), W, H, 0.05, ZOOM_MAX);
  }
  /** Перелёт камеры к прямоугольнику мира; без движения — сразу. */
  function flyTo(rect) {
    if (isEmpty(rect)) return;
    const to = fitTarget(rect);
    if (reduce.matches) { cam.x = to.x; cam.y = to.y; cam.zoom = to.zoom; cameraChanged(30); return; }
    tween = { from: cam.clone(), to, t: 0 };
    loop();
  }
  function stepTween(dt) {
    tween.t = Math.min(1, tween.t + dt / (tween.dur || 0.45));
    const e = tween.t < 0.5 ? 2 * tween.t * tween.t : 1 - (-2 * tween.t + 2) ** 2 / 2;
    const a = tween.from, b = tween.to;
    const za = Math.log(a.zoom), zb = Math.log(b.zoom);
    cam.zoom = Math.exp(za + (zb - za) * e);
    cam.x = a.x + (b.x - a.x) * e;
    cam.y = a.y + (b.y - a.y) * e;
    const done = tween.t >= 1 ? tween.done : null;
    if (!tween.free) clampCam();
    if (tween.t >= 1) tween = null;
    ensureView(false);
    for (const f of listeners) f(cam);
    if (done) done();
  }
  function fitAll() { userMoved = false; flyTo(scene.bounds()); }

  let tool = 'view';
  let overlay = null;
  let editorInput = null; // обработчики редактора хранителя: down / move / up / dblclick
  const pointers = new Map();
  let gesture = null; // { kind: 'tap' | 'pan' | 'pinch' | 'editor', ... }
  let spaceDown = false;
  const typing = (e) => e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

  let lastPinchPulse = -1;
  // Телефон (без наведения): курсор — центр экрана; палец, который держат на месте, расталкивает под собой.
  const touchy = window.matchMedia('(hover: none)');
  let touchTick = 0;
  function touchFocus() {
    if (!touchy.matches || tool !== 'view') return;
    const held = gesture && gesture.kind === 'tap' && pointers.size === 1;
    if (held) { mouse.x = gesture.x; mouse.y = gesture.y; mouse.in = true; return; }
    mouse.x = W / 2; mouse.y = H / 2; mouse.in = !rama && !going;
    if (++touchTick % 6 === 0 && !win && !rama) highlight(hit(W / 2, H / 2));
  }
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  }

  cv.addEventListener('pointerdown', (e) => {
    if (going) return;
    tween = null;
    try { cv.setPointerCapture(e.pointerId); } catch { /* указатель уже ушёл */ }
    pointers.set(e.pointerId, { x: e.clientX * VK, y: e.clientY * VK });
    if (pointers.size === 2) {
      if (gesture && gesture.kind === 'editor' && editorInput && editorInput.cancel) editorInput.cancel();
      gesture = { kind: 'pinch', ...pinchState() };
      return;
    }
    if (pointers.size > 2) return;
    const panKey = e.button === 1 || spaceDown;
    if (panKey) { e.preventDefault(); gesture = { kind: 'pan', x: e.clientX * VK, y: e.clientY * VK }; cv.classList.add('grab'); return; }
    if (tool !== 'view' && editorInput) { gesture = { kind: 'editor' }; editorInput.down(e); return; }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    gesture = { kind: 'tap', x0: e.clientX * VK, y0: e.clientY * VK, x: e.clientX * VK, y: e.clientY * VK };
  });

  cv.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX * VK; mouse.y = e.clientY * VK; mouse.in = true;
    const p = pointers.get(e.pointerId);
    if (p) { p.x = e.clientX * VK; p.y = e.clientY * VK; }
    if (gesture && gesture.kind === 'pinch' && pointers.size >= 2) {
      const s = pinchState(), z0 = cam.zoom, grow = s.d / gesture.d;
      // щипок при раме — как колёсико: развести пальцы — глубже, свести — обратно
      if (rama && tool === 'view') { frameWheel(Math.log(grow) * -900); gesture = { kind: 'pinch', ...s }; return; }
      cam.zoomAt(s.cx, s.cy, W, H, grow, 0, ZOOM_MAX);
      if (tool === 'view' && !rama && grow > 1.01) {
        clampCam();
        // щипок в пределе — как колёсико в пределе: центр экрана (курсор телефона) над областью — окно, иначе волна
        if (cam.zoom <= z0 * 1.002) {
          const en = portalAt(W / 2, H / 2);
          if (en) openFrame(en, false); // дальше щипок копит напор, как колёсико
          else if (T - lastPinchPulse > 0.6) { lastPinchPulse = T; pulse(W / 2, H / 2, 0.9); }
        }
      }
      cam.panBy(s.cx - gesture.cx, s.cy - gesture.cy);
      gesture = { kind: 'pinch', ...s };
      userMoved = true;
      cameraChanged();
      return;
    }
    if (gesture && gesture.kind === 'tap' && Math.hypot(e.clientX * VK - gesture.x0, e.clientY * VK - gesture.y0) > 5) {
      gesture = { kind: 'pan', x: gesture.x, y: gesture.y };
      cv.classList.add('grab');
      highlight(-1);
    }
    if (gesture && gesture.kind === 'pan') {
      if (rama && rama.dive) return; // в провале камеру ведёт только глубина
      cam.panBy(e.clientX * VK - gesture.x, e.clientY * VK - gesture.y);
      gesture.x = e.clientX * VK; gesture.y = e.clientY * VK;
      userMoved = true;
      cameraChanged();
      return;
    }
    if (gesture && gesture.kind === 'tap') { gesture.x = e.clientX * VK; gesture.y = e.clientY * VK; }
    if (gesture && gesture.kind === 'editor') { editorInput.move(e); return; }
    if (!gesture && tool !== 'view' && editorInput) { editorInput.move(e); return; }
    if (tool !== 'view') return;
    if (win) {
      const l = winTarget(e.clientX * VK, e.clientY * VK);
      win.hover = l && l.href ? l : null;
      cv.classList.toggle('over', !!l);
      return;
    }
    highlight(hit(e.clientX * VK, e.clientY * VK));
  });

  function pointerEnd(e) {
    const had = pointers.delete(e.pointerId);
    if (!had) return;
    const g = gesture;
    if (g && g.kind === 'pinch') {
      if (pointers.size === 1) { const [q] = pointers.values(); gesture = { kind: 'pan', x: q.x, y: q.y }; }
      else if (!pointers.size) gesture = null;
      return;
    }
    if (pointers.size) return;
    gesture = null;
    cv.classList.remove('grab');
    if (g && g.kind === 'editor') { editorInput.up(e); return; }
    if (g && g.kind === 'tap' && e.type === 'pointerup') tap(e.clientX * VK, e.clientY * VK);
  }
  cv.addEventListener('pointerup', pointerEnd);
  cv.addEventListener('pointercancel', pointerEnd);
  cv.addEventListener('pointerleave', () => {
    if (pointers.size) return;
    mouse.in = false; mouse.x = mouse.y = -1e4;
    if (tool === 'view') highlight(-1);
  });

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (going) return; // переход между пространствами не прерывается
    if (T < calmUntil) return; // инерция колёсика после входа в портал не тащит дальше вглубь
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    if (rama && tool === 'view') { frameWheel(e.deltaY * k); return; }
    tween = null;
    // гостю колёсико — масштаб; в инструментах правки — сдвиг, а масштаб — с Ctrl/⌘ (щипок трекпада приходит с Ctrl)
    if (tool === 'view' && depthWheel(e.clientX * VK, e.clientY * VK, e.deltaY * k)) return;
    const z0 = cam.zoom;
    // Внутри алеф-нуля вглубь можно только туда, где есть вход (область окна, страницы, следующего алеф-нуля);
    // над пустым местом приближение стоит, и колёсико бьёт басовой волной.
    if (tool === 'view' && SPACE !== 'main' && e.deltaY < 0 && !portalAt(e.clientX * VK, e.clientY * VK)) {
      const fitZ = cam.clone().fit(scene.bounds(), W, H, 0.05, 0, ZOOM_MAX).zoom;
      if (cam.zoom >= fitZ * 1.15) { wheelPulse(e.clientX * VK, e.clientY * VK, Math.abs(e.deltaY * k)); return; }
    }
    if (tool === 'view' || e.ctrlKey || e.metaKey) {
      cam.zoomAt(e.clientX * VK, e.clientY * VK, W, H, Math.exp(-e.deltaY * k * (e.ctrlKey ? 0.01 : 0.0015)), 0, ZOOM_MAX);
    } else {
      cam.panBy(-e.deltaX * k, -e.deltaY * k);
    }
    userMoved = true;
    cameraChanged();
    // приближать дальше некуда: над областью-входом — объект фиксируется в раму, иначе пространство вздрагивает
    if (tool === 'view' && e.deltaY < 0 && cam.zoom <= z0 * 1.002) {
      // переход играет сам, своей скоростью: колёсико его только запускает (см. stepFrame)
      const en = portalAt(e.clientX * VK, e.clientY * VK);
      if (en) { openFrame(en, false); if (rama) frameWheel(e.deltaY * k); }
      else wheelPulse(e.clientX * VK, e.clientY * VK, Math.abs(e.deltaY * k)); // упор в пределе над пустым местом — басовая волна по сети
    }
  }, { passive: false });

  cv.addEventListener('dblclick', (e) => {
    if (tool !== 'view') { if (editorInput && editorInput.dblclick) editorInput.dblclick(e); return; }
    if (!win && hit(e.clientX * VK, e.clientY * VK) < 0) fitAll();
  });

  window.addEventListener('keydown', (e) => {
    if (typing(e)) return;
    if (e.key === 'Escape' && rama) frameBack();
    else if (e.key === 'Escape' && win) closeWindow();
    else if (e.key === 'Escape' && tool === 'view' && SPACE !== 'main') goOut();
    if (e.code === 'Space' && !spaceDown) { spaceDown = true; cv.classList.add('grab-ready'); if (tool !== 'view') e.preventDefault(); }
    if ((e.code === 'Digit1' && e.shiftKey) || e.key === 'Home') { e.preventDefault(); fitAll(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; cv.classList.remove('grab-ready'); }
  });
  window.addEventListener('blur', () => { spaceDown = false; cv.classList.remove('grab-ready'); });

  // Кнопка «вся сцена»: четыре уголка рамки, без шрифта
  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'home';
  home.title = 'Вся сцена (двойной клик по пустому месту)';
  home.setAttribute('aria-label', 'Вся сцена');
  const SVG = 'http://www.w3.org/2000/svg'; // пространство имён SVG, не адрес загрузки
  const icon = document.createElementNS(SVG, 'svg');
  icon.setAttribute('viewBox', '0 0 20 20');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4');
  icon.append(path);
  home.append(icon);
  home.addEventListener('click', fitAll);
  document.body.append(home);

  /* ---------------------------------------------------------------------
     7. ПОПАДАНИЕ, КЛИК, КЛАВИАТУРА
     --------------------------------------------------------------------- */
  /** Объект под точкой экрана: ближе порога к его жилам или внутри его области (верхний слой первым). */
  function hit(sx, sy) {
    const [wx, wy] = cam.toWorld(sx, sy, W, H);
    queryVoid(wx, wy);
    if (qV >= 0 && !veins[qV].live && qSd < Math.max(12, fieldPx) / cam.zoom) return veins[qV].obj;
    const order = scene.layers();
    for (let k = order.length - 1; k >= 0; k--) {
      const o = scene.objects[order[k]];
      if (o.area && o.area.length >= 3 && inPoly(o.area, wx, wy)) return order[k];
      if (o.doors && o.doors.some((d) => d && d.area && d.area.length >= 3 && inPoly(d.area, wx, wy))) return order[k];
    }
    return -1;
  }

  /** Объект открывает окно, если оно у него есть, иначе — свою ссылку. */
  function activate(i) {
    const o = scene.objects[i];
    if (!o) return;
    // окно открывает только приближение в область; клик по такому объекту подлетает к области
    if (kindOf(o)) flyTo(expand(areaBounds(o), 0));
    else if (o.href) location.href = new URL(o.href, location.origin).href;
  }
  function tap(x, y) {
    if (rama) { if (x < rama.x || y < rama.y || x > rama.x + rama.w || y > rama.y + rama.h) frameBack(); return; }
    if (win) {
      const l = winTarget(x, y);
      if (l && l.href) { closeWindow(); openLink(l.href); }
      else if (!l || l.close) closeWindow(); // клик мимо окна или по крестику закрывает его
      return;
    }
    const i = hit(x, y);
    if (i < 0) {
      const t = threadAt(x, y);
      if (t) { goOut(false, undefined, t.id); return; }
      if (onHorizon(x, y) && ups.length) { goOut(); return; }
    }
    activate(i);
  }

  function highlight(i) {
    if (hl === i) return;
    hl = i;
    cv.classList.toggle('over', i >= 0 && tool === 'view');
    refresh();
  }

  // Tab идёт по настоящим ссылкам <nav>: фокус подсвечивает объект (камера подлетает, если он не виден), Enter открывает.
  function bindNav() {
    const links = [...document.querySelectorAll('nav.objects a[data-id]')];
    for (const o of scene.objects) o.$link = links.find((a) => a.dataset.id === o.id) || null;
    for (const a of links) {
      if (a.dataset.bound) continue;
      a.dataset.bound = '1';
      const idx = () => scene.objects.findIndex((o) => o.id === a.dataset.id);
      a.addEventListener('focus', () => {
        const i = idx();
        if (i < 0) return;
        const b = scene.objects[i].bounds();
        if (!isEmpty(b) && !intersects(b, cam.view(W, H))) flyTo(b);
        highlight(i);
      });
      a.addEventListener('blur', () => highlight(-1));
      a.addEventListener('click', (e) => {
        const o = scene.objects[idx()];
        if (o && o.inner) { e.preventDefault(); goIn(idx()); }
        else if (o && kindOf(o)) { e.preventDefault(); openFrame(idx(), true); } // с клавиатуры и для чтецов — сразу
        else if (o && o.href && ownPath(o.href)) { e.preventDefault(); openFrame(idx(), true); }
      });
    }
  }

  /* ---------------------------------------------------------------------
     АЛЕФ-НУЛИ: объект с полем inner — вход в своё пространство (/in/{inner}, своя сцена). Колёсико к объекту
     раздувает его до экрана и переводит внутрь; внутри видна оболочка (снимок раздутого объекта). Колёсико наружу
     у края пространства, Esc и «назад» браузера возвращают к объекту. Туда, где входа нет, колёсико упирается —
     пространство вздрагивает. Адрес меняется через history: ссылку на пространство можно отправить.
     --------------------------------------------------------------------- */
  let SPACE = cv.dataset.space || 'main';
  let parentSpace = cv.dataset.parent || (SPACE === 'main' ? null : 'main');
  let fromId = cv.dataset.from || null;
  let going = null, pull = 0;
  const fade = { veil: 0, veilTo: 0 };
  const sceneUrl = (sp) => (sp === 'main' ? '/vitrina/scene.json' : `/vitrina/scene/${sp}.json`);
  const spaceUrl = (sp) => (sp === 'main' ? '/' : `/in/${sp}`);
  // Пространства без опубликованной сцены нет (404): гость упирается, хранитель входит в пустое, чтобы нарисовать.
  const loadScene = (sp) => fetch(sceneUrl(sp), { credentials: 'same-origin' }).then((r) => {
    if (r.status === 404 && keeper) return { v: 2, objects: [] };
    if (!r.ok) throw new Error('scene ' + r.status);
    return r.json();
  });

  function stepFade(dt) {
    fade.veil += (fade.veilTo - fade.veil) * Math.min(1, dt * 9);
  }

  /** Камера, при которой прямоугольник мира заполняет экран с запасом over (больше 1 — раздут за края). */
  function inflated(rect, over) {
    const c = cam.clone().fit(rect, W, H, 0, 0, Infinity);
    c.zoom *= over;
    return c;
  }
  /** Объект-вход под точкой экрана: по жилам и областям, иначе — самый маленький вход, в чьей рамке точка. */
  /** Вход под точкой экрана: объект, в чью область (многоугольник узлов) смотрит курсор; из нескольких — меньший. */
  function portalAt(sx, sy) {
    const [wx, wy] = cam.toWorld(sx, sy, W, H);
    let best = null, area = Infinity;
    for (const o of entriesOf(scene)) {
      if (!kindOf(o) || !inPoly(o.area, wx, wy)) continue;
      const b = areaBounds(o), a = (b.x1 - b.x0) * (b.y1 - b.y0);
      if (a < area) { best = o; area = a; }
    }
    return best;
  }

  /** Колёсико гостя: вглубь — во вход, если он под курсором и уже крупный; в упор — дрожь; наружу у края — выход. */
  function depthWheel(sx, sy, dy) {
    if (going) return true;
    if (dy < 0) {
      pull = 0;
      // мода фиксируется окном только в конце приближения (предел масштаба) — это ловит колёсико ниже
      return false;
    }
    if (dy > 0 && SPACE !== 'main') {
      const fitZ = cam.clone().fit(scene.bounds(), W, H, 0.05, 0, ZOOM_MAX).zoom;
      if (isEmpty(scene.bounds()) || cam.zoom <= fitZ * 1.02) {
        pull += dy;
        if (pull > 240) { pull = 0; goOut(); }
        return true;
      }
    }
    pull = 0;
    return false;
  }

  /** Списки ссылок <nav> — по сцене пространства (на странице после перехода без перезагрузки). */
  function rebuildNav() {
    const ul = document.querySelector('nav.objects ul');
    if (!ul) return;
    ul.textContent = '';
    const el = (tag, text) => { const e = document.createElement(tag); if (text) e.textContent = text; return e; };
    if (SPACE !== 'main') {
      const li = el('li'), a = el('a', 'Наружу');
      a.href = spaceUrl(parentSpace || 'main');
      a.dataset.back = '1';
      li.append(a);
      ul.append(li);
    }
    // та же разметка, что у сервера (sceneNav): ссылка объекта и текст его окна
    for (const o of scene.objects) {
      const li = el('li'), a = el('a', o.label);
      li.id = 'w-' + o.id;
      a.dataset.id = o.id;
      a.href = o.inner ? spaceUrl(o.inner) : o.href || '#w-' + o.id;
      li.append(a);
      const w = o.window;
      if (w) {
        if (w.title) li.append(el('h2', w.title));
        if (w.text) li.append(el('p', w.text));
        if (w.links && w.links.length) {
          const sub = el('ul');
          for (const l of w.links) { const x = el('a', l.label); x.href = l.href; const i = el('li'); i.append(x); sub.append(i); }
          li.append(sub);
        }
      }
      if (o.doors && o.doors.length) {
        const sub = el('ul');
        for (const d of o.doors) {
          const i = el('li'), label = d.label || (d.window && d.window.title) || o.label, h = d.inner ? spaceUrl(d.inner) : d.href;
          if (h) { const x = el('a', label); x.href = h; i.append(x); } else i.append(label);
          if (d.window && d.window.text) i.append(el('p', d.window.text));
          sub.append(i);
        }
        li.append(sub);
      }
      ul.append(li);
    }
    bindBack();
  }

  function bindBack() {
    const a = document.querySelector('nav.objects a[data-back]');
    if (a && !a.dataset.bound) {
      a.dataset.bound = '1';
      a.addEventListener('click', (e) => { e.preventDefault(); goOut(); });
    }
  }

  /** Сменить сцену пространства на месте: камера, поле, ссылки, редактор (событие vitrina:space). */
  function swapScene(json, sp, parent, from) {
    scene = Scene.from(json);
    SPACE = sp; parentSpace = parent; fromId = from;
    cv.dataset.space = sp;
    hl = -1; win = null;
    readSpace();
    rebuildNav();
    bindNav();
    userMoved = false;
    fx = null;
    document.dispatchEvent(new CustomEvent('vitrina:space', { detail: { space: sp, parent } }));
  }

  function snapshot() {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W)); c.height = Math.max(1, Math.round(H));
    c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height);
    return c;
  }


  /* ---------------------------------------------------------------------
     ПОРТАЛ: отталкивание курсора, продолженное в глубину (замысел хранителя 18.10).
     Колёсико в пределе над узлом с детьми (inner) раскрывает дыру: её радиус растёт с p = rama.k; частицы области
     не исчезают — уходят на ободок (рама с round = 1). Внутри дыры — дочерняя сцена, нарисованная заранее вне экрана:
     сначала мелкая и далёкая, к p = 1 — ровно такой, какой она откроется. При p = 1 — смена уровня: новые узлы
     стартуют с ободка и разлетаются к своим местам. До p = 1 всё обратимо колёсиком назад.
     Над родителем остаётся горизонт — кольцо по краю экрана с его кадром (до двух уровней, каждый тусклее);
     связи узла (links с весом) проходят сквозь горизонт нитями к портам на краю дочернего континуума.
     --------------------------------------------------------------------- */
  let calmUntil = 0, morphUntil = 0;
  const ups = []; // уровни выше: { img — горизонт, threads — нити этого входа, from — id узла-входа }
  let threads = [];
  function portalTarget() {
    const R = Math.hypot(W, H) / 2 + 8;
    return { x: W / 2 - R, y: H / 2 - R, w: 2 * R, h: 2 * R };
  }
  function openPortal(f) {
    f.round = 1;
    f.far = Math.max(f.far, 0.6);
    const s = Math.max(f.from.w, f.from.h), cx = f.from.x + f.from.w / 2, cy = f.from.y + f.from.h / 2;
    f.from = { x: cx - s / 2, y: cy - s / 2, w: s, h: s };
    f.snap = snapshot();
    loadScene(f.o.inner).then((j) => { f.child = j; f.preview = renderPreview(j); }).catch(() => { f.childFail = true; });
  }
  /** Дочерняя сцена вне экрана: жилы мягким светом поверх, в той же раскладке, что даст камера при входе. */
  function renderPreview(json) {
    const sc = Scene.from(json), c = document.createElement('canvas');
    const s = 0.5; // половина разрешения: картинка в дыре растёт и всё равно мягкая
    c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
    const g = c.getContext('2d'), b = sc.bounds();
    if (isEmpty(b)) return c;
    const cm = new Camera().fit(b, W, H, 0.05, 0, ZOOM_MAX);
    g.setTransform(s, 0, 0, s, 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const pass of [[2.2, 0.06], [1, 0.22], [0.25, 0.7]]) {
      for (const o of sc.objects) {
        const th = o.get('thick');
        for (const st of o.strokes) {
          if (!st.pts.length) continue;
          g.lineWidth = Math.max(0.6, st.r * th * 2 * cm.zoom * pass[0]);
          g.strokeStyle = `rgba(0, 242, 254, ${pass[1]})`;
          g.beginPath();
          st.pts.forEach((p, i) => { const [x, y] = cm.toScreen(p[0], p[1], W, H); i ? g.lineTo(x, y) : g.moveTo(x, y); });
          if (st.closed) g.closePath();
          g.stroke();
        }
      }
    }
    return c;
  }
  function drawPreview(f) {
    const e = ease(Math.min(1, f.k)), cx = f.x + f.w / 2, cy = f.y + f.h / 2, r = f.w / 2;
    const sc = 0.14 + 0.86 * e * e; // сначала мелко и далеко, к p = 1 — во весь экран
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = Math.min(1, f.k * 1.5);
    ctx.drawImage(f.preview, cx - (W * sc) / 2, cy - (H * sc) / 2, W * sc, H * sc);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  /** Горизонт: кадр уровня выше, видимый только кольцом по краю (середина прозрачна). */
  function makeHorizon(snap) {
    const c = document.createElement('canvas');
    c.width = snap.width; c.height = snap.height;
    const g = c.getContext('2d');
    g.drawImage(snap, 0, 0);
    const R = Math.hypot(c.width, c.height) / 2, gr = g.createRadialGradient(c.width / 2, c.height / 2, R * 0.5, c.width / 2, c.height / 2, R);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(0.55, 'rgba(0,0,0,0.35)');
    gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = gr;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }
  function drawHorizon() {
    if (!ups.length || S.horizon < 0.01) return;
    // уровень выше живёт: медленно дышит и поворачивается, отвечает музыке; следующий — дальше и тусклее
    for (let l = Math.min(2, ups.length) - 1; l >= 0; l--) {
      const img = ups[l].img;
      if (!img) continue;
      const k = 1.04 + 0.08 * l + 0.012 * Math.sin(T * 0.5 + l) + 0.02 * S.sound * snd.low;
      const a = S.horizon * (l ? 0.22 : 0.5) * (0.85 + 0.15 * Math.sin(T * 0.8 + l * 2)) * (1 + 0.4 * S.sound * snd.level);
      ctx.save();
      ctx.globalAlpha = Math.min(1, a);
      ctx.translate(W / 2, H / 2);
      ctx.rotate(0.01 * Math.sin(T * 0.13 + l));
      ctx.drawImage(img, (-W * k) / 2, (-H * k) / 2, W * k, H * k);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  /** Нити входа: связи узла на уровне выше (links: { to, w }), направление — от узла к тому, с кем связь. */
  function threadsOf(o, parent) {
    const out = [];
    const b = o.bounds(), ox = (b.x0 + b.x1) / 2, oy = (b.y0 + b.y1) / 2;
    for (const l of (o.links || []).slice().sort((p, q) => (q.w || 0) - (p.w || 0)).slice(0, 10)) {
      const t = parent.objects.find((x) => x.id === l.to);
      if (!t) continue;
      const tb = t.bounds();
      if (isEmpty(tb)) continue;
      out.push({ id: t.id, label: t.label, w: Math.max(0, Math.min(1, l.w ?? 0.5)), ang: Math.atan2((tb.y0 + tb.y1) / 2 - oy, (tb.x0 + tb.x1) / 2 - ox) });
    }
    return out;
  }
  /** Точка на краю прямоугольника (x0, y0, x1, y1) по лучу из его середины под углом a. */
  function rayRect(x0, y0, x1, y1, a) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, c = Math.cos(a), s = Math.sin(a);
    const t = Math.min(Math.abs(c) > 1e-6 ? (x1 - cx) / Math.abs(c) : Infinity, Math.abs(s) > 1e-6 ? (y1 - cy) / Math.abs(s) : Infinity);
    return [cx + c * t, cy + s * t];
  }
  function threadPath(t, i) {
    const b = scene.bounds();
    const [bx0, by0] = cam.toScreen(b.x0, b.y0, W, H), [bx1, by1] = cam.toScreen(b.x1, b.y1, W, H);
    const [px, py] = isEmpty(b) ? [W / 2, H / 2] : rayRect(bx0, by0, bx1, by1, t.ang); // порт на краю дочернего континуума
    const [ex, ey] = rayRect(-20, -20, W + 20, H + 20, t.ang); // за горизонтом
    const sway = Math.sin(T * 0.6 + i * 1.7) * 26 * VK + 6 * VK * S.sound * snd.low;
    const mx = (px + ex) / 2 - Math.sin(t.ang) * sway, my = (py + ey) / 2 + Math.cos(t.ang) * sway;
    return [px, py, mx, my, ex, ey];
  }
  function drawThreads() {
    if (!threads.length || SPACE === 'main') return;
    ctx.globalCompositeOperation = 'lighter';
    threads.forEach((t, i) => {
      const [px, py, mx, my, ex, ey] = threadPath(t, i);
      for (const [wk, al] of [[3.2, 0.08], [1, 0.32 + 0.4 * t.w]]) {
        ctx.strokeStyle = `rgba(0, 242, 254, ${(al * (t.hot ? 1.6 : 1)).toFixed(3)})`;
        ctx.lineWidth = (1.2 + 5 * t.w) * wk * VK;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.quadraticCurveTo(mx, my, ex, ey);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(200, 255, 255, 0.8)';
      ctx.beginPath();
      ctx.arc(px, py, (2 + 3 * t.w) * VK, 0, Math.PI * 2); // порт
      ctx.fill();
    });
  }
  /** Нить под точкой экрана (для клика): ближе 10 пикселей к кривой. */
  function threadAt(x, y) {
    if (!threads.length || SPACE === 'main') return null;
    let best = null, bd = 10 * VK;
    threads.forEach((t, i) => {
      const [px, py, mx, my, ex, ey] = threadPath(t, i);
      for (let k = 0; k <= 24; k++) {
        const s = k / 24, u = 1 - s, qx = u * u * px + 2 * u * s * mx + s * s * ex, qy = u * u * py + 2 * u * s * my + s * s * ey;
        const d = Math.hypot(qx - x, qy - y);
        if (d < bd) { bd = d; best = t; }
      }
    });
    return best;
  }
  /** Клик по горизонту — полоса у края экрана, где нет объекта. */
  const onHorizon = (x, y) => SPACE !== 'main' && Math.min(x, y, W - x, H - y) < Math.min(W, H) * 0.05;

  /** p = 1: смена уровня. Частицы ободка становятся узлами дочернего мира и разлетаются к своим местам. */
  function portalEnter(f) {
    const o = f.o, target = o.inner, from = SPACE, z = cam.zoom, ox = W / 2 - cam.x * z, oy = H / 2 - cam.y * z;
    const ring = [];
    if (f.cap) for (let j = 0; j < f.cap.length; j++) { const i = f.cap[j]; ring.push([fx[i] * z + ox, fy[i] * z + oy]); }
    const level = { img: S.horizon > 0.01 && f.snap ? makeHorizon(f.snap) : null, threads: threadsOf(o, scene), from: o.id, cam: cam.clone() };
    giveBack();
    rama = null;
    if (pageEl) { pageEl.hidden = true; pageEl.classList.remove('live'); }
    history.pushState({ space: target }, '', spaceUrl(target));
    swapScene(f.child, target, from, o.id);
    ups.unshift(level);
    if (ups.length > 4) ups.length = 4;
    threads = level.threads;
    calmUntil = T + 0.7;
    morphUntil = T + 2.5;
    resize();
    if (reduce.matches || !ring.length) { fade.veil = 1; fade.veilTo = 0; refresh(30); return; }
    // морф: каждый новый узел стартует с точки ободка в своём направлении от середины экрана
    const BINS = 72, bins = Array.from({ length: BINS }, () => []);
    for (const p of ring) bins[Math.min(BINS - 1, (((Math.atan2(p[1] - H / 2, p[0] - W / 2) + Math.PI) / (2 * Math.PI)) * BINS) | 0)].push(p);
    const z2 = cam.zoom, ox2 = W / 2 - cam.x * z2, oy2 = H / 2 - cam.y * z2;
    for (let i = 0; i < NF; i++) {
      const sx = fx[i] * z2 + ox2, sy = fy[i] * z2 + oy2;
      let b = Math.min(BINS - 1, (((Math.atan2(sy - H / 2, sx - W / 2) + Math.PI) / (2 * Math.PI)) * BINS) | 0), list = bins[b];
      for (let s = 1; !list.length && s < BINS / 2; s++) list = bins[(b + s) % BINS].length ? bins[(b + s) % BINS] : bins[(b - s + BINS) % BINS];
      if (!list.length) break;
      const p = list[(i * 7919) % list.length];
      fx[i] = (p[0] - ox2) / z2; fy[i] = (p[1] - oy2) / z2;
      fvx[i] = fvy[i] = 0;
    }
    loop();
  }

  /** Войти в алеф-нуль объекта i: раздуть объект до экрана, затемнить, сменить сцену, проявить её изнутри. */
  function goIn(i, fromHistory) {
    const o = entryOf(i);
    if (!o || !o.inner || going) return;
    const target = o.inner, from = SPACE, id = o.id;
    if (win) closeWindow();
    highlight(-1);
    const json = loadScene(target).catch(() => null);
    going = { dir: 'in' };
    const quick = reduce.matches, before = cam.clone();
    let next = null;
    const finish = (j) => {
      // пространство не открылось (нет сцены): назад к прежнему виду, пространство вздрагивает
      if (!j) {
        fade.veilTo = 0; pulse(W / 2, H / 2, 1);
        if (quick) going = null;
        else tween = { from: cam.clone(), to: before, t: 0, dur: 0.4, free: true, done: () => { going = null; } };
        loop();
        return;
      }
      if (!fromHistory) history.pushState({ space: target }, '', spaceUrl(target));
      const level = { img: S.horizon > 0.01 && next ? makeHorizon(next) : null, threads: threadsOf(o, scene), from: id, cam: before };
      swapScene(j, target, from, id);
      ups.unshift(level);
      if (ups.length > 4) ups.length = 4;
      threads = level.threads;
      resize();
      const to = cam.clone();
      const start = to.clone(); start.zoom *= 0.55;
      cam.x = start.x; cam.y = start.y; cam.zoom = start.zoom;
      fade.veil = 1; fade.veilTo = 0;
      if (quick) { cam.zoom = to.zoom; going = null; still(60); return; }
      tween = { from: start, to, t: 0, dur: 0.6, free: true, done: () => { going = null; } };
      loop();
    };
    if (quick) { json.then(finish); return; }
    tween = {
      from: cam.clone(), to: inflated(o.bounds(), 1.5), t: 0, dur: 0.55, free: true,
      done: () => { next = snapshot(); fade.veilTo = 1; setTimeout(() => json.then(finish), 160); },
    };
    loop();
  }

  /** Наружу: сцена родителя, камера — внутри объекта-входа, затем отлёт туда, откуда вошли (точка и масштаб экрана). */
  function goOut(fromHistory, toSpace, flyId) {
    if (going || SPACE === 'main') return;
    const target = toSpace || parentSpace || 'main', was = SPACE;
    if (win) closeWindow();
    going = { dir: 'out' };
    fade.veilTo = 1;
    const quick = reduce.matches;
    if (!quick) { tween = { from: cam.clone(), to: Object.assign(cam.clone(), { zoom: cam.zoom * 0.6 }), t: 0, dur: 0.35, free: true }; loop(); }
    loadScene(target).catch(() => null).then((j) => {
      if (!j) { going = null; fade.veilTo = 0; return; }
      if (!fromHistory) history.pushState({ space: target }, '', spaceUrl(target));
      const sc = Scene.from(j), back = entriesOf(sc).find((o) => o.inner === was) || sc.objects.find((o) => o.inner === was);
      const came = ups[0] && back && ups[0].from === back.id ? ups[0].cam : null;
      // родитель родителя неизвестен без сервера: страница пространства отдаёт его в data-parent при прямом заходе
      swapScene(j, target, target === 'main' ? null : 'main', null);
      ups.shift();
      threads = ups.length ? ups[0].threads : [];
      resize();
      if (came) userMoved = true;
      // нить вела к соседу узла: после выхода — полёт к нему
      const fly = flyId && scene.objects.find((o) => o.id === flyId);
      const all = fly && !isEmpty(fly.bounds()) ? fitTarget(expand(fly.bounds(), Math.max(fly.bounds().x1 - fly.bounds().x0, 60) * 0.6)) : came ? came.clone() : cam.clone();
      calmUntil = T + 0.8; // инерция колёсика наружу не уносит дальше той точки
      if (back && !quick) {
        const start = inflated(back.bounds(), 1.5);
        cam.x = start.x; cam.y = start.y; cam.zoom = start.zoom;
        fade.veil = 1; fade.veilTo = 0;
        tween = { from: start, to: all, t: 0, dur: 0.7, free: true, done: () => { going = null; clampCam(); } };
        loop();
      } else { cam.x = all.x; cam.y = all.y; cam.zoom = all.zoom; clampCam(); ensureView(false); fade.veil = 0; fade.veilTo = 0; going = null; refresh(30); }
    });
  }

  window.addEventListener('popstate', (e) => {
    const st = e.state || {};
    if (framePop(st)) return;
    const m = /^\/in\/([a-z0-9-]{1,32})\/?$/.exec(location.pathname);
    const target = m ? m[1] : 'main';
    if (target === SPACE) return;
    const en = entriesOf(scene).find((o) => o.inner === target) || scene.objects.find((o) => o.inner === target);
    if (en) goIn(en, true);
    else goOut(true, target);
  });

  /* ---------------------------------------------------------------------
     РАМА: вход в объект. Колёсико приближает объект; в пределе масштаба над его областью начинается провал:
     дальше колёсико ведёт камеру внутрь области (p = rama.k), новые узлы не появляются — узлы самой области
     растягиваются на весь экран и становятся основой нового континуума, остальное уходит за края. В конце провала
     поверх живого поля встаёт текст на весь экран: окно объекта, страница сети (тот же markdown, что у моделей)
     со ссылками глубже или виджет. Колёсико назад поднимает обратно — ровно в ту точку и масштаб, откуда упали;
     так же — Esc, «Наружу», «назад» браузера.
     Объект-вход (inner) раскрывается порталом (ниже) и в конце переводит в своё пространство.
     Адрес страницы — настоящий (history): перезагрузка или ссылка дают ту же страницу обычным HTML.
     --------------------------------------------------------------------- */
  const ownPath = (href) => {
    try { const u = new URL(href, location.origin); return u.origin === location.origin && !/^\/(k|in)(\/|$)/.test(u.pathname) ? u.pathname : null; }
    catch { return null; }
  };
  let rama = null; // { o, kind: page|window|widget|space, path, from, k, want, x, y, w, h, pushed, dive, base }
  // во сколько раз камера уходит вглубь области при провале: до пустого континуума — соседние узлы поля
  // расходятся на DIVE_EMPTY меньшей стороны экрана, между ними пустота (там потом и рисовать)
  const DIVE_MIN = 2.2, DIVE_MAX = 80;
  // Переход играет сам — взрывом, одной скоростью: колёсико (щипок) только копит напор в пределе над областью.
  // Напор затухает: медленная прокрутка его не набирает, сильная — набирает; за порогом окна (frame.push) — взрыв.
  // До порога область натягивается (камера чуть отходит, узлы области светятся); отпустили — напор стекает, всё как было.
  const BURST_IN = 1.25, BURST_OUT = 0.8, BOOM_AT = 0.2, PRESS_DECAY = 2.2;
  let flash = 0, flashX = 0, flashY = 0; // вспышка взрыва: мягкий свет из точки, гаснет сам
  let diveK = 0; // насколько глубоко провал (0…1): жилы и плазма тают, остаются растянутые узлы
  const pages = []; // стопка страниц внутри рамы
  let pageEl = null, pageBody = null, pageBack = null, pageReq = 0;
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);

  function pageBox() {
    if (pageEl) return;
    pageEl = document.createElement('article');
    pageEl.className = 'page-space';
    pageEl.hidden = true;
    pageEl.setAttribute('aria-live', 'polite');
    const bar = document.createElement('div');
    bar.className = 'page-bar';
    pageBack = document.createElement('button');
    pageBack.type = 'button';
    pageBack.textContent = '← Наружу';
    pageBack.addEventListener('click', () => frameBack());
    bar.append(pageBack);
    pageBody = document.createElement('div');
    pageBody.className = 'page-body';
    pageEl.append(bar, pageBody);
    // колёсико над блоками: текст прокручивается, пока есть куда; дальше «назад» сводит раму
    // докрутили текст до конца и давят дальше — тот же напор, что на входе: за порогом окно схлопывается
    let over = 0, overT = 0;
    pageEl.addEventListener('wheel', (e) => {
      if (!rama || e.deltaY <= 0) return;
      if (pageEl.scrollTop + pageEl.clientHeight < pageEl.scrollHeight - 2) { over = 0; return; }
      e.preventDefault();
      const now = performance.now();
      over = over * Math.exp(-(now - overT) / 450) + e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      overT = now;
      if (over > 420) { over = 0; frameWheel(1); }
    }, { passive: false });
    pageEl.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const path = ownPath(a.getAttribute('href'));
      if (path) { e.preventDefault(); deeper(path); }
    });
    document.body.append(pageEl);
  }

  /** Прямоугольник раскрытой рамы: по центру экрана; ширина и пропорция — из параметров рамы объекта. */
  function frameTarget(o) {
    const fg = (k) => (o && o.frameGet ? o.frameGet(k) : M.FRAME_DEFAULTS[k]);
    const m = 16 * VK, w = Math.min(W - 2 * m, fg('width') * VK), asp = fg('aspect');
    const h = asp > 0 ? Math.min(H - 2 * m, w * asp) : Math.min(H - 2 * m, Math.max(H * 0.82, 320 * VK));
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }
  function frameParams(o) {
    const fg = (k) => (o && o.frameGet ? o.frameGet(k) : M.FRAME_DEFAULTS[k]);
    return { round: fg('round'), ring: fg('ring'), far: fg('far') };
  }
  function objRect(o) {
    const b = areaBounds(o);
    const [x0, y0] = cam.toScreen(b.x0, b.y0, W, H), [x1, y1] = cam.toScreen(b.x1, b.y1, W, H);
    const x = Math.max(0, x0), y = Math.max(0, y0);
    return { x, y, w: Math.max(8, Math.min(W, x1) - x), h: Math.max(8, Math.min(H, y1) - y) };
  }
  /*
   * Входы сцены: объект с областью и каждая его область-вход (doors) — у области своё содержимое, а жилы, такт и связи
   * — объекта. Вход области — лёгкая обёртка с тем же видом, что у объекта (area, href, inner, widget, window, frameGet).
   */
  const doorCache = new WeakMap();
  function doorOf(o, k) {
    const d = o.doors[k];
    let m = doorCache.get(d);
    if (!m) {
      m = {
        id: `${o.id}.${k + 1}`, parent: o, door: d,
        get label() { return d.label || (d.window && d.window.title) || o.label; },
        get area() { return d.area; }, get href() { return d.href; }, get inner() { return d.inner; },
        get widget() { return d.widget; }, get window() { return d.window; }, get links() { return o.links; },
        frameGet: (key) => (d.frame && typeof d.frame[key] === 'number' ? d.frame[key] : M.FRAME_DEFAULTS[key]),
        bounds: () => { const b = areaBounds(m); return b.x1 >= b.x0 ? b : { ...M.EMPTY }; },
        get: (key) => o.get(key),
      };
      doorCache.set(d, m);
    }
    return m;
  }
  function entriesOf(sc) {
    const out = [];
    for (const o of sc.objects) {
      if (o.area && o.area.length >= 3) out.push(o);
      if (o.doors) o.doors.forEach((d, k) => { if (d && d.area && d.area.length >= 3) out.push(doorOf(o, k)); });
    }
    return out;
  }
  const entryOf = (i) => (typeof i === 'number' ? scene.objects[i] : i);
  // Входом служит только объект с областью: окно открывается приближением в неё, иначе — никак.
  const kindOf = (o) => (!o.area || o.area.length < 3 ? null : o.inner ? 'space' : widgetOk(o.widget) ? 'widget' : o.window ? 'window' : o.href && ownPath(o.href) ? 'page' : null);
  /** Виджет доступен: разделы панели — только хранителю в сессии, плеер и вход — если их элемент есть на странице. */
  function widgetOk(w) {
    if (!w) return false;
    if (M.KEEPER_WIDGETS[w]) return keeper;
    return !!document.querySelector(`[data-slot="${w}"]`);
  }
  // Живой элемент (плеер, вход хранителя) на время окна переезжает в него, потом — на своё место.
  let lent = null; // { el, mark }
  function giveBack() {
    if (!lent) return;
    lent.mark.replaceWith(lent.el);
    delete lent.el.dataset.framed;
    lent = null;
    slotKey = '';
  }
  function areaBounds(o) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of o.area) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x0, y0, x1, y1 };
  }

  /** Начать раму у объекта i. auto — раскрыть до конца само (клик); иначе раскрытие ведёт колёсико. */
  function openFrame(i, auto) {
    const o = entryOf(i), kind = o && kindOf(o);
    if (!kind || going) return;
    if (win) closeWindow();
    highlight(-1);
    tween = null;
    rama = { o, kind, path: kind === 'page' ? ownPath(o.href) : null, from: objRect(o), k: 0, want: auto ? 1 : null, pushed: false, gen: -1, ...frameParams(o) };
    if (kind === 'space') openPortal(rama);
    else { rama.dive = true; rama.base = cam.clone(); }
    // auto (клик, клавиатура, редактор, щипок) — взрыв сразу; иначе колёсико копит напор до порога
    if (auto) burst(rama);
    else { rama.charge = true; rama.v = 0; rama.q = 0; rama.idle = 0; }
    placeFrame();
    if (kind !== 'space') loadFrame();
    loop();
  }
  /** Рама без объекта (вперёд по истории, прямой переход): из точки в центре. */
  function openFramePath(path) {
    const t = frameTarget(null);
    rama = { o: null, kind: 'page', path, from: { x: t.x + t.w / 2 - 4, y: t.y + t.h / 2 - 4, w: 8, h: 8 }, k: 0, want: 1, pushed: true, dive: true, base: cam.clone(), ...frameParams(null) };
    pages.length = 0;
    loadFrame();
    loop();
  }

  /** Камера в конце провала: середина области — в середине экрана, рамка области накрывает экран. */
  function diveCam(f) {
    const b = f.base, to = b.clone();
    const depth = f.o && f.o.frameGet ? f.o.frameGet('depth') : M.FRAME_DEFAULTS.depth;
    const empty = (depth * Math.min(W, H)) / Math.max(1e-6, fieldSp * b.zoom);
    let cover = 0;
    if (f.o && f.o.area && f.o.area.length >= 3) {
      const a = areaBounds(f.o), aw = Math.max(1e-6, (a.x1 - a.x0) * b.zoom), ah = Math.max(1e-6, (a.y1 - a.y0) * b.zoom);
      to.x = (a.x0 + a.x1) / 2; to.y = (a.y0 + a.y1) / 2;
      cover = Math.max(W / aw, H / ah);
    }
    to.zoom = b.zoom * Math.max(DIVE_MIN, Math.min(DIVE_MAX, Math.max(cover, empty)));
    return to;
  }
  /** Провал: масштаб растёт по экспоненте, а середина области идёт к середине экрана по прямой — падаем прямо в неё. */
  function placeDive(f) {
    const b = f.base, to = diveCam(f), e = f.k, z = Math.exp(Math.log(b.zoom) + (Math.log(to.zoom) - Math.log(b.zoom)) * e);
    const q = ((1 - e) * b.zoom) / z;
    cam.zoom = z; cam.x = to.x - (to.x - b.x) * q; cam.y = to.y - (to.y - b.y) * q;
    f.x = 0; f.y = 0; f.w = W; f.h = H; f.hole = null;
    if (!pageEl) return;
    const show = f.k > 0.72;
    pageEl.hidden = !show;
    if (!show) return;
    pageEl.classList.add('dive');
    for (const k of ['left', 'top', 'width', 'height', 'borderRadius']) pageEl.style[k] = '';
    // ширина колонки текста и сколько поля приглушить под ним — из параметров окна объекта (width, far)
    pageEl.style.setProperty('--col', Math.round(f.o && f.o.frameGet ? f.o.frameGet('width') : M.FRAME_DEFAULTS.width) + 'px');
    pageEl.style.setProperty('--veil', (0.35 + 0.5 * f.far).toFixed(2));
    pageEl.style.opacity = String(Math.min(1, (f.k - 0.72) / 0.24));
    pageEl.classList.toggle('live', f.k >= 0.98);
  }
  function placeFrame() {
    if (rama.dive) { placeDive(rama); return; }
    const f = rama, t = f.kind === 'space' ? portalTarget() : frameTarget(f.o), e = ease(f.k);
    f.x = lerp(f.from.x, t.x, e); f.y = lerp(f.from.y, t.y, e); f.w = lerp(f.from.w, t.w, e); f.h = lerp(f.from.h, t.h, e);
    // дыра в поле: та же сила раздвигания, что у окна из пустоты
    f.hole = { x: f.x, y: f.y, w: f.w, h: f.h, k: Math.min(1, f.k * 1.6), circle: f.kind === 'space' };
    if (!pageEl) return;
    const show = f.kind !== 'space' && f.k > 0.75;
    pageEl.classList.remove('dive');
    pageEl.hidden = !show;
    if (!show) return;
    pageEl.style.left = f.x / VK + 'px'; pageEl.style.top = f.y / VK + 'px';
    pageEl.style.width = f.w / VK + 'px'; pageEl.style.height = f.h / VK + 'px';
    pageEl.style.borderRadius = (f.round * Math.min(f.w, f.h)) / 2 / VK + 'px';
    pageEl.style.opacity = String(Math.min(1, (f.k - 0.75) / 0.2));
    pageEl.classList.toggle('live', f.k >= 0.98);
  }

  /** Кадр рамы: раскрытие к цели (клик, «назад»), пересчёт прямоугольника, вход в пространство, закрытие. */
  /** Кривая взрыва: вдох (камера чуть отходит), затем рывок с мягкой посадкой. k0 — откуда (после напора). */
  function burstK(u, k0, dive) {
    if (u < BOOM_AT) return k0 - (dive ? 0.06 : 0) * Math.sin((Math.PI / 2) * (u / BOOM_AT)) - (dive ? 0 : 0.04 * k0 * (u / BOOM_AT));
    const v = (u - BOOM_AT) / (1 - BOOM_AT), from = k0 - (dive ? 0.06 : 0);
    return from + (1 - from) * (1 - Math.pow(1 - v, 4));
  }
  function burst(f) {
    f.charge = false;
    f.want = null;
    f.anim = { dir: 1, t: 0, dur: BURST_IN, k0: f.k, boomed: false };
    if (reduce.matches) { f.anim = null; f.k = 1; }
    loop();
  }
  function implode(f) {
    f.charge = false;
    f.want = null;
    f.anim = { dir: -1, t: 0, dur: BURST_OUT, k0: f.k };
    if (reduce.matches) { f.anim = null; f.k = 0; }
    loop();
  }
  /** Взрыв: басовая волна и вспышка из середины области на экране. */
  function boom(f) {
    let x = W / 2, y = H / 2;
    if (f.dive) { const to = diveCam(f); [x, y] = cam.toScreen(to.x, to.y, W, H); }
    pulse(x, y, 1.7, 2200);
    flash = 1; flashX = x; flashY = y;
  }
  function stepFrame(dt) {
    const f = rama;
    // «назад»/«вперёд», Esc, «Наружу» ставят want — переход всё равно играет сам
    if (f.want !== null) {
      const w = f.want;
      f.want = null;
      if (w >= 1 && f.k < 1 && !(f.anim && f.anim.dir > 0)) burst(f);
      else if (w <= 0 && !(f.anim && f.anim.dir < 0)) implode(f);
    }
    if (f.charge) {
      f.v *= Math.exp(-dt * PRESS_DECAY);
      f.idle += dt;
      const push = f.o && f.o.frameGet ? f.o.frameGet('push') : M.FRAME_DEFAULTS.push;
      f.q = Math.min(1, f.v / push);
      f.k = f.dive ? -0.05 * f.q : 0.14 * f.q; // натяжение: камера отходит / дыра приоткрывается
      if (f.v >= push) { boom(f); burst(f); f.anim.t = BOOM_AT; f.anim.boomed = true; }
      else if (f.idle > 0.25 && f.v < push * 0.02) { closeFrameNow(); return; }
    }
    if (f.anim) {
      const a = f.anim;
      a.t = Math.min(1, a.t + dt / a.dur);
      if (a.dir > 0) {
        f.k = burstK(a.t, a.k0, f.dive);
        if (!a.boomed && a.t >= BOOM_AT) { a.boomed = true; boom(f); }
      } else f.k = a.k0 * (1 - ease(a.t));
      if (a.t >= 1) {
        f.anim = null;
        if (a.dir < 0) { if (f.pushed) history.replaceState(baseState(), '', baseUrl()); closeFrameNow(); pulse(W / 2, H / 2, 0.5, 900); return; }
        f.k = 1;
      }
    }
    placeFrame();
    if (f.k >= 1 && f.kind === 'space') {
      // вход — ровно при p = 1 (назад колёсиком до этого — обратимо); сцена ещё грузится — дыра ждёт раскрытой
      if (f.child) portalEnter(f);
      else if (f.childFail) { f.want = 0; f.k = 0.99; pulse(W / 2, H / 2, 1); }
      return;
    }
    if (f.k >= 1 && !f.pushed && f.path) { f.pushed = true; pages.length = 0; pages.push(f.path); history.pushState({ page: f.path }, '', f.path); }
  }
  function closeFrameNow() {
    giveBack();
    const base = rama && rama.dive ? rama.base : null;
    rama = null;
    if (base) { cam.x = base.x; cam.y = base.y; cam.zoom = base.zoom; ensureView(false); }
    pages.length = 0;
    pageReq++;
    if (pageEl) { pageEl.hidden = true; pageEl.classList.remove('live'); }
    clampCam();
    refresh(10);
  }

  /** Колёсико при раме: вглубь — раскрыть, назад — свести (до нуля — рама закрыта, холст снова масштабируется). */
  function frameWheel(dy) {
    const f = rama;
    if (f.anim) return; // взрыв и обратное схлопывание не ускорить и не остановить
    if (f.charge) {
      if (dy < 0) { f.v += -dy; f.idle = 0; } else f.v = Math.max(0, f.v - dy * 2);
      loop();
      return;
    }
    if (dy > 0 && f.k >= 1) implode(f); // открытое окно: колёсико назад — схлопнуться обратно
  }
  const baseUrl = () => spaceUrl(SPACE), baseState = () => ({ space: SPACE });

  /** «Наружу»: страница глубже — назад по стопке; иначе свести раму. */
  function frameBack() {
    if (!rama) return;
    if (pages.length > 1) { history.back(); return; }
    if (rama.pushed) { history.back(); return; }
    rama.want = 0;
    loop();
  }

  /** Содержимое рамы: окно объекта (заголовок, текст, ссылки) или страница сети. */
  async function loadFrame() {
    pageBox();
    const f = rama, req = ++pageReq;
    giveBack();
    pageBody.textContent = '';
    if (f.kind === 'widget') {
      const w = f.o.widget, path = M.KEEPER_WIDGETS[w];
      const h = document.createElement('h2');
      h.textContent = (f.o.window && f.o.window.title) || f.o.label;
      pageBody.append(h);
      if (path) {
        // раздел панели хранителя целиком: те же формы, CSRF и сессия, что на /k
        const fr = document.createElement('iframe');
        fr.className = 'widget-frame';
        fr.src = path;
        fr.title = f.o.label;
        pageBody.append(fr);
        return;
      }
      const el = document.querySelector(`[data-slot="${w}"]`);
      if (!el) return;
      const mark = document.createComment('slot ' + w);
      el.replaceWith(mark);
      el.dataset.framed = '1';
      el.classList.remove('slotted');
      el.hidden = false;
      for (const k of ['left', 'top', 'width', 'height']) el.style[k] = '';
      lent = { el, mark };
      pageBody.append(el);
      return;
    }
    if (f.kind === 'window') {
      // строки текста окна хранитель пишет абзацами
      const w = f.o.window, md = [`# ${w.title || f.o.label}`, '', ...(w.text ? [w.text.replace(/\n+/g, '\n\n'), ''] : [])];
      if (f.o.href) md.push(`- [${f.o.label}](${f.o.href})`);
      for (const l of w.links || []) md.push(`- [${l.label}](${l.href})`);
      renderMd(md.join('\n'), pageBody);
      return;
    }
    pageBody.textContent = '…';
    let text;
    try {
      const r = await fetch(f.path, { headers: { Accept: 'text/markdown' }, credentials: 'same-origin' });
      text = await r.text();
    } catch { text = 'ERR\nСтраница не открылась. Её адрес: ' + f.path; }
    if (req !== pageReq) return;
    pageBody.textContent = '';
    renderMd(text, pageBody);
    pageEl.scrollTop = 0;
  }

  /** Ссылка внутри рамы на свою страницу — глубже: то же окно, новый текст, адрес в истории. */
  function deeper(path) {
    if (!rama) return;
    if (rama.kind === 'window') { rama.kind = 'page'; }
    rama.path = path;
    pages.push(path);
    if (rama.pushed) history.pushState({ page: path }, '', path);
    else { rama.pushed = true; history.pushState({ page: path }, '', path); }
    loadFrame();
  }

  /** Открыть ссылку (окно холста, ссылка вне объекта): своя страница — рамой из центра, чужая — как обычно. */
  function openLink(href) {
    const path = ownPath(href);
    if (!path) { location.href = new URL(href, location.origin).href; return; }
    if (rama) deeper(path);
    else { openFramePath(path); pages.push(path); history.pushState({ page: path }, '', path); }
  }

  /** «Назад»/«вперёд» браузера при рамах. true — событие обработано здесь. */
  function framePop(st) {
    if (st.page) {
      if (!rama) { openFramePath(st.page); pages.push(st.page); return true; }
      const at = pages.lastIndexOf(st.page);
      if (at >= 0) pages.length = at + 1; else pages.push(st.page);
      rama.path = st.page; rama.kind = 'page'; rama.pushed = true; rama.want = 1;
      loadFrame();
      return true;
    }
    if (rama) { rama.pushed = false; rama.want = 0; loop(); return true; }
    return false;
  }

  /** Markdown страниц сети → DOM, только текстом (никакого HTML из ответа): заголовки, абзацы, списки, ссылки, код. */
  function renderMd(md, box) {
    const lines = md.replace(/\r/g, '').split('\n');
    let list = null, para = null, pre = null, brk = false;
    const end = () => { list = null; para = null; };
    for (const line of lines) {
      if (pre) { if (/^```/.test(line)) { pre = null; } else pre.textContent += line + '\n'; continue; }
      if (/^```/.test(line)) { end(); pre = document.createElement('pre'); box.append(pre); continue; }
      if (!line.trim()) { end(); continue; }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { end(); const h = document.createElement('h' + Math.min(4, m[1].length + 1)); inline(m[2], h); box.append(h); continue; }
      if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
        para = null;
        if (!list) { list = document.createElement('ul'); box.append(list); }
        const li = document.createElement('li'); inline(m[1], li); list.append(li); continue;
      }
      if (/^\s*\|/.test(line) || /^ {4}/.test(line)) { end(); const p = document.createElement('pre'); p.className = 'page-row'; p.textContent = line; box.append(p); continue; }
      list = null;
      // строки абзаца текут одной строкой по ширине экрана (как в markdown); два пробела в конце — перенос
      if (!para) { para = document.createElement('p'); box.append(para); } else para.append(brk ? document.createElement('br') : ' ');
      brk = / {2}$/.test(line);
      inline(line.replace(/^>\s?/, '').trim(), para);
    }
  }
  /** Строка: [текст](адрес), **жирный**, `код`; остальное — текстом. Адреса — только http(s) и свои пути. */
  function inline(text, el) {
    const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(https?:\/\/[^\s)]+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.append(text.slice(last, m.index));
      if (m[1] !== undefined || m[5] !== undefined) {
        const href = m[2] || m[5], a = document.createElement('a');
        let ok = false;
        try { const u = new URL(href, location.origin); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { /* битый адрес */ }
        if (ok) { a.href = href; a.textContent = m[1] || m[5]; if (!ownPath(href)) a.rel = 'noopener noreferrer'; el.append(a); }
        else el.append(m[0]);
      } else if (m[3] !== undefined) { const b = document.createElement('strong'); b.textContent = m[3]; el.append(b); }
      else { const c = document.createElement('code'); c.textContent = m[4]; el.append(c); }
      last = re.lastIndex;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  /* ---------------------------------------------------------------------
     ОКНО ИЗ ПУСТОТЫ: узлы поля расходятся из прямоугольника экрана, внутри — текст электрошрифтом (жилы символов,
     /vitrina/font.json грузится при первом окне). Окно не зависит от камеры; полный текст окна есть и в <nav>.
     --------------------------------------------------------------------- */
  let font = null, fontLoading = null, win = null;
  function loadFont() {
    if (!fontLoading) fontLoading = fetch('/vitrina/font.json', { credentials: 'same-origin' }).then((r) => r.json()).then((f) => (font = f)).catch(() => null);
    return fontLoading;
  }
  function openWindow(o) {
    loadFont().then(() => {
      if (!font) { if (o.href) location.href = new URL(o.href, location.origin).href; return; }
      win = layoutWindow(o);
      highlight(-1);
      refresh(60);
    });
  }
  function closeWindow() {
    win = null;
    cv.classList.remove('over');
    refresh(30);
  }

  /** Раскладка окна: заголовок, текст, ссылки; перенос по словам, лишние строки отрезаются (весь текст — в <nav>). */
  function layoutWindow(o) {
    const w = o.window, pad = 28;
    const ww = Math.min(W - 32, 760);
    const blocks = [];
    blocks.push({ text: w.title || o.label, size: Math.min(34, W / 16), color: 'title' });
    if (w.text) for (const para of w.text.split(/\n+/)) blocks.push({ text: para, size: Math.min(21, W / 22) });
    if (o.href) blocks.push({ text: '→ ' + o.label, size: Math.min(21, W / 22), href: new URL(o.href, location.origin).href });
    for (const l of w.links || []) blocks.push({ text: '→ ' + l.label, size: Math.min(21, W / 22), href: new URL(l.href, location.origin).href });
    const adv = (ch, sc) => ((font.glyphs[ch] && font.glyphs[ch].a) || font.space) * sc;
    const items = [], links = [];
    let y = pad;
    const maxH = H - 32;
    for (const bl of blocks) {
      const sc = bl.size / font.size, lh = bl.size * 1.5;
      const words = bl.text.split(/\s+/).filter(Boolean);
      let line = [], lw = 0;
      const put = () => {
        if (!line.length || y + lh > maxH - pad) { line = []; lw = 0; return; }
        let x = pad;
        const y0 = y + bl.size * 1.05;
        for (const word of line) {
          for (const ch of word) { items.push({ ch, x, y: y0, sc, color: bl.href ? 'link' : bl.color || 'text', href: bl.href }); x += adv(ch, sc); }
          x += adv(' ', sc);
        }
        if (bl.href) links.push({ x: pad, y, w: x - pad, h: lh, href: bl.href });
        y += lh; line = []; lw = 0;
      };
      for (const word of words) {
        let wl = 0;
        for (const ch of word) wl += adv(ch, sc);
        if (line.length && lw + wl > ww - 2 * pad) put();
        line.push(word); lw += wl + adv(' ', sc);
      }
      put();
      y += bl.color === 'title' ? bl.size * 0.4 : bl.size * 0.3;
    }
    const wh = Math.min(maxH, y + pad);
    const x0 = (W - ww) / 2, y0 = Math.max(16, (H - wh) / 2);
    for (const it of items) { it.x += x0; it.y += y0; }
    for (const l of links) { l.x += x0; l.y += y0; }
    return { o, x: x0, y: y0, w: ww, h: wh, k: reduce.matches ? 1 : 0, items, links, hover: null, close: { x: x0 + ww - 34, y: y0 + 10, w: 24, h: 24, close: true } };
  }

  /** Ссылка, крестик или само окно под точкой; null — мимо окна. */
  function winTarget(x, y) {
    const inR = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    if (!inR(win)) return null;
    if (inR(win.close)) return win.close;
    return win.links.find(inR) || {};
  }

  /** Пустота окна: узлы внутри уходят к ближайшему краю, у края светятся — рамка из самого поля (пиксели экрана). */
  function voidPush(win, px, py) {
    const m = fieldPx * 1.2, k = win.k;
    if (win.circle) {
      // дыра портала: круг, узлы уходят от середины к ободку
      const cx = win.x + win.w / 2, cy = win.y + win.h / 2, dx = px - cx, dy = py - cy, dd = Math.hypot(dx, dy) || 1e-6, d = win.w / 2 - dd;
      if (d < -m) return null;
      if (d < 0) return [0, 0, 0.7 * k * (1 + d / m)];
      const p = (d + m) * 0.08 * k;
      return [(dx / dd) * p, (dy / dd) * p, 0.5 * k];
    }
    const dl = px - win.x, dr = win.x + win.w - px, dt = py - win.y, db = win.y + win.h - py;
    const d = Math.min(dl, dr, dt, db);
    if (d < -m) return null;
    if (d < 0) return [0, 0, 0.7 * k * (1 + d / m)];
    const p = (d + m) * 0.08 * k;
    if (d === dl) return [-p, 0, 0.5 * k];
    if (d === dr) return [p, 0, 0.5 * k];
    if (d === dt) return [0, -p, 0.5 * k];
    return [0, p, 0.5 * k];
  }

  const WIN_COLORS = { title: 'rgba(220, 255, 255, A)', text: 'rgba(165, 243, 252, A)', link: 'rgba(103, 232, 249, A)', hover: 'rgba(240, 255, 255, A)' };
  function drawWindow() {
    const k = win.k;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(1, 3, 6, ${(0.95 * k).toFixed(3)})`;
    ctx.fillRect(win.x, win.y, win.w, win.h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const groups = {};
    for (const it of win.items) {
      const c = it.href && win.hover && win.hover.href === it.href ? 'hover' : it.color;
      (groups[c] || (groups[c] = [])).push(it);
    }
    for (const [c, list] of Object.entries(groups)) {
      ctx.strokeStyle = ctx.fillStyle = WIN_COLORS[c].replace('A', (0.95 * k).toFixed(3));
      ctx.lineWidth = Math.max(1.1, 8 * list[0].sc * 0.8);
      ctx.beginPath();
      const dots = [];
      for (const it of list) {
        const g = font.glyphs[it.ch];
        if (!g) continue;
        for (const st of g.s) {
          if (st.p.length === 1) { dots.push([it.x + st.p[0][0] * it.sc, it.y + st.p[0][1] * it.sc, Math.max(1.2, st.r * it.sc * 0.8)]); continue; }
          st.p.forEach(([x, y], j) => (j ? ctx.lineTo : ctx.moveTo).call(ctx, it.x + x * it.sc, it.y + y * it.sc));
          if (st.c) ctx.closePath();
        }
      }
      ctx.stroke();
      ctx.beginPath();
      for (const [x, y, r] of dots) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.283); }
      ctx.fill();
    }
    // крестик — две жилы
    const c = win.close;
    ctx.strokeStyle = `rgba(165, 243, 252, ${(0.8 * k).toFixed(3)})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(c.x + 6, c.y + 6); ctx.lineTo(c.x + c.w - 6, c.y + c.h - 6);
    ctx.moveTo(c.x + c.w - 6, c.y + 6); ctx.lineTo(c.x + 6, c.y + c.h - 6);
    ctx.stroke();
  }

  function resize() {
    const cw = window.innerWidth, ch = window.innerHeight;
    VK = Math.min(1, Math.sqrt(REF_AREA / Math.max(1, cw * ch)));
    W = cw * VK; H = ch * VK;
    // пиксели холста: как у экрана, но в пределах бюджета (свечение мягкое, лишние пиксели рисуются впустую)
    DPR = Math.max(1, Math.min((window.devicePixelRatio || 1) / VK, 3 / VK, Math.sqrt(PIXEL_BUDGET / Math.max(1, W * H))));
    SPARK = Math.sqrt(VK);
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    glowCv.width = Math.max(1, Math.round(W / 4)); glowCv.height = Math.max(1, Math.round(H / 4));
    glow2.width = Math.max(1, Math.round(W / 8)); glow2.height = Math.max(1, Math.round(H / 8));
    if (!userMoved) { const to = fitTarget(scene.bounds()); cam.x = to.x; cam.y = to.y; cam.zoom = to.zoom; }
    clampCam();
    if (win) win = layoutWindow(win.o);
    // в провале поле собирается для точки, откуда упали, — и снова растягивается вглубь
    if (rama && rama.dive) { cam.x = rama.base.x; cam.y = rama.base.y; cam.zoom = rama.base.zoom; }
    fx = null;
    ensureView(true);
    if (rama) placeFrame();
    if (reduce.matches) still(60);
  }

  function readSpace() {
    for (const k of Object.keys(S)) S[k] = scene.get(k);
  }

  /* ---------------------------------------------------------------------
     8. ЗАПУСК И СВЯЗЬ С РЕДАКТОРОМ
     Сцена — из data-scene. Не пришла — холст убирается, и ссылки <nav> видны обычным списком.
     Редактор хранителя (/k/editor.js, отдаётся только в сессии) получает движок событием vitrina:ready.
     --------------------------------------------------------------------- */
  const api = {
    M, cv, keeper,
    /** Камера для редактора — в пикселях CSS: zoom — пикселей CSS на единицу мира. */
    cam: {
      get x() { return cam.x; }, set x(v) { cam.x = v; },
      get y() { return cam.y; }, set y(v) { cam.y = v; },
      get zoom() { return cam.zoom * VK; }, set zoom(v) { cam.zoom = v / VK; },
      view(w, h) { return cam.view(w * VK, h * VK); },
    },
    get scene() { return scene; },
    get objects() { return scene.objects; },
    get W() { return W / VK; }, get H() { return H / VK; },
    get tool() { return tool; },
    get level() { return lv; },
    get panning() { return !!gesture && gesture.kind !== 'editor'; },
    setTool(t) { tool = t; cv.classList.toggle('edit', t !== 'view'); if (t !== 'view') { highlight(-1); if (win) closeWindow(); } cameraChanged(2); },
    setOverlay(f) { overlay = f; refresh(2); },
    get space() { return SPACE; },
    /** Нити входа на экране (пиксели CSS): куда ведут и середина кривой. */
    get threads() { return threads.map((t, i) => { const q = threadPath(t, i); return { id: t.id, w: t.w, x: (0.25 * q[0] + 0.5 * q[2] + 0.25 * q[4]) / VK, y: (0.25 * q[1] + 0.5 * q[3] + 0.25 * q[5]) / VK }; }); },
    get rama() { return rama && { kind: rama.kind, k: rama.k, want: rama.want, path: rama.path, charge: !!rama.charge, q: rama.q || 0, anim: !!rama.anim }; },
    goIn, goOut,
    /** Редактор: области, чьи узлы светятся (многоугольники мира). */
    set marks(list) { marks = list || []; },
    /** Басовая волна из точки экрана (пиксели CSS): упор в пределе, удары музыки, виджеты. */
    pulse(sx, sy, amp) { pulse(sx * VK, sy * VK, amp == null ? 1 : amp); },
    /** Редактор: долететь к области объекта и раскрыть его окно. */
    openFrameOf(id) {
      const o = entriesOf(scene).find((x) => x.id === id);
      if (!o || !kindOf(o)) return false;
      if (rama) closeFrameNow();
      flyTo(areaBounds(o));
      if (tween) tween.done = () => openFrame(o, true); else openFrame(o, true);
      return true;
    },
    /** Слух холста: f(dt) → { bands, low, mid, high, level, beat } (music.js). null — тишина. */
    setSound(f) { hearFn = f; loop(); },
    setInput(h) { editorInput = h; },
    onCamera(f) { listeners.push(f); },
    setLive(l) { liveStroke = l; ensureView(true); refresh(2); },
    toWorld(sx, sy) { return cam.toWorld(sx * VK, sy * VK, W, H); },
    toScreen(wx, wy) { const [x, y] = cam.toScreen(wx, wy, W, H); return [x / VK, y / VK]; },
    /** Ближайшая жила к точке экрана: объект, номер мазка и расстояние до стенки в пикселях экрана. */
    nearest(sx, sy) {
      const [wx, wy] = cam.toWorld(sx * VK, sy * VK, W, H);
      queryVoid(wx, wy);
      return qV >= 0 ? { obj: veins[qV].obj, si: veins[qV].si, sd: (qSd * cam.zoom) / VK } : null;
    },
    hit: (sx, sy) => hit(sx * VK, sy * VK), highlight, fitAll, flyTo, cameraChanged,
    exportScene() { return scene.toJSON(); },
    /** Сцена изменилась на месте (правка объектов): пересобрать жилы, камеру не трогать. */
    rebuild(n) { readSpace(); bindNav(); ensureView(true); refresh(n || 30); },
    settle() { ensureView(true); refresh(4); },
    /** Заменить сцену целиком (отмена, повтор, JSON): камера остаётся. */
    load(json) { scene = Scene.from(json); hl = -1; readSpace(); bindNav(); ensureView(true); refresh(30); },
  };

  function start(json) {
    scene = Scene.from(json);
    readSpace();
    bindNav();
    bindBack();
    history.replaceState({ space: SPACE }, '');
    resize();
    loop();
    window.vitrinaEngine = api;
    document.dispatchEvent(new CustomEvent('vitrina:ready', { detail: api }));
  }

  window.addEventListener('resize', resize);
  fetch(cv.dataset.scene || '/vitrina/scene.json', { credentials: 'same-origin' })
    .then((r) => { if (!r.ok) throw new Error('scene ' + r.status); return r.json(); })
    .then(start)
    .catch(() => { root.classList.remove('js'); home.remove(); });
})();
