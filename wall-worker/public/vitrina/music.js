// Музыка витрины: трек или плейлист, который выбрал хранитель, по кругу — только после нажатия ▶ посетителем.
// До нажатия к SoundCloud не уходит ни одного запроса: подпись и ссылки уже в странице.
// Два источника частот, холсту всё равно какой (ухо sound.js раз в кадр отдаёт движку полосы, громкость и удары):
// - виджет: официальный плеер SoundCloud играет звук, частоты — из спектра, который хранитель посчитал заранее
//   из своего файла (/music/bands/{номер трека}); кадр спектра берётся по позиции виджета;
// - свой плеер по ключу API: куски потока HLS собираются в MediaSource (stream.js), звук идёт в анализатор Web Audio
//   (для трека без спектра, если ключ внесён); не пошёл — тот же трек играет виджет.
// Если частот нет (нет спектра и ключа, или SoundCloud не разрешил анализ), музыка играет, а холст просто дышит сам.

import { BANDS, Clock, Ear, LEAD, Lag, bandEdges, bandsOf, outLatency } from '/vitrina/sound.js';
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
  let mode = null; // 'widget' | 'api'

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
      say(x ? '' : 'для этого трека спектр не посчитан — холст без частот');
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

  // ---------- свой плеер по ключу API ----------

  let audio = null, ctx = null, an = null, bytes = null, edges = null;
  const lag = new Lag(BANDS);

  function hearApi(dt) {
    if (an && audio && !audio.paused) {
      an.getByteFrequencyData(bytes);
      // Анализатор слышит звук на LEAD раньше колонок (DelayNode); остаток — задержка выхода устройства.
      const t = now();
      lag.push(bandsOf(bytes, edges, bands), t);
      const b = lag.at(t, outLatency(ctx) * 1000);
      return b ? ear.update(b, dt) : ear.quiet(dt);
    }
    return ear.quiet(dt);
  }

  /** Адреса кусков потока от Worker'а; отказ — null (текст отказа уходит в подпись). */
  const loadStream = () => fetch(box.dataset.stream).then((r) => r.json().then((j) => {
    if (r.ok && Array.isArray(j.segments)) return j;
    if (j && j.text) say(j.text);
    return null;
  })).catch(() => null);

  /** Поток не пошёл — тот же трек официальным виджетом (без частот, если спектра нет). */
  function toWidget(why) {
    if (audio) { audio.pause(); audio.removeAttribute('src'); }
    audio = null; an = null;
    mode = 'widget';
    show(false);
    lat = outLatency(ctx);
    widgetStart();
    if (why) setTimeout(() => say('свой плеер не смог (' + why + ') — играет плеер SoundCloud'), 0);
  }

  /** Всё, что нужно браузеру для звука, — прямо в нажатии: AudioContext, элемент с MediaSource, play(). */
  function apiStart() {
    ctx = new AC();
    ctx.resume();
    audio = new Audio();
    audio.loop = true;
    const src = ctx.createMediaElementSource(audio);
    an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.55;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = LEAD; // картинка видит звук раньше, чем его слышно: успевает за сглаживанием
    src.connect(an);
    an.connect(delay);
    delay.connect(ctx.destination);
    bytes = new Uint8Array(an.frequencyBinCount);
    edges = bandEdges(BANDS, ctx.sampleRate, an.fftSize);
    audio.addEventListener('play', () => show(true));
    audio.addEventListener('pause', () => show(false));
    audio.addEventListener('playing', () => say(''));
    audio.addEventListener('error', () => { if (audio) toWidget('ошибка звука'); });
    say('подключаю…');
    new Feed(audio, loadStream, (why) => { if (mode === 'api') toWidget(why); });
    audio.play().catch(() => {});
  }

  function apiClick() {
    if (!audio) return apiStart();
    if (audio.paused) { ctx.resume(); audio.play().catch(() => {}); } else audio.pause();
  }

  // Движок спрашивает слух каждый кадр; без звука ухо плавно гаснет.
  const hear = (dt) => (mode === 'widget' ? hearWidget(dt) : mode === 'api' ? hearApi(dt) : ear.quiet(dt));
  const hook = (engine) => engine && engine.setSound && engine.setSound(hear);
  if (window.vitrinaEngine) hook(window.vitrinaEngine);
  else document.addEventListener('vitrina:ready', (e) => hook(e.detail), { once: true });

  btn.addEventListener('click', () => {
    if (!mode) {
      // Свой плеер — только для трека без спектра, с ключом и в браузере с MediaSource; всё остальное играет официальный виджет.
      mode = kind === 'track' && box.dataset.bands !== '1' && box.dataset.key === '1' && AC && mediaSource(AAC) ? 'api' : 'widget';
      if (mode === 'widget') { measureLatency(); widgetStart(); }
    }
    if (mode === 'api') apiClick();
    else if (w) { want = !playing; if (want) w.play(); else w.pause(); }
  });
}
