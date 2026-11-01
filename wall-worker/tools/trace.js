// Автотрассировка движка хранителя (VOID BRUSH ENGINE): изображение → осевые линии + радиусы.
// Вынесена из sdominanta_brush_engine.html без изменений; нужна только инструменту tools/trace-words.mjs, в витрину не грузится.
'use strict';
function smoothPts(pts, win) {
  if (win < 1 || pts.length < 3) return pts;
  const out = [pts[0]], D = pts[0].length;
  for (let i = 1; i < pts.length - 1; i++) {
    const acc = new Array(D).fill(0); let c = 0;
    for (let j = -win; j <= win; j++) {
      const p = pts[Math.min(pts.length - 1, Math.max(0, i + j))];
      for (let d = 0; d < D; d++) acc[d] += p[d]; c++;
    }
    out.push(acc.map(v => v / c));
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const ex = bx - ax, ey = by - ay, el = Math.hypot(ex, ey) || 1e-9;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * ey - (pts[i][1] - ay) * ex) / el;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Правка к движку: у петли без узлов («о», «а», точка) начало совпадает с концом, и rdp по отрезку нулевой длины
// выбрасывал все точки — буква становилась точкой. Петлю делим по самой дальней точке и упрощаем половины.
function rdpLoop(pts, eps) {
  const a = pts[0], b = pts[pts.length - 1];
  if (pts.length < 4 || Math.hypot(a[0] - b[0], a[1] - b[1]) > 1.5) return rdp(pts, eps);
  let m = 1, md = -1;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]); if (d > md) { md = d; m = i; } }
  return rdp(pts.slice(0, m + 1), eps).concat(rdp(pts.slice(m), eps).slice(1));
}

const round1 = p => p.map(v => Math.round(v * 10) / 10);
function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = g.length - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = t; }
  }
  return th;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; c++; } }
    tmp[y * w + x] = s / c;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c++; } }
    out[y * w + x] = s / c;
  }
  return out;
}

function morph(bin, w, h, grow) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (grow) out[i] = bin[i] | bin[i - 1] | bin[i + 1] | bin[i - w] | bin[i + w];
    else out[i] = bin[i] & bin[i - 1] & bin[i + 1] & bin[i - w] & bin[i + w];
  }
  return out;
}

// Компоненты связности: убрать мелкие пятна (val=1) или залить мелкие дыры (val=0)
function dropSmall(bin, w, h, val, minArea, keepBorder, relLargest, depth, maxDepth) {
  const seen = new Uint8Array(w * h), stack = [], comps = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || bin[s] !== val) continue;
    const comp = []; let border = false;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(); comp.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      const nb = [p - 1, p + 1, p - w, p + w];
      for (let k = 0; k < 4; k++) {
        const q = nb[k];
        if (q < 0 || q >= w * h || seen[q] || bin[q] !== val) continue;
        if ((k === 0 && x === 0) || (k === 1 && x === w - 1)) continue;
        seen[q] = 1; stack.push(q);
      }
    }
    if (depth) { let m = 0; for (const p of comp) m = Math.max(m, depth[p]); if (m <= maxDepth) { for (const p of comp) bin[p] = 1 - val; continue; } }
    comps.push({ comp, border });
  }
  let big = 0; for (const c of comps) big = Math.max(big, c.comp.length);
  const lim = Math.max(minArea, big * (relLargest || 0));
  for (const { comp, border } of comps)
    if (comp.length < lim && !(keepBorder && border)) for (const p of comp) bin[p] = 1 - val;
}

function distTransform(bin, w, h) {
  const d = new Float32Array(w * h), INF = 1e9, D = Math.SQRT2;
  for (let i = 0; i < w * h; i++) d[i] = bin[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) { v = Math.min(v, d[i - w] + 1); if (x > 0) v = Math.min(v, d[i - w - 1] + D); if (x < w - 1) v = Math.min(v, d[i - w + 1] + D); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < h - 1) { v = Math.min(v, d[i + w] + 1); if (x < w - 1) v = Math.min(v, d[i + w + 1] + D); if (x > 0) v = Math.min(v, d[i + w - 1] + D); }
    d[i] = v;
  }
  return d;
}

// соседи по кругу: N, NE, E, SE, S, SW, W, NW
const RDX = [0, 1, 1, 1, 0, -1, -1, -1], RDY = [-1, -1, 0, 1, 1, 1, 0, -1];

function zhangSuen(b, w, h) {
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x; if (!b[i]) continue;
        const p = [];
        for (let k = 0; k < 8; k++) p.push(b[i + RDY[k] * w + RDX[k]]);
        let B = 0, A = 0;
        for (let k = 0; k < 8; k++) { B += p[k]; if (!p[k] && p[(k + 1) % 8]) A++; }
        if (B < 2 || B > 6 || A !== 1) continue;
        if (pass === 0 ? (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) : (p[0] * p[2] * p[6] || p[0] * p[4] * p[6])) continue;
        del.push(i);
      }
      for (const i of del) b[i] = 0;
      if (del.length) changed = true;
    }
  }
}

// Лишние «ступеньки» скелета: пиксель удаляется, если его соседи связны и без него
const REDUNDANT = (() => {
  const t = new Uint8Array(256);
  const adj = (a, b) => { const dx = Math.abs(RDX[a] - RDX[b]), dy = Math.abs(RDY[a] - RDY[b]); return dx <= 1 && dy <= 1; };
  for (let m = 0; m < 256; m++) {
    const on = []; for (let k = 0; k < 8; k++) if (m >> k & 1) on.push(k);
    if (on.length < 2) continue;
    const seen = new Set([on[0]]), st = [on[0]];
    while (st.length) { const a = st.pop(); for (const b of on) if (!seen.has(b) && adj(a, b)) { seen.add(b); st.push(b); } }
    t[m] = seen.size === on.length ? 1 : 0;
  }
  return t;
})();
function maskAt(b, w, i) { let m = 0; for (let k = 0; k < 8; k++) if (b[i + RDY[k] * w + RDX[k]]) m |= 1 << k; return m; }

function traceSkeleton(sk, w, h) {
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (sk[i] && REDUNDANT[maskAt(sk, w, i)]) sk[i] = 0;
  }
  const N = w * h, deg = new Uint8Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (!sk[i]) continue;
    let c = 0; for (let k = 0; k < 8; k++) c += sk[i + RDY[k] * w + RDX[k]]; deg[i] = c;
  }
  const isNode = i => sk[i] && deg[i] !== 2;
  // кластеры узлов → центроиды
  const cl = new Int32Array(N).fill(-1), cent = [];
  for (let i = 0; i < N; i++) {
    if (!isNode(i) || cl[i] >= 0) continue;
    const id = cent.length, st = [i]; cl[i] = id; let sx = 0, sy = 0, c = 0;
    while (st.length) {
      const p = st.pop(); sx += p % w; sy += (p / w) | 0; c++;
      for (let k = 0; k < 8; k++) { const q = p + RDY[k] * w + RDX[k]; if (isNode(q) && cl[q] < 0) { cl[q] = id; st.push(q); } }
    }
    cent.push([sx / c, sy / c, c]);
  }
  const vis = new Uint8Array(N), paths = [];
  const P = i => [i % w, (i / w) | 0];
  function walk(prev, cur, path) {
    const start = path[0];
    for (;;) {
      if (isNode(cur)) break;
      let nxt = -1, node = -1, closed = -1;
      for (let k = 0; k < 8; k++) {
        const q = cur + RDY[k] * w + RDX[k];
        if (!sk[q] || q === prev) continue;
        if (isNode(q)) { if (path.length > 2 || cl[q] !== cl[start]) node = q; }
        else if (!vis[q]) nxt = q;
        else if (q === start && path.length > 3) closed = q;
      }
      if (nxt >= 0) { vis[nxt] = 1; path.push(nxt); prev = cur; cur = nxt; }
      else if (node >= 0) { path.push(node); break; }
      else { if (closed >= 0) path.push(closed); break; }
    }
    return path;
  }
  for (let i = 0; i < N; i++) {
    if (!isNode(i)) continue;
    for (let k = 0; k < 8; k++) {
      const q = i + RDY[k] * w + RDX[k];
      if (!sk[q] || isNode(q) || vis[q]) continue;
      vis[q] = 1; paths.push(walk(i, q, [i, q]));
    }
  }
  for (let i = 0; i < N; i++) {           // замкнутые петли без узлов
    if (!sk[i] || isNode(i) || vis[i]) continue;
    vis[i] = 1; paths.push(walk(-1, i, [i]));
  }
  return paths.map(p => {
    const pts = p.map(P), ends = [p[0], p[p.length - 1]];
    const dead = ends.map(e => isNode(e) && deg[e] <= 1);
    if (isNode(p[0]) && cent[cl[p[0]]][2] > 1) pts.unshift(cent[cl[p[0]]].slice(0, 2));
    if (isNode(p[p.length - 1]) && cent[cl[p[p.length - 1]]][2] > 1) pts.push(cent[cl[p[p.length - 1]]].slice(0, 2));
    const c0 = isNode(p[0]) ? cl[p[0]] : -1, c1 = isNode(p[p.length - 1]) ? cl[p[p.length - 1]] : -1;
    return { idx: p, pts, dead, c0, c1 };
  });
}

function traceSource(src, sw, sh, opt) {
  const sc = Math.min(1, (opt.maxW || 900) / sw);
  const w = Math.max(16, Math.round(sw * sc)), h = Math.max(16, Math.round(sh * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = opt.invert ? '#fff' : '#000'; x.fillRect(0, 0, w, h);
  x.drawImage(src, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  let g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = 0.3 * d[4 * i] + 0.59 * d[4 * i + 1] + 0.11 * d[4 * i + 2];
    g[i] = opt.invert ? 255 - v : v;
  }
  const br = Math.max(1, Math.round(w / 450));
  g = boxBlur(g, w, h, br);
  // двухступенчатый Оцу: сначала отделяем фон, затем внутри светлого — штрих от ореола свечения
  let thr = opt.thr;
  if (!(thr > 0)) {
    const t1 = otsu(g), hi = [];
    for (let i = 0; i < g.length; i++) if (g[i] > t1) hi.push(g[i]);
    // порог ближе к ореолу: ячеистая плазма внутри штриха темнее его кантов
    thr = hi.length > 50 ? t1 + (Math.max(t1, otsu(hi)) - t1) * 0.3 : t1;
  }
  let bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = g[i] > thr ? 1 : 0;
  for (let k = 0; k < br; k++) bin = morph(bin, w, h, true);  // закрыть ячеистые прорехи
  for (let k = 0; k < br; k++) bin = morph(bin, w, h, false);
  let fg = 0; for (let i = 0; i < w * h; i++) fg += bin[i];
  dropSmall(bin, w, h, 1, Math.max(10, fg * 0.004), false, 0.02); // соринки, водяные знаки
  // дырки внутри штриха: мелкие или узкие (щель вдоль жилы), но не «глазки» букв
  let dt = distTransform(bin, w, h);
  const dv = []; for (let i = 0; i < w * h; i++) if (dt[i] > 0) dv.push(dt[i]);
  dv.sort((a, b) => a - b);
  const hw = dv.length ? dv[Math.floor(dv.length * 0.9)] : 3;
  const inv = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) inv[i] = 1 - bin[i];
  dropSmall(bin, w, h, 0, hw * hw * 3, true, 0, distTransform(inv, w, h), hw * 0.8);
  dt = distTransform(bin, w, h);
  zhangSuen(bin, w, h);
  let paths = traceSkeleton(bin, w, h);
  paths.forEach(p => {
    const r = p.idx.map(i => dt[i]).filter(v => v > 0).sort((a, b) => a - b);
    p.r = r.length ? r[r.length >> 1] : 1;
    let L = 0; for (let i = 1; i < p.pts.length; i++) L += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]);
    p.len = L;
  });
  // одна кисть — одна толщина: радиусы веток тянем к общему
  const all = []; paths.forEach(p => all.push(p.r)); all.sort((a, b) => a - b);
  const gr = all.length ? all[all.length >> 1] : 1;
  paths.forEach(p => { p.r = Math.max(gr * 0.75, Math.min(gr * 1.25, p.r)); });
  // обрезка «усов» скелета — коротких тупиковых веток
  paths = paths.filter(p => p.len >= 2 && !((p.dead[0] || p.dead[1]) && p.len < gr * (opt.spur || 2.2)));
  paths = mergePaths(paths);
  return {
    w: sw, h: sh,
    strokes: paths.map(p => {
      let pts = rdpLoop(smoothPts(p.pts, 1), 0.6).map(q => round1([(q[0] + 0.5) / sc, (q[1] + 0.5) / sc]));
      const a = pts[0], b = pts[pts.length - 1];
      const closed = pts.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 2.5 / sc;
      if (closed) pts.pop();
      // радиус бинарной маски включает часть ореола — амплитуда пустоты чуть уже
      const st = { r: Math.round(p.r / sc * 0.62 * 10) / 10, pts };
      if (closed) st.closed = true;
      return st;
    })
  };
}

// Сшивка фрагментов в узлах: продолжаем ту ветку, что идёт прямее всего
function mergePaths(paths) {
  const dirAt = (p, end) => {
    const n = p.pts.length, a = end ? p.pts[n - 1] : p.pts[0];
    const b = end ? p.pts[Math.max(0, n - 6)] : p.pts[Math.min(n - 1, 5)];
    const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  for (let guard = 0; guard < 2000; guard++) {
    const ends = new Map();
    paths.forEach((p, pi) => {
      if (p.c0 >= 0) (ends.get(p.c0) || ends.set(p.c0, []).get(p.c0)).push({ pi, end: 0 });
      if (p.c1 >= 0 && p.c1 !== p.c0) (ends.get(p.c1) || ends.set(p.c1, []).get(p.c1)).push({ pi, end: 1 });
    });
    let pick = null;
    for (const list of ends.values()) {
      if (list.length < 2) continue;
      let best = null, bs = -2;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j]; if (A.pi === B.pi) continue;
        const da = dirAt(paths[A.pi], A.end), db = dirAt(paths[B.pi], B.end);
        const sc = -(da[0] * db[0] + da[1] * db[1]);
        if (sc > bs) { bs = sc; best = [A, B]; }
      }
      if (best && (list.length === 2 || bs > 0.55)) { pick = best; break; }
    }
    if (!pick) break;
    const [A, B] = pick, a = paths[A.pi], b = paths[B.pi];
    const ap = A.end ? a.pts : a.pts.slice().reverse(), bp = B.end ? b.pts.slice().reverse() : b.pts;
    const merged = {
      pts: ap.concat(bp.slice(1)),
      c0: A.end ? a.c0 : a.c1, c1: B.end ? b.c0 : b.c1,
      r: (a.r * a.len + b.r * b.len) / (a.len + b.len), len: a.len + b.len
    };
    paths = paths.filter((_, i) => i !== A.pi && i !== B.pi);
    paths.push(merged);
  }
  return paths;
}
