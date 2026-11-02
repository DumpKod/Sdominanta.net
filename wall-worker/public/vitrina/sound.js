// Слух холста: полосы частот, громкость и удары из спектра AnalyserNode.
// Чистые функции без DOM и Web Audio: их проверяют тесты, а music.js кормит их байтами анализатора каждый кадр.

/** Полос частот, которые видит движок. */
export const BANDS = 24;

/**
 * Границы полос в номерах бинов спектра: логарифмически от lo до hi Гц (как слышит ухо).
 * Каждая полоса — хотя бы один бин; edges.length = n + 1.
 */
export function bandEdges(n, sampleRate, fftSize, lo = 30, hi = 16000) {
  const bins = fftSize / 2, hz = sampleRate / fftSize;
  const top = Math.min(hi, sampleRate / 2);
  const edges = new Int32Array(n + 1);
  for (let k = 0; k <= n; k++) edges[k] = Math.min(bins, Math.round((lo * Math.pow(top / lo, k / n)) / hz));
  for (let k = 1; k <= n; k++) if (edges[k] <= edges[k - 1]) edges[k] = Math.min(bins, edges[k - 1] + 1);
  return edges;
}

/** Байты спектра (0..255, getByteFrequencyData) → полосы 0..1: среднее по бинам полосы. */
export function bandsOf(bytes, edges, out) {
  const n = edges.length - 1;
  for (let k = 0; k < n; k++) {
    const a = edges[k], b = Math.max(a + 1, edges[k + 1]);
    let s = 0;
    for (let i = a; i < b && i < bytes.length; i++) s += bytes[i];
    out[k] = s / ((b - a) * 255);
  }
  return out;
}

/**
 * Ухо: из полос — что нужно кисти. low/mid/high — басы, середина, верх (0..1, сглажено),
 * level — общая громкость, beat — удар (1 в момент удара, дальше гаснет), on — звук идёт.
 * Удар — всплеск басов над их скользящим средним, не чаще раза в 0.18 с.
 */
export class Ear {
  constructor(n = BANDS) {
    this.n = n;
    this.bands = new Float32Array(n);
    this.low = 0; this.mid = 0; this.high = 0; this.level = 0; this.beat = 0; this.on = false;
    this.avg = 0; this.since = 1;
  }
  /** Тишина: всё плавно гаснет (пауза, трек не играет). */
  quiet(dt) {
    const k = Math.exp(-dt * 4);
    this.low *= k; this.mid *= k; this.high *= k; this.level *= k; this.beat *= Math.exp(-dt * 6);
    this.bands.fill(0);
    this.on = false;
    return this;
  }
  update(bands, dt) {
    const n = this.n, a = Math.max(1, Math.round(n * 0.25)), b = Math.max(a + 1, Math.round(n * 0.65));
    let lo = 0, mi = 0, hi = 0;
    for (let k = 0; k < n; k++) {
      this.bands[k] = bands[k];
      if (k < a) lo += bands[k]; else if (k < b) mi += bands[k]; else hi += bands[k];
    }
    lo /= a; mi /= b - a; hi /= n - b;
    const s = 1 - Math.exp(-dt * 12); // сглаживание: быстро, но без дрожи
    this.low += (lo - this.low) * s;
    this.mid += (mi - this.mid) * s;
    this.high += (hi - this.high) * s;
    this.level += ((lo + mi + hi) / 3 - this.level) * s;
    this.since += dt;
    this.beat *= Math.exp(-dt * 6);
    if (lo > this.avg * 1.3 + 0.04 && this.since > 0.18) { this.beat = 1; this.since = 0; }
    this.avg += (lo - this.avg) * (1 - Math.exp(-dt * 1.5));
    this.on = true;
    return this;
  }
}

/*
 * Синхрон с музыкой. Кадр на экране должен показывать звук, который слышно в момент, когда кадр виден,
 * и чуть раньше — на время, которое съедают сглаживания уха и движка. Глаз прощает картинку, которая чуть впереди звука,
 * и замечает отставшую уже с ~45 мс. Поэтому:
 * - спектр заранее: берём полосы на LEAD вперёд от того, что слышно сейчас, — будущее спектра известно;
 * - беззвучная тень (живой анализатор по ключу API): тень идёт на LEAD впереди слышимого звука виджета.
 * «Слышно сейчас» = позиция виджета минус задержка выхода звука устройства (Bluetooth — до 0.3 с).
 */
/** Секунды: кадр до глаза (~2 кадра) + сглаживание уха и движка до половины шага (~60 мс). */
export const LEAD = 0.09;

/** Задержка выхода звука устройства, с: из AudioContext, если браузер её знает. */
export const outLatency = (ctx) => (ctx ? Math.max(0, (ctx.outputLatency || 0) + (ctx.baseLatency || 0)) : 0);

/**
 * Часы позиции чужого плеера (мс). Плеер сообщает позицию редко и с задержкой сообщения; между сообщениями часы
 * идут сами, а сообщение не дёргает их назад-вперёд, а подтягивает плавно. Большой разрыв (перемотка, подгрузка) — прыжок.
 * Без сообщений дольше HOLD часы встают: плеер, скорее всего, ждёт данных.
 */
export class Clock {
  constructor() { this.pos = 0; this.at = 0; this.run = false; }
  static HOLD = 600;
  static JUMP = 250;
  now(t) { return this.run ? this.pos + Math.min(Clock.HOLD, t - this.at) : this.pos; }
  /** Позиция p от плеера в момент t (performance.now()). */
  report(p, t) {
    const est = this.now(t), err = p - est;
    this.pos = !this.run || Math.abs(err) > Clock.JUMP ? p : est + err * 0.25;
    this.at = t;
  }
  set(p, t, run) { this.pos = p; this.at = t; this.run = run; }
}
