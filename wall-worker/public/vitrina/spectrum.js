// Спектр трека, посчитанный заранее: полосы частот по кадрам. Считает браузер хранителя в /k/music из его аудиофайла,
// на сайт уходят только полосы (байты 0..255), звук не покидает его компьютер. Витрина играет трек официальным виджетом
// SoundCloud и каждый кадр берёт полосы по позиции виджета — те же, что дал бы AnalyserNode, если бы звук был у нас.
// Чистые функции без DOM: их проверяют тесты.

import { BANDS, bandEdges, bandsOf } from './sound.js';

export const FFT = 2048;
/** 60 кадров/с — как живой анализатор (расхождение с ним ~0.5%); треки длиннее 20 минут — 30 кадров/с, чтобы влезть в 2 МБ. */
export const FPS = 60;
export const LONG_SEC = 1200;
/** Как у AnalyserNode: окно Блэкмана, |X|/N, сглаживание 0.55 при 60 кадрах в секунду, байты в окне −100…−30 дБ. */
const MIN_DB = -100, MAX_DB = -30, SMOOTH_60 = 0.55;
/** Предел данных: 2 МБ полос — около 23 минут при 24 полосах и 60 кадрах, 46 минут при 30. */
export const MAX_BYTES = 2_000_000;
const MAGIC = 0x31424453; // 'SDB1'
export const HEAD = 16;

function blackman(n) {
  const w = new Float32Array(n), a = 0.16, a0 = (1 - a) / 2, a1 = 0.5, a2 = a / 2;
  for (let i = 0; i < n; i++) w[i] = a0 - a1 * Math.cos((2 * Math.PI * i) / n) + a2 * Math.cos((4 * Math.PI * i) / n);
  return w;
}

/** БПФ на месте (radix-2), re/im длины n = 2^k. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * Моно-сигнал (Float32Array, −1..1) → полосы по кадрам: Uint8Array frames × bands.
 * Кадр k — окно FFT, которое кончается в момент k / fps (как анализатор в момент кадра).
 * onProgress(0..1) — для длинных треков.
 */
export function spectrumOf(mono, sampleRate, { fps = mono.length / sampleRate > LONG_SEC ? 30 : FPS, bands = BANDS, onProgress } = {}) {
  const frames = Math.max(1, Math.floor((mono.length / sampleRate) * fps));
  const out = new Uint8Array(frames * bands);
  const win = blackman(FFT), re = new Float32Array(FFT), im = new Float32Array(FFT);
  const half = FFT / 2, mag = new Float32Array(half), bytes = new Uint8Array(half), b = new Float32Array(bands);
  const edges = bandEdges(bands, sampleRate, FFT);
  const smooth = Math.pow(SMOOTH_60, 60 / fps); // то же время сглаживания, что у живого анализатора
  for (let f = 0; f < frames; f++) {
    const end = Math.round(((f + 1) / fps) * sampleRate);
    for (let i = 0; i < FFT; i++) {
      const s = end - FFT + i;
      re[i] = s >= 0 && s < mono.length ? mono[s] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < half; k++) {
      const m = Math.hypot(re[k], im[k]) / FFT;
      mag[k] = smooth * mag[k] + (1 - smooth) * m;
      const db = mag[k] > 0 ? 20 * Math.log10(mag[k]) : -Infinity;
      bytes[k] = Math.max(0, Math.min(255, Math.floor((255 / (MAX_DB - MIN_DB)) * (db - MIN_DB))));
    }
    bandsOf(bytes, edges, b);
    for (let k = 0; k < bands; k++) out[f * bands + k] = Math.round(b[k] * 255);
    if (onProgress && (f & 255) === 0) onProgress(f / frames);
  }
  return { fps, bands, frames, data: out, durationMs: Math.round((mono.length / sampleRate) * 1000) };
}

/** Каналы AudioBuffer → моно, как сводит их AnalyserNode (среднее). */
export function monoOf(channels) {
  const n = channels[0].length, m = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) m[i] += c[i] / channels.length;
  return m;
}

/** Файл полос, который отдаёт /music/bands/{sc_id}: заголовок 16 байт ('SDB1', fps, bands, 0, 0, frames u32, ms u32) + данные. */
export function packBands({ fps, bands, frames, durationMs, data }) {
  const buf = new Uint8Array(HEAD + data.length), v = new DataView(buf.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint8(4, fps); v.setUint8(5, bands);
  v.setUint32(8, frames, true); v.setUint32(12, durationMs, true);
  buf.set(data, HEAD);
  return buf;
}

export function unpackBands(buf) {
  const u = new Uint8Array(buf), v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < HEAD || v.getUint32(0, true) !== MAGIC) return null;
  const fps = v.getUint8(4), bands = v.getUint8(5), frames = v.getUint32(8, true), durationMs = v.getUint32(12, true);
  if (!fps || !bands || u.length !== HEAD + frames * bands) return null;
  return { fps, bands, frames, durationMs, data: u.subarray(HEAD) };
}

/** Полосы 0..1 в момент ms: между кадрами — линейно, за концом — null (тишина). */
export function bandsAt(s, ms, out) {
  const x = (ms / 1000) * s.fps - 1; // кадр k кончается в (k+1)/fps
  if (!(x >= -1) || x >= s.frames) return null;
  const a = Math.max(0, Math.floor(x)), b = Math.min(s.frames - 1, a + 1), t = Math.max(0, x - a);
  for (let k = 0; k < s.bands; k++) out[k] = (s.data[a * s.bands + k] * (1 - t) + s.data[b * s.bands + k] * t) / 255;
  return out;
}
