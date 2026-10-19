// Тестовая страница /lab/sc.html: можно ли анализировать звук SoundCloud с нашей страницы, и насколько точен
// путь «виджет + спектр, посчитанный заранее». Холст витрины слушает то, что здесь играет (setSound движка).
// Ничего не отправляется на сайт: файлы и потоки разбирает только этот браузер.

import { BANDS, Ear, bandEdges, bandsOf } from '/vitrina/sound.js';
import { bandsAt, monoOf, spectrumOf } from '/vitrina/spectrum.js';

const AC = window.AudioContext || window.webkitAudioContext;
const $ = (id) => document.getElementById(id);
const ear = new Ear(BANDS), live = new Float32Array(BANDS), pre = new Float32Array(BANDS);
let ctx = null, an = null, bytes = null, edges = null;
let stop = () => {}; // остановить то, что играет сейчас
let playing = false, spec = null, posMs = null; // для сравнения со спектром заранее

function audio() {
  if (!ctx) {
    ctx = new AC();
    an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.55;
    an.connect(ctx.destination);
    bytes = new Uint8Array(an.frequencyBinCount);
    edges = bandEdges(BANDS, ctx.sampleRate, an.fftSize);
  }
  ctx.resume();
  return ctx;
}

const hear = (dt) => {
  if (playing && an) {
    an.getByteFrequencyData(bytes);
    return ear.update(bandsOf(bytes, edges, live), dt);
  }
  live.fill(0);
  return ear.quiet(dt);
};
const hook = (e) => e && e.setSound && e.setSound(hear);
if (window.vitrinaEngine) hook(window.vitrinaEngine);
else document.addEventListener('vitrina:ready', (e) => hook(e.detail), { once: true });

const say = (el, text, cls = '') => { el.textContent = text; el.className = 'out ' + cls; };

// ---------- 1. виджет ----------

$('w-form').addEventListener('submit', (e) => {
  e.preventDefault();
  let u;
  try { u = new URL($('w-url').value.trim()); } catch { return; }
  if (u.protocol !== 'https:' || !/(^|\.)soundcloud\.com$/.test(u.hostname)) return;
  const f = document.createElement('iframe');
  f.title = 'Плеер SoundCloud';
  f.allow = 'autoplay; encrypted-media';
  f.src = 'https://w.soundcloud.com/player/?' + new URLSearchParams({ url: u.origin + u.pathname, auto_play: 'false', visual: 'false', show_comments: 'false' });
  $('w-box').replaceChildren(f);
});

// ---------- 2. адрес потока ----------

/** Есть ли адрес вообще, если CORS закрыт: запрос без CORS отдаёт непрозрачный ответ, но не падает. */
async function exists(url) {
  try { await fetch(url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' }); return true; } catch { return false; }
}

async function corsGet(url) {
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    return r.ok ? r : { status: r.status };
  } catch {
    return null;
  }
}

/** Плейлист HLS → адреса: init (EXT-X-MAP) и первые куски. Мастер-плейлист — первый вариант. */
async function hlsParts(url, text) {
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const v = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    const r = await corsGet(new URL(v, url).href);
    if (!r || !r.text) return { error: 'вариант потока закрыт' };
    return hlsParts(new URL(v, url).href, await r.text());
  }
  const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(text);
  const segs = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, 6);
  return { init: map ? new URL(map[1], url).href : null, segs: segs.map((s) => new URL(s, url).href) };
}

async function playBuffer(buf, out) {
  const c = audio();
  let ab;
  try {
    ab = await c.decodeAudioData(buf);
  } catch {
    say(out, out.textContent + ' Звук открыт, но этот браузер не разобрал куски потока как файл: своему плееру понадобится разбор HLS (hls.js). Анализ при этом возможен.', 'ok');
    return;
  }
  stop();
  const src = c.createBufferSource();
  src.buffer = ab;
  src.loop = true;
  src.connect(an);
  src.start();
  playing = true; spec = null;
  stop = () => { try { src.stop(); } catch {} playing = false; };
  say(out, out.textContent + ` Играет кусок ${Math.round(ab.duration)} с: холст слушает звук SoundCloud — анализ работает.`, 'ok');
}

$('s-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('s-out');
  const url = $('s-url').value.trim();
  if (!/^https:\/\//.test(url)) { say(out, 'Нужен адрес https://…', 'bad'); return; }
  say(out, 'проверяю…');
  const r = await corsGet(url);
  if (!r) {
    const there = await exists(url);
    say(out, there
      ? 'Закрыто: SoundCloud не разрешает чужим страницам читать этот звук (нет CORS). Свой плеер с анализатором так не заработает; остаётся путь «виджет + спектр заранее».'
      : 'Адрес не открылся совсем: он мог истечь (адреса потоков временные). Скопируйте свежий из вкладки Network.', 'bad');
    return;
  }
  if (!r.arrayBuffer) { say(out, `Сервер ответил ${r.status}: адрес истёк или закрыт. Скопируйте свежий.`, 'bad'); return; }
  const buf = await r.arrayBuffer();
  const head = new TextDecoder().decode(buf.slice(0, 7));
  if (head !== '#EXTM3U') { say(out, 'Открыто: CORS разрешён.', 'ok'); await playBuffer(buf, out); return; }
  const parts = await hlsParts(url, new TextDecoder().decode(buf));
  if (parts.error || !parts.segs || !parts.segs.length) { say(out, 'Плейлист открыт, но в нём нет кусков звука: ' + (parts.error || 'пусто'), 'bad'); return; }
  const got = [];
  for (const u of [parts.init, ...parts.segs].filter(Boolean)) {
    const s = await corsGet(u);
    if (!s || !s.arrayBuffer) {
      say(out, `Плейлист открыт, а куски звука закрыты (${new URL(u).hostname}): анализировать нельзя.`, 'bad');
      return;
    }
    got.push(new Uint8Array(await s.arrayBuffer()));
  }
  const all = new Uint8Array(got.reduce((a, g) => a + g.length, 0));
  let at = 0;
  for (const g of got) all.set(g, at), (at += g.length);
  say(out, `Открыто: плейлист и ${parts.segs.length} кусков звука читаются с нашей страницы (CORS разрешён).`, 'ok');
  await playBuffer(all.buffer, out);
});

// ---------- 3. свой файл ----------

let file = null;
$('f-file').addEventListener('change', async () => {
  const out = $('f-out');
  file = $('f-file').files[0] || null;
  $('f-play').disabled = true;
  spec = null;
  if (!file) return;
  say(out, 'считаю спектр, как в /k/music…');
  try {
    const c = new AC();
    const ab = await c.decodeAudioData(await file.arrayBuffer());
    c.close && c.close();
    const ch = [];
    for (let k = 0; k < ab.numberOfChannels; k++) ch.push(ab.getChannelData(k));
    const t0 = performance.now();
    spec = spectrumOf(monoOf(ch), ab.sampleRate);
    say(out, `спектр готов за ${((performance.now() - t0) / 1000).toFixed(1)} с: ${spec.frames} кадров, ${Math.round(spec.data.length / 1024)} КБ. Нажмите ▶.`);
    $('f-play').disabled = false;
  } catch {
    say(out, 'файл не разобран: нужен аудиофайл', 'bad');
  }
});

let diffSum = 0, diffN = 0;
$('f-play').addEventListener('click', () => {
  if (!file || !spec) return;
  const c = audio();
  stop();
  const el = new Audio(URL.createObjectURL(file));
  el.loop = true;
  c.createMediaElementSource(el).connect(an);
  el.play();
  const s = spec;
  playing = true;
  posMs = () => el.currentTime * 1000;
  diffSum = 0; diffN = 0;
  stop = () => { el.pause(); URL.revokeObjectURL(el.src); playing = false; posMs = null; };
  setTimeout(() => { spec = s; }, 0);
});

// ---------- полосы: живые (верх) и заранее (низ) ----------

const bars = $('bars'), g = bars.getContext('2d');
let last = 0;
function draw(t) {
  requestAnimationFrame(draw);
  const W = bars.width, H = bars.height, w = W / BANDS;
  g.fillStyle = '#020814';
  g.fillRect(0, 0, W, H);
  const have = posMs && spec && bandsAt(spec, posMs(), pre);
  for (let k = 0; k < BANDS; k++) {
    g.fillStyle = '#22d3ee';
    g.fillRect(k * w + 1, H / 2 - live[k] * (H / 2 - 4), w - 2, live[k] * (H / 2 - 4));
    if (have) {
      g.fillStyle = '#a78bfa';
      g.fillRect(k * w + 1, H / 2 + 2, w - 2, pre[k] * (H / 2 - 4));
    }
  }
  if (have && playing) {
    let d = 0;
    for (let k = 0; k < BANDS; k++) d += Math.abs(live[k] - pre[k]);
    diffSum += d / BANDS; diffN++;
    if (t - last > 1000) {
      last = t;
      say($('f-out'), `играет: живой анализатор и спектр заранее расходятся в среднем на ${((diffSum / diffN) * 100).toFixed(1)}% (меньше 5% — почти совпадают).`, 'ok');
    }
  }
}
requestAnimationFrame(draw);
