// Панель хранителя, /k/music: спектр трека из его аудиофайла. Файл читает и раскладывает на частоты сам браузер,
// в форму уходят только полосы (base64url), звук никуда не отправляется.

import { spectrumOf, monoOf } from '/vitrina/spectrum.js';

const AC = window.AudioContext || window.webkitAudioContext;

function b64url(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

for (const form of document.querySelectorAll('.bands-form')) {
  const file = form.querySelector('.bands-file'), note = form.querySelector('.bands-note'), btn = form.querySelector('button');
  const say = (t) => { note.textContent = t; };
  form.addEventListener('submit', async (e) => {
    if (form.elements.data.value) return; // уже посчитано — отправка как есть
    e.preventDefault();
    const f = file.files && file.files[0];
    if (!f) { say('выберите аудиофайл этого трека'); return; }
    if (!AC) { say('браузер не умеет разбирать звук'); return; }
    btn.disabled = true;
    try {
      say('читаю файл…');
      const ctx = new AC();
      const audio = await ctx.decodeAudioData(await f.arrayBuffer());
      ctx.close && ctx.close();
      const ch = [];
      for (let c = 0; c < audio.numberOfChannels; c++) ch.push(audio.getChannelData(c));
      say('считаю частоты…');
      await new Promise((r) => setTimeout(r, 30));
      const s = spectrumOf(monoOf(ch), audio.sampleRate);
      form.elements.fps.value = s.fps;
      form.elements.bands.value = s.bands;
      form.elements.frames.value = s.frames;
      form.elements.duration.value = s.durationMs;
      form.elements.data.value = b64url(s.data);
      say(`готово: ${Math.round(s.durationMs / 1000)} с, ${Math.round(s.data.length / 1024)} КБ полос — отправляю`);
      form.submit();
    } catch {
      btn.disabled = false;
      say('файл не разобран: нужен аудиофайл (mp3, wav, flac, m4a…)');
    }
  });
}
