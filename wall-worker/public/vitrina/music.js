// Музыка витрины: трек или плейлист, который выбрал хранитель, по кругу — только после нажатия ▶ посетителем.
// До нажатия к SoundCloud не уходит ни одного запроса: подпись и ссылки уже в странице.
// Звук всегда играет официальный виджет SoundCloud (решение хранителя 19.10). Частоты — из одного из двух источников,
// холсту всё равно какой (ухо sound.js раз в кадр отдаёт движку полосы, громкость и удары):
// - спектр, который хранитель посчитал заранее из своего файла (/music/bands/{номер трека}); кадр — по позиции виджета;
// - беззвучная тень по ключу API: тот же поток кусками HLS (stream.js) в анализатор, без вывода в колонки,
//   идёт по часам виджета (для трека без спектра, если ключ внесён).
// Если частот нет (нет спектра и ключа, или SoundCloud не разрешил анализ), музыка играет, а холст просто дышит сам.

import { BANDS, Clock, Ear, LEAD, bandEdges, bandsOf, outLatency } from '/vitrina/sound.js';
import { bandsAt, unpackBands } from '/vitrina/spectrum.js';
import { Feed, mediaSource } from '/vitrina/stream.js';

const WIDGET = 'https://w.soundcloud.com/player/';
const WIDGET_API = 'https://w.soundcloud.com/player/api.js';
const AAC = 'audio/mp4; codecs="mp4a.40.2"';

const box = document.querySelector('.music');
if (box) {
  const btn = box.querySelector('.music-play');
  const note = document.createElement('span');
  note.className = 'music-note';
  note.setAttribute('aria-live', 'polite');
  box.append(note);
  const kind = box.dataset.kind || 'track';
  const AC = window.AudioContext || window.webkitAudioContext;
  const ear = new Ear(BANDS);
  const bands = new Float32Array(BANDS);
  let started = false;

  const say = (t) => { note.textContent = t ? ' · ' + t : ''; };
  const show = (on) => {
    btn.textContent = on ? '⏸' : '▶';
    btn.setAttribute('aria-pressed', String(on));
  };

  // ---------- виджет SoundCloud + спектр хранителя ----------

  let w = null, playing = false, spec = null, soundId = 0, raw = null, lat = 0;
  const clock = new Clock();
  /** Задержка выхода звука этого устройства: виджет играет в своём окне, поэтому меряем своим AudioContext и закрываем его. */
  function measureLatency() {
    if (!AC) return;
    try {
      const c = new AC();
      c.resume();
      setTimeout(() => { lat = outLatency(c); c.close(); }, 1500);
    } catch {}
  }
  const spectra = new Map(); // номер трека → Promise<спектр | null>
  const spectrum = (id) => {
    if (!spectra.has(id)) {
      spectra.set(id, fetch(`/music/bands/${id}`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => b && unpackBands(b)).catch(() => null));
    }
    return spectra.get(id);
  };

  function loadApi() {
    if (window.SC && window.SC.Widget) return Promise.resolve();
    return new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = WIDGET_API;
      s.onload = () => (window.SC && window.SC.Widget ? ok() : no());
      s.onerror = no;
      document.head.append(s);
    });
  }

  function onSound(s) {
    if (!s || s.id === soundId) return;
    soundId = s.id;
    spec = null;
    spectrum(s.id).then((x) => {
      if (soundId !== s.id) return;
      spec = x;
      raw = x ? new Float32Array(x.bands) : null;
      if (!x && !shadow) say('для этого трека спектр не посчитан — холст без частот');
    });
  }

  let ifr = null, want = true, idx = 0, loads = 0;
  const now = () => performance.now();

  function widgetStart() {
    const wrap = document.createElement('div');
    wrap.className = 'music-widget';
    ifr = document.createElement('iframe');
    ifr.title = 'Плеер SoundCloud';
    // Вид «с обложкой» (решение хранителя 19.10): фон — обложка трека, белого плеера на витрине нет.
    ifr.allow = 'autoplay; encrypted-media';
    const q = new URLSearchParams({
      url: box.dataset.widget, auto_play: 'true', visual: 'true', show_artwork: 'true', show_user: 'true',
      hide_related: 'true', show_comments: 'false', show_reposts: 'false', show_teaser: 'false',
      buying: 'false', sharing: 'false', download: 'false', color: '#22d3ee',
    });
    ifr.src = WIDGET + '?' + q;
    // Место плеера может переехать в окно объекта (widget: player) — браузер тогда перезагружает iframe.
    // Каждая новая загрузка — новая привязка: тот же трек, та же позиция, играет, если играл.
    ifr.addEventListener('load', () => { if (loads++ && window.SC && window.SC.Widget) bind(true); });
    wrap.append(ifr);
    box.append(wrap);
    box.classList.add('widget-on');
    say('подключаю…');
    loadApi().then(() => bind(false)).catch(() => say('плеер SoundCloud не загрузился — трек можно послушать по ссылке'));
  }

  function bind(again) {
    w = window.SC.Widget(ifr);
    const E = window.SC.Widget.Events;
    const back = again ? { idx, pos: clock.now(now()) } : null;
    playing = false;
    w.bind(E.READY, () => {
      if (back && kind === 'set' && back.idx > 0) w.skip(back.idx);
      if (back && back.pos > 0) w.seekTo(back.pos);
      if (want) w.play(); else w.pause();
      // iPhone может не пустить звук из чужого окна по нашему нажатию: тогда — кнопка самого плеера.
      if (!again) setTimeout(() => { if (!playing) say('нажмите ▶ в плеере SoundCloud'); }, 3000);
    });
    w.bind(E.PLAY, () => {
      playing = true; show(true); say('');
      w.getPosition((p) => clock.set(p, now(), true));
      w.getCurrentSound(onSound);
      if (kind === 'set') w.getCurrentSoundIndex((i) => { idx = i | 0; });
    });
    w.bind(E.PAUSE, () => { playing = false; show(false); clock.set(clock.now(now()), now(), false); });
    w.bind(E.PLAY_PROGRESS, (e) => { if (playing) clock.report(e.currentPosition, now()); });
    w.bind(E.SEEK, (e) => clock.set(e.currentPosition, now(), playing));
    // По кругу: после конца трека (или последнего в плейлисте) — снова с начала.
    w.bind(E.FINISH, () => {
      playing = false;
      show(false);
      clock.set(0, now(), false);
      setTimeout(() => w.isPaused((p) => {
        if (!p || !want) return;
        if (kind === 'set') w.skip(0); else w.seekTo(0);
        w.play();
      }), 400);
    });
    w.bind(E.ERROR, () => say('SoundCloud не отдал звук — трек можно послушать по ссылке'));
  }

  /** Полосы спектра → полосы уха (если число полос другое — ближайшая). */
  function fit(src) {
    if (src.length === BANDS) return src;
    for (let k = 0; k < BANDS; k++) bands[k] = src[Math.min(src.length - 1, Math.floor((k * src.length) / BANDS))];
    return bands;
  }

  function hearWidget(dt) {
    if (!playing || !spec) return ear.quiet(dt);
    // Слышно сейчас то, что плеер отдал lat секунд назад; показываем на LEAD вперёд (см. sound.js).
    const ms = clock.now(now()) + (LEAD - lat) * 1000;
    return bandsAt(spec, ms, raw) ? ear.update(fit(raw), dt) : ear.quiet(dt);
  }

  // ---------- беззвучный слух по ключу API ----------
  // Трек без спектра, ключ внесён: звук по-прежнему играет виджет, а страница рядом берёт тот же поток у SoundCloud
  // кусками (stream.js) и слушает его анализатором, не выводя в колонки. Тень идёт по часам виджета на LEAD впереди
  // слышимого: расхождение до 0.3 с выбирается скоростью (±5%), больше — перемоткой.

  let shadow = null, ctx = null, an = null, bytes = null, edges = null;

  /** Адреса кусков потока от Worker'а; отказ — null. */
  const loadStream = () => fetch(box.dataset.stream).then((r) => r.json().then((j) => (r.ok && Array.isArray(j.segments) ? j : null))).catch(() => null);

  /** Всё, что требует нажатия, — прямо в нём: AudioContext и play() тени. */
  function shadowStart() {
    ctx = new AC();
    ctx.resume();
    shadow = new Audio();
    const src = ctx.createMediaElementSource(shadow);
    an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.55;
    const mute = ctx.createGain();
    mute.gain.value = 0; // в колонки — тишина; связь с выходом нужна, чтобы браузер вообще считал граф
    src.connect(an);
    an.connect(mute);
    mute.connect(ctx.destination);
    bytes = new Uint8Array(an.frequencyBinCount);
    edges = bandEdges(BANDS, ctx.sampleRate, an.fftSize);
    new Feed(shadow, loadStream, () => {
      shadow = null;
      if (!spec) say('частоты для этого трека сейчас недоступны — холст дышит сам');
    });
    shadow.play().catch(() => {});
    setTimeout(() => { lat = outLatency(ctx); }, 1500);
  }

  /** Тень — за часами виджета. */
  function follow() {
    if (!playing) { if (!shadow.paused) shadow.pause(); return false; }
    const want = clock.now(now()) / 1000 + LEAD - lat, d = want - shadow.currentTime;
    if (Math.abs(d) > 0.3) shadow.currentTime = Math.max(0, want);
    else shadow.playbackRate = 1 + Math.max(-0.05, Math.min(0.05, d * 0.5));
    if (shadow.paused) { ctx.resume(); shadow.play().catch(() => {}); }
    return !shadow.seeking && shadow.readyState >= 3;
  }

  function hearShadow(dt) {
    if (!shadow || !follow()) return ear.quiet(dt);
    an.getByteFrequencyData(bytes);
    return ear.update(bandsOf(bytes, edges, bands), dt);
  }

  // Движок спрашивает слух каждый кадр; без звука ухо плавно гаснет.
  const hear = (dt) => (spec ? hearWidget(dt) : shadow ? hearShadow(dt) : ear.quiet(dt));
  const hook = (engine) => engine && engine.setSound && engine.setSound(hear);
  if (window.vitrinaEngine) hook(window.vitrinaEngine);
  else document.addEventListener('vitrina:ready', (e) => hook(e.detail), { once: true });

  btn.addEventListener('click', () => {
    if (!started) {
      started = true;
      // Звук всегда играет виджет. Тень — только для трека без спектра, с ключом и в браузере с MediaSource.
      if (kind === 'track' && box.dataset.bands !== '1' && box.dataset.key === '1' && AC && mediaSource(AAC)) shadowStart();
      else measureLatency();
      widgetStart();
    } else if (w) { want = !playing; if (want) w.play(); else w.pause(); }
  });
}
