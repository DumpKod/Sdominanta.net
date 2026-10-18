// Витрина sdominanta.net на движке кисти хранителя (VOID BRUSH ENGINE).
// Сцена = список объектов {id, жилы, ссылка, подпись, область, окно} из data-scene холста (опубликованная версия —
// /vitrina/scene.json, её правит хранитель в /k). <nav> под холстом Worker строит из той же сцены.
// Жила — осевая линия + радиус; пустота жилы резонирует и расталкивает узлы живого поля, на стенках
// узлы уплотняются в светящийся контур. Шрифтов нет: подписи — те же жилы, текст окон — жилы символов (/vitrina/font.json).
// Клик открывает ссылку объекта или его окно из пустоты (попадание — по близости к жилам или по области),
// Tab подсвечивает объекты по очереди (фокус на ссылке <nav>), Enter открывает. Пауза при скрытой вкладке,
// при prefers-reduced-motion — статичный кадр. Внешних адресов нет: только свой домен.
(() => {
  'use strict';
  const root = document.documentElement;
  root.classList.add('js');
  const cv = document.getElementById('scene');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d', { alpha: false });
  const glowCv = document.createElement('canvas');
  const gctx = glowCv.getContext('2d');
  const keeper = root.dataset.keeper === '1';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------------------------------------------------------------
     0. ОБЪЕКТЫ СЦЕНЫ: сцена приходит из data-scene холста (опубликованная — /vitrina/scene.json).
     Объект: { id, label, href?, place?, glyph?: { w, h, strokes: [ { r, pts: [[x,y(,r)], ...], closed? } ] }, area?, window? }.
     --------------------------------------------------------------------- */
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /** Объект без своих жил: незамкнутое кольцо-энсо. */
  function enso() {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const a = -1.3 + (i / 40) * Math.PI * 1.8;
      pts.push([200 + Math.cos(a) * 150, 200 + Math.sin(a) * 150]);
    }
    return { w: 400, h: 400, strokes: [{ r: 12, pts }] };
  }

  const objects = [];
  /** Объект сцены → объект движка. Область без жил задаёт рамку объекта сама. */
  function makeObject(src) {
    let g = src.glyph ? clone(src.glyph) : null;
    if (!g && src.area) {
      g = { w: 1, h: 1, strokes: [] };
      for (const [x, y] of src.area) { g.w = Math.max(g.w, x); g.h = Math.max(g.h, y); }
    }
    return {
      id: src.id, label: src.label, hrefRaw: src.href || null, href: src.href ? new URL(src.href, location.origin).href : null,
      window: src.window || null, area: src.area || null, place: src.place || null, hasGlyph: !!src.glyph,
      link: [...document.querySelectorAll('nav.objects a[data-id]')].find((a) => a.dataset.id === src.id) || null,
      g: g || enso(), fit: { s: 1, ox: 0, oy: 0 }, lift: 0, areaS: null,
    };
  }
  /** Сцена из объектов движка — в том же формате, что приходит с сервера. */
  function exportScene() {
    return {
      v: 1,
      objects: objects.map((o) => {
        const x = { id: o.id, label: o.label };
        if (o.hrefRaw) x.href = o.hrefRaw;
        if (o.place) x.place = o.place;
        if (o.hasGlyph || o.g.strokes.length) x.glyph = o.g;
        if (o.area) x.area = o.area;
        if (o.window) x.window = o.window;
        return x;
      }),
    };
  }

  /* ---------------------------------------------------------------------
     Пространство (пресет «Наш» движка хранителя; музыка в витрине не нужна)
     --------------------------------------------------------------------- */
  const S = { fill: 0.6, thick: 1.15, resonance: 0.45, tact: 0.3, flow: 1.0, wobble: 0.25, drift: 1.4, density: 0.85, glow: 0.8 };

  let W = 0, H = 0, DPR = 1, T = 0;
  let hl = -1; // индекс подсвеченного объекта

  /** Раскладка: первый объект — надпись сверху, остальные — сеткой под ней. Хранитель может сдвинуть и масштабировать. */
  function layout() {
    if (!objects.length) return;
    const narrow = W < H * 0.9;
    const [head, ...rest] = objects;
    const place = (o, x0, y0, w, h, fill, s0) => {
      const over = o.place;
      const k = over && over.k > 0 ? over.k : 1;
      const s = (s0 || Math.min((w * fill) / o.g.w, (h * fill) / o.g.h)) * k;
      const cx = over ? over.x * W : x0 + w / 2, cy = over ? over.y * H : y0 + h / 2;
      o.fit = { s, ox: cx - (o.g.w * s) / 2, oy: cy - (o.g.h * s) / 2 };
      o.areaS = o.area ? o.area.map(([x, y]) => [o.fit.ox + x * s, o.fit.oy + y * s]) : null;
    };
    // узкий экран — слова в один столбец, иначе в два: мелкие жилы тонут в поле
    if (narrow) place(head, W * 0.03, H * 0.03, W * 0.94, H * 0.24, 1);
    else place(head, W * 0.1, H * 0.04, W * 0.8, H * 0.34, 1);
    const cols = narrow ? 1 : 2, rows = Math.ceil(rest.length / cols);
    const y0 = narrow ? H * 0.29 : H * 0.42, gh = H * 0.97 - y0, gw = W * (narrow ? 0.9 : 0.8), x0 = (W - gw) / 2;
    // слова — одним масштабом, чтобы буквы были одной высоты
    const cw = gw / cols, ch = gh / rows;
    const s0 = rest.length ? Math.min(...rest.map((o) => Math.min((cw * 0.84) / o.g.w, (ch * 0.7) / o.g.h))) : 1;
    rest.forEach((o, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const inRow = Math.min(cols, rest.length - r * cols);
      const shift = ((cols - inRow) * cw) / 2; // неполный ряд — по центру
      place(o, x0 + shift + c * cw, y0 + r * ch, cw, ch, 1, s0);
    });
  }

  function mulberry(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------------
     1. ЖИЛЫ: осевые линии в экранных координатах, равномерный шаг
     --------------------------------------------------------------------- */
  const STEP = 3;
  let veins = [];
  let segGrid = null, segCell = 32, segCols = 0, segRows = 0;
  let liveStroke = null; // {obj, st} — мазок хранителя, который рисуется прямо сейчас

  function resample(pts, step) {
    const out = [pts[0][0], pts[0][1], pts[0][2]];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-6) continue;
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

  function buildVeins() {
    veins = [];
    let k = 0;
    const add = (st, oi, si) => {
      k++;
      if (!st.pts || st.pts.length < 1) return;
      const f0 = objects[oi].fit;
      let pts = st.pts.map((p) => [f0.ox + p[0] * f0.s, f0.oy + p[1] * f0.s, (p[2] || st.r) * f0.s]);
      if (st.closed && pts.length > 2) pts.push(pts[0]);
      if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.5, pts[0][1], pts[0][2]]];
      const f = resample(pts, STEP), n = f.length / 3;
      const x = new Float32Array(n), y = new Float32Array(n), rb = new Float32Array(n);
      let R = 0;
      for (let i = 0; i < n; i++) {
        x[i] = f[3 * i]; y[i] = f[3 * i + 1]; rb[i] = Math.max(2.5, f[3 * i + 2]); R = Math.max(R, rb[i]);
      }
      const closed = !!st.closed;
      const rnd = mulberry(k * 7919 + n);
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
        const s = (i * STEP) / R;
        wob[i] = Math.sin(s * 1.9 + ph[0]) * 0.55 + Math.sin(s * 4.7 + ph[1]) * 0.3 + Math.sin(s * 0.53 + ph[2]) * 0.4;
      }
      // формы мод вдоль линии: стоячие волны у открытой, вращающаяся у замкнутой
      const len = Math.max(STEP, (n - 1) * STEP), m1 = new Float32Array(n), m2 = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = ((closed ? 6.283 : Math.PI) * i * STEP) / len;
        m1[i] = closed ? Math.cos(a) : Math.sin(a); m2[i] = closed ? Math.sin(a) : Math.sin(2 * a);
      }
      veins.push({ x, y, nx, ny, rb, n, R, len, wob, m1, m2, rad: new Float32Array(n), ph, k, closed, live: si < 0, region: 0, obj: oi, si });
    };
    objects.forEach((o, oi) => o.g.strokes.forEach((st, si) => add(st, oi, si)));
    if (liveStroke) add(liveStroke.st, liveStroke.obj, -1);
    buildSegGrid();
    buildRegions();
    buildMembrane();
    if (!liveStroke) buildField(true);
  }

  function maxRadius(v) { return v.R * S.thick * 1.3 * (1 + 0.25 * S.wobble + 0.7 * S.resonance) + 2; }

  function buildSegGrid() {
    segCell = 32;
    segCols = Math.ceil(W / segCell) + 1; segRows = Math.ceil(H / segCell) + 1;
    segGrid = new Array(segCols * segRows);
    const reach = fieldSp * 2.2;
    veins.forEach((v, vi) => {
      const m = maxRadius(v) + reach;
      for (let i = 0; i < v.n - 1; i++) {
        const x0 = Math.min(v.x[i], v.x[i + 1]) - m, x1 = Math.max(v.x[i], v.x[i + 1]) + m;
        const y0 = Math.min(v.y[i], v.y[i + 1]) - m, y1 = Math.max(v.y[i], v.y[i + 1]) + m;
        const cx0 = Math.max(0, Math.floor(x0 / segCell)), cx1 = Math.min(segCols - 1, Math.floor(x1 / segCell));
        const cy0 = Math.max(0, Math.floor(y0 / segCell)), cy1 = Math.min(segRows - 1, Math.floor(y1 / segCell));
        const code = vi * 65536 + i;
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * segCols + cx;
          (segGrid[c] || (segGrid[c] = [])).push(code);
        }
      }
    });
  }

  /* Области: жилы, касающиеся друг друга, звучат как одно тело. Частота области ∝ 1 / её длина. */
  let regions = [];
  function buildRegions() {
    const par = veins.map((_, i) => i);
    const find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
    veins.forEach((v, vi) => {
      for (let i = 0; i < v.n; i += 2) {
        const cx = Math.floor(v.x[i] / segCell), cy = Math.floor(v.y[i] / segCell);
        if (cx < 0 || cy < 0 || cx >= segCols || cy >= segRows) continue;
        const list = segGrid[cy * segCols + cx];
        if (!list) continue;
        for (const code of list) {
          const vj = code >> 16;
          if (vj === vi || find(vj) === find(vi)) continue;
          const w = veins[vj], j = code & 65535;
          const ax = w.x[j], ay = w.y[j], ex = w.x[j + 1] - ax, ey = w.y[j + 1] - ay, el = ex * ex + ey * ey || 1e-6;
          const u = Math.max(0, Math.min(1, ((v.x[i] - ax) * ex + (v.y[i] - ay) * ey) / el));
          if (Math.hypot(v.x[i] - ax - ex * u, v.y[i] - ay - ey * u) < (v.rb[i] + w.rb[j]) * S.thick) par[find(vi)] = find(vj);
        }
      }
    });
    const idx = new Map();
    regions = [];
    veins.forEach((v, vi) => {
      const r = find(vi);
      if (!idx.has(r)) { idx.set(r, regions.length); regions.push({ len: 0, ph: (r * 2.399) % 6.283 }); }
      v.region = idx.get(r);
      regions[v.region].len += v.len / objects[v.obj].fit.s;
    });
    for (const r of regions) r.f = Math.max(0.12, Math.min(2.6, 520 / r.len));
  }

  function updateRadii() {
    const t = T;
    for (const r of regions) {
      const ang = t * 6.283 * r.f * (0.4 + S.tact);
      r.S1 = Math.sin(ang + r.ph); r.C1 = Math.cos(ang + r.ph); r.S2 = Math.sin(2 * ang + r.ph * 1.7);
    }
    for (const v of veins) {
      const r = regions[v.region];
      const modeA = v.closed ? r.S1 : r.S1 * 0.7, modeB = v.closed ? r.C1 : r.S2 * 0.45;
      const lift = 1 + 0.3 * objects[v.obj].lift; // подсвеченный объект чуть набухает
      let lam = v.R * 10;
      if (v.closed) lam = v.len / Math.max(1, Math.round(v.len / lam));
      for (let i = 0; i < v.n; i++) {
        const s = i * STEP;
        const beat = 0.5 + 0.5 * Math.sin((s / lam) * 6.283 - t * 2.4 * S.tact + v.ph[3]);
        const pulse = beat * beat * beat * beat;
        const mode = v.m1[i] * modeA + v.m2[i] * modeB;
        v.rad[i] = v.rb[i] * S.thick * lift * (1 + 0.16 * S.wobble * v.wob[i] + S.resonance * (0.45 * pulse + 0.3 * mode));
      }
    }
  }

  // Запрос к полю пустоты: знаковое расстояние до стенки ближайшей жилы
  let qSd = 0, qNx = 0, qNy = 0, qTx = 0, qTy = 0, qV = -1;
  function queryVoid(px, py) {
    qSd = Infinity; qV = -1;
    const cx = Math.floor(px / segCell), cy = Math.floor(py / segCell);
    if (cx < 0 || cy < 0 || cx >= segCols || cy >= segRows) return;
    const list = segGrid[cy * segCols + cx];
    if (!list) return;
    for (let j = 0; j < list.length; j++) {
      const code = list[j], v = veins[code >> 16], i = code & 65535;
      const ax = v.x[i], ay = v.y[i], ex = v.x[i + 1] - ax, ey = v.y[i + 1] - ay;
      const el = ex * ex + ey * ey || 1e-6;
      let u = ((px - ax) * ex + (py - ay) * ey) / el;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = px - ax - ex * u, dy = py - ay - ey * u;
      const d = Math.sqrt(dx * dx + dy * dy);
      const sd = d - (v.rad[i] + (v.rad[i + 1] - v.rad[i]) * u);
      if (sd < qSd) {
        qSd = sd; qV = code >> 16;
        const l = Math.sqrt(el); qTx = ex / l; qTy = ey / l;
        if (d > 1e-3) { qNx = dx / d; qNy = dy / d; } else { qNx = -ey / l; qNy = ex / l; }
      }
    }
  }

  /* ---------------------------------------------------------------------
     2. ПОЛЕ: живые узлы пространства
     --------------------------------------------------------------------- */
  let fieldSp = 14, NF = 0, NF0 = 0;
  let fx, fy, fvx, fvy, fhx, fhy, fph, fb, fsc, fcode = new Int32Array(0);
  let bandIndex = new Map();

  function veinKey(v) { return v.n + ':' + v.x[0].toFixed(1) + ':' + v.y[0].toFixed(1) + ':' + v.x[v.n - 1].toFixed(1) + ':' + v.R.toFixed(2); }
  function calcSp() { return Math.max(10, Math.sqrt((W * H) / 9000)) / S.density; }

  // Поле = редкая сетка пространства + плотная полоса узлов вдоль каждой жилы
  function buildField(keep) {
    const old = keep && fx ? { fx, fy, fvx, fvy, fb, NF0, bandIndex } : null;
    fieldSp = calcSp();
    const rnd = mulberry(1234), H_ = [];
    const cols = Math.ceil(W / fieldSp) + 2, rows = Math.ceil(H / (fieldSp * 0.866)) + 2;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      H_.push((c - 1 + (r % 2) * 0.5) * fieldSp + (rnd() - 0.5) * fieldSp * 0.7, (r - 1) * fieldSp * 0.866 + (rnd() - 0.5) * fieldSp * 0.7, fieldSp);
    }
    const coarse = H_.length / 3;
    const newIndex = new Map(), bandSrc = [];
    for (const v of veins) {
      if (v.live) continue;
      const key = veinKey(v), start = H_.length / 3;
      const sf = Math.max(4.2, Math.min(fieldSp * 0.62, v.R * 0.55)) / Math.sqrt(S.density);
      // полоса узлов вокруг тонкой жилы уже: иначе мелкие слова тонут в ореоле
      const B = v.R * S.thick * 1.5 + Math.min(fieldSp * 1.3, v.R * 2.5 + fieldSp * 0.5);
      const r2 = mulberry(v.n * 131 + Math.round(v.x[0] * 7 + v.y[0] * 13));
      const cnt = Math.round(((v.len * 2 * B) / (sf * sf)) * 0.65);
      for (let i = 0; i < cnt; i++) {
        const j = Math.min(v.n - 1, (r2() * v.n) | 0), u = (r2() * 2 - 1) * B;
        H_.push(v.x[j] + v.nx[j] * u + (r2() - 0.5) * STEP, v.y[j] + v.ny[j] * u + (r2() - 0.5) * STEP, sf);
      }
      newIndex.set(key, [start, cnt]);
      bandSrc.push([key, start, cnt]);
    }
    NF = H_.length / 3; NF0 = coarse;
    fx = new Float32Array(NF); fy = new Float32Array(NF); fvx = new Float32Array(NF); fvy = new Float32Array(NF);
    fhx = new Float32Array(NF); fhy = new Float32Array(NF); fph = new Float32Array(NF); fb = new Float32Array(NF);
    fsc = new Float32Array(NF); fcode = new Int32Array(NF);
    for (let k = 0; k < NF; k++) {
      fhx[k] = fx[k] = H_[3 * k]; fhy[k] = fy[k] = H_[3 * k + 1]; fsc[k] = H_[3 * k + 2]; fph[k] = rnd() * 6.283;
    }
    if (old) {
      const copy = (from, to, n) => {
        for (let i = 0; i < n; i++) {
          fx[to + i] = old.fx[from + i]; fy[to + i] = old.fy[from + i];
          fvx[to + i] = old.fvx[from + i]; fvy[to + i] = old.fvy[from + i]; fb[to + i] = old.fb[from + i];
        }
      };
      if (old.NF0 === coarse) copy(0, 0, coarse);
      for (const [key, start, cnt] of bandSrc) {
        const o = old.bandIndex.get(key);
        if (o && o[1] === cnt) copy(o[0], start, cnt);
      }
    }
    bandIndex = newIndex;
  }

  /* ---------------------------------------------------------------------
     3. МЕМБРАНА: плазма внутри жилы (s вдоль, u поперёк)
     --------------------------------------------------------------------- */
  let NM = 0, mv, ms, mu, mph, mx, my, mb;
  function buildMembrane() {
    const list = [];
    veins.forEach((v, vi) => {
      const rnd = mulberry(v.k * 104729 + 17);
      const sp = Math.max(3.6, v.R * 0.42);
      const count = Math.round((v.len * 2 * v.R) / (sp * sp)) + 2;
      for (let i = 0; i < count; i++) {
        let u = rnd() * 2 - 1;
        if (rnd() < 0.3) u = Math.sign(u || 1) * (0.82 + rnd() * 0.18); // ряды у стенок гуще — яркий кант
        list.push(vi, rnd() * v.len, u, rnd() * 6.283);
      }
    });
    NM = list.length / 4;
    mv = new Uint16Array(NM); ms = new Float32Array(NM); mu = new Float32Array(NM); mph = new Float32Array(NM);
    mx = new Float32Array(NM); my = new Float32Array(NM); mb = new Float32Array(NM);
    for (let i = 0; i < NM; i++) { mv[i] = list[4 * i]; ms[i] = list[4 * i + 1]; mu[i] = list[4 * i + 2]; mph[i] = list[4 * i + 3]; }
  }

  /* ---------------------------------------------------------------------
     4. КАДР
     --------------------------------------------------------------------- */
  const mouse = { x: -1e4, y: -1e4, in: false, down: false };
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

  function linkNodes(X, Y, B, n, L, gain, base, SC, CODE) {
    const cols = Math.ceil(W / L) + 2, rows = Math.ceil(H / L) + 2;
    if (!hHead || hHead.length < cols * rows) hHead = new Int32Array(cols * rows);
    if (!hNext || hNext.length < n) hNext = new Int32Array(Math.max(n, 1024));
    hHead.fill(-1, 0, cols * rows);
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(X[i] / L) + 1, cy = Math.floor(Y[i] / L) + 1;
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) { hNext[i] = -2; continue; }
      const c = cy * cols + cx; hNext[i] = hHead[c]; hHead[c] = i;
    }
    const L2 = L * L, OFF = [[0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      for (let i = hHead[cy * cols + cx]; i >= 0; i = hNext[i]) {
        for (const [ox, oy] of OFF) {
          const nx = cx + ox, ny = cy + oy;
          if (nx < 0 || nx >= cols || ny >= rows) continue;
          for (let j = ox || oy ? hHead[ny * cols + nx] : hNext[i]; j >= 0; j = hNext[j]) {
            const dx = X[i] - X[j], dy = Y[i] - Y[j], d2 = dx * dx + dy * dy;
            let Lp = L, Lp2 = L2;
            if (SC) { Lp = Math.min(SC[i], SC[j]) * 1.6; Lp2 = Lp * Lp; }
            if (d2 > Lp2) continue;
            if (CODE && CODE[i] && CODE[i] === -CODE[j]) continue; // связь не перекидывается через пустоту
            const f = (1 - Math.sqrt(d2) / Lp) * (base + (1 - base) * Math.max(B[i], B[j])) * gain;
            if (f < 0.02) continue;
            bucket[Math.min(NB - 1, (f * NB) | 0)].push(X[i], Y[i], X[j], Y[j]);
          }
        }
      }
    }
  }

  function flush(widthBase) {
    for (let k = 0; k < NB; k++) {
      const a = bucket[k];
      if (!a.length) continue;
      ctx.strokeStyle = COLORS[k];
      ctx.lineWidth = widthBase + (0.9 * k) / NB;
      ctx.beginPath();
      for (let i = 0; i < a.length; i += 4) { ctx.moveTo(a[i], a[i + 1]); ctx.lineTo(a[i + 2], a[i + 3]); }
      ctx.stroke();
      a.length = 0;
    }
  }

  function step() {
    const t = T, drift = S.drift * fieldSp * 0.55;
    const cr = Math.max(22, Math.min(44, Math.min(W, H) * 0.045)), cr2 = cr * cr;
    const cursorOn = mouse.in && tool === 'view';
    for (const o of objects) o.lift += ((objects.indexOf(o) === hl ? 1 : 0) - o.lift) * (reduce.matches ? 1 : 0.12);
    if (win) win.k += (1 - win.k) * (reduce.matches ? 1 : 0.1);
    const hlArea = hl >= 0 && objects[hl] ? objects[hl].areaS : null;
    for (let i = 0; i < NF; i++) {
      const hx = fhx[i] + drift * (Math.sin(fhy[i] * 0.009 + t * 0.35 + fph[i] * 0.3) + 0.5 * Math.sin(fhx[i] * 0.017 - t * 0.27));
      const hy = fhy[i] + drift * (Math.cos(fhx[i] * 0.008 - t * 0.31) + 0.5 * Math.sin(fhy[i] * 0.021 + t * 0.4 + fph[i] * 0.3));
      let ax = (hx - fx[i]) * 0.035, ay = (hy - fy[i]) * 0.035;
      queryVoid(fx[i], fy[i]);
      let b = 0;
      // сторона стенки: узлы с разных берегов одной жилы не связываются
      fcode[i] = qSd < fsc[i] * 1.5 ? (qV + 1) * (qNx * -qTy + qNy * qTx >= 0 ? 1 : -1) : 0;
      if (qSd < Infinity) {
        if (qSd < 0) { const p = -qSd * 0.32; ax += qNx * p; ay += qNy * p; b = 1; }
        else { const z = qSd / (fsc[i] * 1.6); b = Math.exp(-z * z); }
        const fl = S.flow * b * 0.5; ax += qTx * fl; ay += qTy * fl; // стенки скользят вдоль линии
        b *= 1 + 0.5 * objects[veins[qV].obj].lift;
      }
      if (cursorOn) {
        const dx = fx[i] - mouse.x, dy = fy[i] - mouse.y, d2 = dx * dx + dy * dy;
        if (d2 < cr2 * 2.2) {
          const d = Math.sqrt(d2) || 1e-3;
          if (d < cr) { const q = 1 - d / cr, p = q * q * 1.6; ax += (dx / d) * p; ay += (dy / d) * p; b = Math.max(b, q * 0.5); }
        }
      }
      if (win) {
        const p = voidPush(fx[i], fy[i]);
        if (p) { ax += p[0]; ay += p[1]; b = Math.max(b, p[2]); }
      }
      if (hlArea && inPoly(hlArea, fx[i], fy[i])) b = Math.max(b, 0.6 * objects[hl].lift);
      fvx[i] = fvx[i] * 0.8 + ax; fvy[i] = fvy[i] * 0.8 + ay;
      fx[i] += fvx[i]; fy[i] += fvy[i];
      fb[i] = fb[i] * 0.6 + b * 0.4;
    }
    // мембрана: координаты жилы → экран
    for (let i = 0; i < NM; i++) {
      const v = veins[mv[i]];
      if (!v) { mb[i] = 0; continue; }
      const f = ms[i] / STEP, j = Math.min(v.n - 2, Math.max(0, f | 0)), u = Math.min(1, f - j), j1 = Math.min(v.n - 1, j + 1);
      const R = v.rad[j] + (v.rad[j1] - v.rad[j]) * u;
      const cx = v.x[j] + (v.x[j1] - v.x[j]) * u, cy = v.y[j] + (v.y[j1] - v.y[j]) * u;
      const off = mu[i] * R * Math.min(0.97, 0.86 + 0.06 * Math.sin(t * 1.7 + mph[i]));
      const jit = v.R * 0.12;
      mx[i] = cx + v.nx[j] * off + Math.sin(t * 1.3 + mph[i] * 3) * jit;
      my[i] = cy + v.ny[j] * off + Math.cos(t * 1.1 + mph[i] * 2) * jit;
      const tactB = 0.5 + 0.5 * Math.sin((ms[i] / (v.R * 10)) * 6.283 - t * 2.4 * S.tact + v.ph[3]);
      mb[i] = (0.45 + 0.4 * mu[i] * mu[i] + 0.25 * tactB * tactB) * (1 + 0.6 * objects[v.obj].lift);
    }
  }

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#010306';
    ctx.fillRect(0, 0, W, H);
    const vg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(0, 40, 48, 0.35)');
    vg.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = 'lighter';
    // ось жил тонкой линией: по ней читаются мелкие слова; подсвеченный объект ярче
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    for (let oi = 0; oi < objects.length; oi++) {
      ctx.strokeStyle = `rgba(0, 242, 254, ${(0.16 + 0.34 * objects[oi].lift).toFixed(3)})`;
      ctx.beginPath();
      for (const v of veins) if (v.obj === oi) { ctx.moveTo(v.x[0], v.y[0]); for (let i = 1; i < v.n; i++) ctx.lineTo(v.x[i], v.y[i]); }
      ctx.stroke();
    }
    linkNodes(fx, fy, fb, NF, fieldSp * 1.6, 1, 0.1, fsc, fcode);
    flush(0.35);
    if (NM) {
      const L = Math.max(5, (veins[0] ? veins[0].R : 8) * 0.42 * 1.75);
      linkNodes(mx, my, mb, NM, L, S.fill, 0.2);
      flush(0.3);
    }
    // искры: узлы на стенках и в плазме
    ctx.fillStyle = 'rgba(160, 250, 255, 0.85)';
    ctx.beginPath();
    for (let i = 0; i < NF; i++) {
      const b = fb[i];
      if (b < 0.35) continue;
      const s = 0.6 + b * 1.3 * (0.75 + 0.25 * Math.sin(T * 3 + fph[i] * 5));
      ctx.rect(fx[i] - s / 2, fy[i] - s / 2, s, s);
    }
    ctx.fill();
    ctx.fillStyle = `rgba(220, 255, 255, ${0.9 * S.fill})`;
    ctx.beginPath();
    for (let i = 0; i < NM; i += 3) {
      const tw = Math.sin(T * 2.2 + mph[i] * 7);
      if (tw < 0.55) continue;
      const s = 0.8 + tw * 1.6;
      ctx.rect(mx[i] - s / 2, my[i] - s / 2, s, s);
    }
    ctx.fill();
    if (win) drawWindow();
    // свечение: размытый уменьшенный кадр поверх (дешевле shadowBlur)
    gctx.globalCompositeOperation = 'copy';
    gctx.filter = 'blur(3px)';
    gctx.drawImage(cv, 0, 0, glowCv.width, glowCv.height);
    gctx.filter = 'none';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.min(1, S.glow * 0.9);
    ctx.drawImage(glowCv, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (overlay) overlay(ctx);
  }

  /* ---------------------------------------------------------------------
     5. ДВИЖЕНИЕ: пауза при скрытой вкладке, статичный кадр при reduced-motion
     --------------------------------------------------------------------- */
  let raf = 0, lastTs = 0;
  function frame(ts) {
    raf = 0;
    if (document.hidden || reduce.matches) return;
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    T += dt;
    updateRadii();
    step();
    draw();
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
    updateRadii();
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
    if (reduce.matches) { stop(); still(60); } else loop();
  });

  /* ---------------------------------------------------------------------
     6. ПОПАДАНИЕ, КЛИК, КЛАВИАТУРА
     --------------------------------------------------------------------- */
  let tool = 'view';
  let overlay = null;

  /** Объект под точкой: ближе порога к его жилам или внутри его области. */
  function hit(px, py) {
    queryVoid(px, py);
    if (qV >= 0 && qSd < Math.max(12, fieldSp)) return veins[qV].obj;
    for (let i = objects.length - 1; i >= 0; i--) if (objects[i].areaS && inPoly(objects[i].areaS, px, py)) return i;
    return -1;
  }

  function inPoly(poly, x, y) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) c = !c;
    }
    return c;
  }

  /** Объект открывает окно, если оно у него есть, иначе — свою ссылку. */
  function activate(i) {
    const o = objects[i];
    if (!o) return;
    if (o.window) openWindow(o);
    else if (o.href) location.href = o.href;
  }

  function highlight(i) {
    if (hl === i) return;
    hl = i;
    cv.classList.toggle('over', i >= 0 && tool === 'view');
    refresh();
  }

  cv.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.in = true;
    if (tool !== 'view') return;
    if (win) {
      const l = winTarget(e.clientX, e.clientY);
      win.hover = l && l.href ? l : null;
      cv.classList.toggle('over', !!l);
      return;
    }
    highlight(hit(e.clientX, e.clientY));
  });
  cv.addEventListener('pointerleave', () => {
    mouse.in = false; mouse.x = mouse.y = -1e4;
    if (tool === 'view') highlight(-1);
  });
  cv.addEventListener('click', (e) => {
    if (tool !== 'view') return; // у хранителя в инструментах правки клик — правка
    if (win) {
      const l = winTarget(e.clientX, e.clientY);
      if (l && l.href) location.href = l.href;
      else if (!l || l.close) closeWindow(); // клик мимо окна или по крестику закрывает его
      return;
    }
    activate(hit(e.clientX, e.clientY));
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && win) closeWindow();
  });

  // Tab идёт по настоящим ссылкам <nav>: фокус подсвечивает объект, Enter открывает ссылку (или окно объекта).
  function bindNav() {
    objects.forEach((o, i) => {
      if (!o.link || o.link.dataset.bound) return;
      o.link.dataset.bound = '1';
      o.link.addEventListener('focus', () => highlight(objects.indexOf(o)));
      o.link.addEventListener('blur', () => highlight(-1));
      o.link.addEventListener('click', (e) => {
        if (o.window) { e.preventDefault(); openWindow(o); }
      });
    });
  }

  /* ---------------------------------------------------------------------
     ОКНО ИЗ ПУСТОТЫ: узлы поля расходятся из прямоугольника, внутри — текст электрошрифтом (жилы символов,
     /vitrina/font.json грузится при первом окне). Ссылки окна — тем же шрифтом; полный текст окна есть и в <nav>.
     --------------------------------------------------------------------- */
  let font = null, fontLoading = null, win = null;
  function loadFont() {
    if (!fontLoading) fontLoading = fetch('/vitrina/font.json', { credentials: 'same-origin' }).then((r) => r.json()).then((f) => (font = f)).catch(() => null);
    return fontLoading;
  }
  function openWindow(o) {
    loadFont().then(() => {
      if (!font) { if (o.href) location.href = o.href; return; }
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
    if (o.href) blocks.push({ text: '→ ' + o.label, size: Math.min(21, W / 22), href: o.href });
    for (const l of w.links || []) blocks.push({ text: '→ ' + l.label, size: Math.min(21, W / 22), href: new URL(l.href, location.origin).href });
    const adv = (ch, sc) => ((font.glyphs[ch] && font.glyphs[ch].a) || font.space) * sc;
    const items = [], links = [];
    let y = pad;
    const maxH = H - 32;
    for (const bl of blocks) {
      const sc = bl.size / font.size, lh = bl.size * 1.5;
      const words = bl.text.split(/\s+/).filter(Boolean);
      let line = [], lw = 0;
      const flush = () => {
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
        if (line.length && lw + wl > ww - 2 * pad) flush();
        line.push(word); lw += wl + adv(' ', sc);
      }
      flush();
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

  /** Пустота окна: узлы внутри уходят к ближайшему краю, у края светятся — рамка из самого поля. */
  function voidPush(px, py) {
    const m = fieldSp * 1.2, k = win.k;
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
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    glowCv.width = Math.max(1, Math.round(W / 4)); glowCv.height = Math.max(1, Math.round(H / 4));
    layout();
    fieldSp = calcSp();
    fx = null;
    buildVeins();
    if (reduce.matches) still(60);
  }

  /* ---------------------------------------------------------------------
     7. ЗАПУСК И СВЯЗЬ С РЕДАКТОРОМ
     Сцена — из data-scene. Не пришла — холст убирается, и ссылки <nav> видны обычным списком.
     Редактор хранителя (/k/editor.js, отдаётся только в сессии) получает движок событием vitrina:ready.
     --------------------------------------------------------------------- */
  const api = {
    objects, cv, keeper,
    get W() { return W; }, get H() { return H; },
    get tool() { return tool; },
    setTool(t) { tool = t; cv.classList.toggle('edit', t !== 'view'); if (t !== 'view') { highlight(-1); if (win) closeWindow(); } },
    setOverlay(f) { overlay = f; },
    setLive(l) { liveStroke = l; buildVeins(); refresh(2); },
    nearest(x, y) { queryVoid(x, y); return qV >= 0 ? { v: veins[qV], sd: qSd } : null; },
    hit, makeObject, exportScene, highlight,
    rebuild(n) { layout(); buildVeins(); refresh(n || 30); },
    settle() { buildField(true); refresh(4); },
    load: start,
  };

  function start(scene) {
    objects.length = 0;
    for (const s of (scene && scene.objects) || []) objects.push(makeObject(s));
    bindNav();
    resize();
    loop();
    window.vitrinaEngine = api;
    document.dispatchEvent(new CustomEvent('vitrina:ready', { detail: api }));
  }

  window.addEventListener('resize', resize);
  fetch(cv.dataset.scene || '/vitrina/scene.json', { credentials: 'same-origin' })
    .then((r) => { if (!r.ok) throw new Error('scene ' + r.status); return r.json(); })
    .then(start)
    .catch(() => root.classList.remove('js'));
})();
