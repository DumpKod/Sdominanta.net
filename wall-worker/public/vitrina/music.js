// Музыка витрины: трек, который выбрал хранитель, по кругу — только после нажатия ▶ посетителем.
// До нажатия к SoundCloud не уходит ни одного запроса: подпись и ссылки уже в странице.
// Звук идёт в анализатор Web Audio, ухо (sound.js) раз в кадр отдаёт движку полосы частот, громкость и удары.
// Если SoundCloud не разрешит анализ (CORS), трек играет без частот: холст тогда просто дышит сам.

import { BANDS, Ear, bandEdges, bandsOf } from '/vitrina/sound.js';

const box = document.querySelector('.music');
if (box) {
  const btn = box.querySelector('.music-play');
  const note = document.createElement('span');
  note.className = 'music-note';
  note.setAttribute('aria-live', 'polite');
  box.append(note);
  const AC = window.AudioContext || window.webkitAudioContext;
  const ear = new Ear(BANDS);
  const bands = new Float32Array(BANDS);
  let audio = null, ctx = null, an = null, bytes = null, edges = null, tries = 0;

  const say = (t) => { note.textContent = t ? ' · ' + t : ''; };
  const show = () => {
    const on = !!audio && !audio.paused;
    btn.textContent = on ? '⏸' : '▶';
    btn.setAttribute('aria-pressed', String(on));
  };

  // Движок спрашивает слух каждый кадр; без звука ухо плавно гаснет.
  const hear = (dt) => {
    if (an && audio && !audio.paused) {
      an.getByteFrequencyData(bytes);
      return ear.update(bandsOf(bytes, edges, bands), dt);
    }
    return ear.quiet(dt);
  };
  const hook = (engine) => engine && engine.setSound && engine.setSound(hear);
  if (window.vitrinaEngine) hook(window.vitrinaEngine);
  else document.addEventListener('vitrina:ready', (e) => hook(e.detail), { once: true });

  /** Плеер: src ставится прямо в нажатии (иначе браузер не разрешит звук). analyse — через Web Audio. */
  function player(analyse) {
    const a = new Audio();
    a.loop = true;
    a.preload = 'auto';
    if (analyse && ctx) {
      a.crossOrigin = 'anonymous'; // без него Web Audio получает тишину
      const src = ctx.createMediaElementSource(a);
      an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.55;
      src.connect(an);
      an.connect(ctx.destination);
      bytes = new Uint8Array(an.frequencyBinCount);
      edges = bandEdges(BANDS, ctx.sampleRate, an.fftSize);
    } else an = null;
    a.addEventListener('play', show);
    a.addEventListener('pause', show);
    a.addEventListener('playing', () => say(an ? '' : 'без частот'));
    a.addEventListener('error', () => {
      a.pause();
      if (a !== audio) return;
      audio = null;
      // Первая неудача с анализом — ещё раз без него: может быть, SoundCloud не разрешил чтение звука.
      if (analyse && tries < 2) { say('нажмите ▶ ещё раз'); show(); return; }
      say('звук сейчас недоступен — трек можно послушать по ссылке');
      show();
    });
    a.src = box.dataset.stream;
    return a;
  }

  btn.addEventListener('click', () => {
    if (box.dataset.key !== '1') { say('звук пока только по ссылке на SoundCloud'); return; }
    if (audio) {
      if (audio.paused) { audio.play().catch(() => {}); if (ctx) ctx.resume(); } else audio.pause();
      return;
    }
    tries++;
    if (!ctx && AC) ctx = new AC();
    if (ctx) ctx.resume();
    say('подключаю…');
    audio = player(tries === 1);
    audio.play().catch(() => {});
    show();
  });
}
