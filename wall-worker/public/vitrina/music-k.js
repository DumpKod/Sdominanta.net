// Панель хранителя, /k/music: подпись трека находит браузер хранителя. Серверу Cloudflare SoundCloud отвечает
// отказом (403), браузеру — нет. Сначала oEmbed SoundCloud, не вышло — скрытый официальный виджет в этой вкладке.
// В форму уходят номер, название, автор и ссылка на автора; сервер проверяет их как свои.

const form = document.querySelector('.add-form');
const API = 'https://w.soundcloud.com/player/api.js';

/** Адрес без хвоста ?si=… и #…: тот же, что сохранит сервер. */
const bare = (raw) => {
  try { const u = new URL(raw.trim()); return `https://soundcloud.com${u.pathname.replace(/\/+$/, '')}`; } catch { return null; }
};
const slugTitle = (s) => s.replace(/[-_]+/g, ' ').trim();

async function byOembed(url, kind) {
  const r = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`, { credentials: 'omit' });
  if (!r.ok) throw new Error('oembed ' + r.status);
  const j = await r.json();
  const what = kind === 'set' ? 'playlists' : 'tracks';
  const m = new RegExp(`api\\.soundcloud\\.com(?:%2F|/)${what}(?:%2F|/)(\\d{1,16})`).exec(j.html || '');
  if (!m) throw new Error('нет номера');
  let title = String(j.title || ''), artist = String(j.author_name || '');
  if (artist && title.endsWith(` by ${artist}`)) title = title.slice(0, -` by ${artist}`.length);
  return { sc_id: m[1], title, artist, artist_url: j.author_url || '' };
}

let apiLoading = null;
function loadApi() {
  if (!apiLoading) apiLoading = new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = API; s.onload = () => (window.SC && window.SC.Widget ? ok(window.SC) : bad(new Error('нет SC.Widget'))); s.onerror = () => bad(new Error('виджет не загрузился'));
    document.head.append(s);
  });
  return apiLoading;
}
async function byWidget(url, kind) {
  const SC = await loadApi();
  const f = document.createElement('iframe');
  f.title = 'SoundCloud';
  f.hidden = true;
  f.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false`;
  document.body.append(f);
  try {
    const s = await new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error('виджет молчит')), 15000);
      const w = SC.Widget(f);
      w.bind(SC.Widget.Events.READY, () => w.getCurrentSound((x) => { clearTimeout(t); x ? ok(x) : bad(new Error('пусто')); }));
    });
    const parts = new URL(url).pathname.split('/').filter(Boolean), user = s.user || {};
    if (kind === 'set') {
      // номер плейлиста виджет не отдаёт: 0 — витрина возьмёт адрес страницы плейлиста
      const own = user.permalink === parts[0];
      return { sc_id: '0', title: slugTitle(parts[2] || ''), artist: own ? user.username : slugTitle(parts[0]), artist_url: `https://soundcloud.com/${parts[0]}` };
    }
    return { sc_id: String(s.id), title: s.title || '', artist: user.username || '', artist_url: user.permalink_url || '' };
  } finally {
    f.remove();
  }
}

if (form) {
  const note = form.querySelector('.add-note'), btn = form.querySelector('button');
  const say = (t) => { note.textContent = t; };
  form.addEventListener('submit', async (e) => {
    if (form.elements.sc_id.value) return; // подпись уже найдена — отправка как есть
    const url = bare(form.elements.url.value);
    if (!url || !/^https:\/\/soundcloud\.com\/[^/]+\/[^/]+/.test(url)) return; // пусть ответит сервер: адрес не тот
    e.preventDefault();
    const kind = url.includes('/sets/') ? 'set' : 'track';
    btn.disabled = true;
    let got = null;
    try {
      say('спрашиваю SoundCloud…');
      got = await byOembed(url, kind).catch(() => byWidget(url, kind));
    } catch {
      say('SoundCloud не ответил вашему браузеру — пробует сервер');
    }
    if (got && got.title && got.artist) {
      for (const k of ['sc_id', 'title', 'artist', 'artist_url']) form.elements[k].value = got[k];
      form.elements.kind.value = kind;
      say(`нашёл: «${got.title}» — ${got.artist}`);
    }
    form.submit();
  });
}
