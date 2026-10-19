import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { normTrackUrl, parsePlaylist, sc, streamRoute } from '../src/music';
import { segmentAt, segmentStart } from '../public/vitrina/stream.js';
import { BANDS, Clock, Ear, LEAD, bandEdges, bandsOf } from '../public/vitrina/sound.js';
import { bandsAt, packBands, spectrumOf, unpackBands } from '../public/vitrina/spectrum.js';
import { csrfOf, get, login, post } from './helpers';
import mig11 from '../migrations/0011-music.sql?raw';
import mig16 from '../migrations/0016-track-bands.sql?raw';

// Музыка витрины: трек выбирает хранитель в /k/music (подпись — по oEmbed), посетитель слышит его только после ▶.
// Поток — /music/stream/{id}: адреса кусков HLS у CDN SoundCloud, только с ключом API, только для трека на витрине.

const HTML = { Accept: 'text/html' };
const TRACK = 'https://soundcloud.com/sdominanta/kontinuum';
const real = sc.send;
afterEach(() => { sc.send = real; });

type Call = { url: string; init?: RequestInit };
function mock(routes: (c: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  sc.send = async (url, init) => {
    calls.push({ url, init });
    const r = routes({ url, init });
    if (!r) throw new Error('нет ответа для ' + url);
    return r;
  };
  return calls;
}

const oembed = (title = 'Континуум by Sdominanta', id = '1234567', what = 'tracks') =>
  Response.json({
    title, author_name: 'Sdominanta', author_url: 'https://soundcloud.com/sdominanta',
    html: `<iframe src="https://w.soundcloud.com/player/?visual=true&url=https%3A%2F%2Fapi.soundcloud.com%2F${what}%2F${id}&show_artwork=true"></iframe>`,
  });

async function musicForm(cookie: string, action: string, data: Record<string, string>): Promise<Response> {
  const csrf = csrfOf(await (await get('/k/music', { Cookie: cookie })).text());
  return post(`/k/music/${action}`, { csrf, ...data }, cookie);
}

async function addAndChoose(title?: string): Promise<{ cookie: string; id: number }> {
  const { cookie } = await login();
  mock((c) => (c.url.startsWith('https://soundcloud.com/oembed') ? oembed(title) : undefined));
  expect((await musicForm(cookie, 'add', { url: TRACK + '?si=abc&utm_source=x' })).status).toBe(200);
  const row = await env.DB.prepare('SELECT * FROM tracks').first<{ id: number; url: string; sc_id: number; title: string }>();
  expect(row).toMatchObject({ url: TRACK, sc_id: 1234567 });
  expect((await musicForm(cookie, 'choose', { id: String(row!.id) })).status).toBe(200);
  return { cookie, id: row!.id };
}

const keyed = { ...env, SC_CLIENT_ID: 'test-id', SC_CLIENT_SECRET: 'test-secret' };
const req = () => new Request('https://sdominanta.net/music/stream/1', { headers: { 'CF-Connecting-IP': '10.9.9.' + Math.floor(Math.random() * 250) } });

describe('Музыка: админка и витрина', () => {
  it('без выбранного трека витрина тихая: ни плеера, ни media-src', async () => {
    const res = await get('/', HTML);
    const page = await res.text();
    expect(page).not.toContain('class="music"');
    expect(page).not.toContain('/vitrina/music.js');
    expect(res.headers.get('Content-Security-Policy')).not.toContain('media-src');
  });

  it('хранитель добавляет трек по адресу, выбирает его — на витрине подпись, ссылки и ▶, звук не запрашивается', async () => {
    await addAndChoose();
    const res = await get('/', HTML);
    const page = await res.text();
    expect(page).toContain('<aside class="music" data-slot="player" data-stream="/music/stream/');
    expect(page).toContain(`«<a href="${TRACK}" rel="noopener noreferrer">Континуум</a>» — <a href="https://soundcloud.com/sdominanta" rel="noopener noreferrer">Sdominanta</a>`);
    expect(page).toContain('<script type="module" src="/vitrina/music.js"></script>');
    expect(page).toContain('data-key="0"');
    // Без ключа свой плеер невозможен: ни fetch к CDN SoundCloud, ни blob: для звука.
    expect(res.headers.get('Content-Security-Policy')).not.toMatch(/media-src|connect-src[^;]*soundcloud|sndcdn/);
    // До нажатия на странице нет ничего, что браузер загрузил бы с SoundCloud: только ссылки <a>.
    expect(page).not.toMatch(/<(iframe|img|audio|video|source|link|script)[^>]+soundcloud/i);
    expect(page).not.toContain('sndcdn');
  });

  it('подпись из oEmbed экранируется', async () => {
    await addAndChoose('<script>alert(1)</script>" by Sdominanta');
    const page = await (await get('/', HTML)).text();
    expect(page).not.toContain('<script>alert(1)');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;');
  });

  it('профиль и чужой домен не принимаются, плейлист принимается; трек на витрине не убрать, выключить можно', async () => {
    expect(normTrackUrl('https://soundcloud.com/a/sets/b?si=1')).toBe('https://soundcloud.com/a/sets/b');
    expect(normTrackUrl('https://soundcloud.com/a/sets')).toBeNull();
    expect(normTrackUrl('https://soundcloud.com/a/b/c')).toBeNull();
    expect(normTrackUrl('https://soundcloud.com/a')).toBeNull();
    expect(normTrackUrl('http://soundcloud.com/a/b')).toBeNull();
    expect(normTrackUrl('https://evil.com/a/b')).toBeNull();
    expect(normTrackUrl('https://m.soundcloud.com/a/b?x=1#t')).toBe('https://soundcloud.com/a/b');
    const { cookie, id } = await addAndChoose();
    expect((await musicForm(cookie, 'add', { url: 'https://soundcloud.com/a' })).status).toBe(400);
    expect((await musicForm(cookie, 'remove', { id: String(id) })).status).toBe(409);
    expect((await musicForm(cookie, 'off', {})).status).toBe(200);
    expect(await (await get('/', HTML)).text()).not.toContain('class="music"');
    expect((await musicForm(cookie, 'remove', { id: String(id) })).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM tracks').first('n')).toBe(0);
  });

  it('плейлист: виджет по адресу playlists, свой плеер для него закрыт; до ▶ к SoundCloud ничего не грузится', async () => {
    const { cookie } = await login();
    mock((c) => (c.url.startsWith('https://soundcloud.com/oembed') ? oembed('Ноль by Sdominanta', '777', 'playlists') : undefined));
    expect((await musicForm(cookie, 'add', { url: 'https://soundcloud.com/sdominanta/sets/nol' })).status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM tracks').first<{ id: number; sc_id: number; kind: string }>();
    expect(row).toMatchObject({ sc_id: 777, kind: 'set' });
    // oEmbed трека по адресу плейлиста — не плейлист.
    mock((c) => (c.url.startsWith('https://soundcloud.com/oembed') ? oembed('X by Y', '5') : undefined));
    expect((await musicForm(cookie, 'add', { url: 'https://soundcloud.com/sdominanta/sets/x' })).status).toBe(400);
    expect((await musicForm(cookie, 'choose', { id: String(row!.id) })).status).toBe(200);
    const res = await get('/', HTML);
    const page = await res.text();
    expect(page).toContain('data-kind="set" data-sc="777" data-bands="0" data-widget="https://api.soundcloud.com/playlists/777"');
    expect(page).not.toMatch(/<(iframe|img|audio|video|source|link|script)[^>]+soundcloud/i);
    const csp = res.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("script-src 'self' https://w.soundcloud.com");
    expect(csp).toContain("frame-src 'self' https://w.soundcloud.com");
    expect(csp).not.toMatch(/connect-src[^;]*soundcloud/);
    expect((await get(`/music/stream/${row!.id}`)).status).toBe(404);
  });

  it('без сессии хранителя /k/music закрыт', async () => {
    expect((await get('/k/music')).status).toBe(403);
  });
});

describe('Музыка: поток', () => {
  it('без ключа — ERR NO_KEY; чужой номер — NO_TRACK; запросов к SoundCloud нет', async () => {
    const { id } = await addAndChoose();
    const calls = mock(() => undefined);
    const res = await get(`/music/stream/${id}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'NO_KEY' });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect((await get(`/music/stream/${id + 1}`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  const M3U = (host = 'https://playback.media-streaming.soundcloud.cloud') => [
    '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${host}/a/aac_160k/init.mp4?Policy=p&Key-Pair-Id=k"`,
    '#EXTINF:9.98,', `${host}/a/aac_160k/data001.m4s?expires=1&Policy=p&Key-Pair-Id=k`,
    '#EXTINF:10.0,', 'data002.m4s?expires=1&Policy=p&Key-Pair-Id=k',
    '#EXTINF:4.5,', `${host}/a/aac_160k/data003.m4s?expires=1&Policy=p&Key-Pair-Id=k`,
    '#EXT-X-ENDLIST', '',
  ].join('\n');
  const PL = 'https://playback.media-streaming.soundcloud.cloud/a/aac_160k/playlist.m3u8?Policy=p';

  it('плейлист HLS: начало и куски, относительные адреса — от плейлиста; чужие хосты, варианты и шифрование — отказ', () => {
    const p = parsePlaylist(M3U(), PL)!;
    expect(p.map).toBe('https://playback.media-streaming.soundcloud.cloud/a/aac_160k/init.mp4?Policy=p&Key-Pair-Id=k');
    expect(p.segments.map(([, d]) => d)).toEqual([9.98, 10, 4.5]);
    expect(p.segments[1][0]).toBe('https://playback.media-streaming.soundcloud.cloud/a/aac_160k/data002.m4s?expires=1&Policy=p&Key-Pair-Id=k');
    expect(parsePlaylist(M3U('https://evil.example'), PL)).toBeNull();
    expect(parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', PL)).toBeNull();
    expect(parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:1,\na.ts\n', PL)).toBeNull();
    expect(parsePlaylist('<html>', PL)).toBeNull();
    // mp3 HLS без EXT-X-MAP: куски на sndcdn.
    const mp3 = parsePlaylist('#EXTM3U\n#EXTINF:1.0,\nhttps://cf-hls-media.sndcdn.com/media/0/1/x.128.mp3?Policy=p\n#EXT-X-ENDLIST\n', PL)!;
    expect(mp3).toEqual({ map: null, segments: [['https://cf-hls-media.sndcdn.com/media/0/1/x.128.mp3?Policy=p', 1]] });
  });

  it('синхрон: часы виджета идут сами и подтягиваются без рывков, прыжок — на перемотке, без сообщений встают', () => {
    const c = new Clock();
    c.set(1000, 0, true);
    expect(c.now(100)).toBe(1100);
    c.report(1080, 100); // сообщение опоздало на 20 мс: часы не прыгают назад, а подтягиваются на четверть
    expect(c.now(100)).toBe(1095);
    c.report(5000, 200); // перемотка
    expect(c.now(200)).toBe(5000);
    expect(c.now(200 + 5000)).toBe(5000 + Clock.HOLD);
    c.set(7000, 300, false);
    expect(c.now(900)).toBe(7000);
  });

  it('синхрон: ухо отстаёт от шага меньше, чем опережение LEAD', () => {    // Шаг громкости: через сколько ухо доходит до половины (кадры по 1/60 с).
    const ear = new Ear(BANDS), ones = new Float32Array(BANDS).fill(1);
    ear.update(ones, 1 / 60);
    expect(ear.beat).toBe(1); // удар — в тот же кадр
    let t = 1 / 60;
    while (ear.level < 0.5) { ear.update(ones, 1 / 60); t += 1 / 60; }
    expect(t).toBeLessThanOrEqual(LEAD);
  });

  it('куски по времени: перемотка и луп находят нужный кусок', () => {
    const segs: [string, number][] = [['a', 10], ['b', 10], ['c', 4.5]];
    expect([0, 9.99, 10, 19.9, 20, 24.4, 99].map((t) => segmentAt(segs, t))).toEqual([0, 0, 1, 1, 2, 2, 2]);
    expect(segmentStart(segs, 2)).toBe(20);
  });

  it('с ключом: токен приложения → streams (AAC HLS) → плейлист; браузеру — адреса кусков, токен из кэша; витрина пускает к CDN', async () => {
    const { id } = await addAndChoose();
    await caches.default.delete('https://sdominanta.net/__cache/sc-token');
    const calls = mock((c) => {
      if (c.url === 'https://secure.soundcloud.com/oauth/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (c.url === 'https://api.soundcloud.com/tracks/1234567/streams') {
        return Response.json({
          http_mp3_128_url: 'https://api.soundcloud.com/tracks/soundcloud:tracks:1234567/stream',
          hls_mp3_128_url: 'https://api.soundcloud.com/tracks/soundcloud:tracks:1234567/streams/hls/mp3',
          hls_aac_160_url: 'https://api.soundcloud.com/tracks/soundcloud:tracks:1234567/streams/hls?x=1',
        });
      }
      if (c.url.startsWith('https://api.soundcloud.com/tracks/soundcloud:tracks:1234567/streams/hls?')) return new Response(null, { status: 302, headers: { Location: PL } });
      if (c.url === PL) return new Response(M3U());
    });
    const res = await streamRoute(keyed, req(), id, 1);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const j = (await res.json()) as { mime: string; map: string; segments: [string, number][]; duration: number };
    expect(j.mime).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(j.segments).toHaveLength(3);
    expect(j.duration).toBe(24.48);
    const tokenCall = calls.find((c) => c.url.includes('oauth/token'))!;
    expect((tokenCall.init!.headers as Record<string, string>).Authorization).toBe('Basic ' + btoa('test-id:test-secret'));
    expect(calls.filter((c) => c.url.includes('/streams')).every((c) => (c.init!.headers as Record<string, string>).Authorization === 'OAuth tok')).toBe(true);
    // Ключ к CDN не уходит.
    expect(calls.find((c) => c.url === PL)!.init!.headers).toBeUndefined();
    // Второй заход: токен уже в кэше.
    await streamRoute(keyed, req(), id, 2);
    expect(calls.filter((c) => c.url.includes('oauth/token'))).toHaveLength(1);
  });

  it('суточный лимит SoundCloud — ERR LIMIT; только прогрессивный mp3 или адрес не на CDN — отказ', async () => {
    const { id } = await addAndChoose();
    await caches.default.delete('https://sdominanta.net/__cache/sc-token');
    mock((c) => {
      if (c.url.includes('oauth/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (c.url.endsWith('/streams')) return new Response('{}', { status: 429 });
    });
    const lim = await streamRoute(keyed, req(), id, 1);
    expect(lim.status).toBe(503);
    expect(await lim.json()).toMatchObject({ error: 'LIMIT' });
    mock((c) => {
      if (c.url.includes('oauth/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (c.url.endsWith('/streams')) return Response.json({ http_mp3_128_url: 'https://api.soundcloud.com/tracks/1/stream' });
    });
    expect(await (await streamRoute(keyed, req(), id, 2)).json()).toMatchObject({ error: 'STREAM' });
    mock((c) => {
      if (c.url.includes('oauth/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (c.url.endsWith('/streams')) return Response.json({ hls_aac_160_url: 'https://api.soundcloud.com/tracks/1/streams/hls' });
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example/x.m3u8' } });
    });
    expect((await streamRoute(keyed, req(), id, 3)).status).toBe(502);
  });

  it('ключ внесён и спектра нет — витрина пускает fetch к CDN SoundCloud и blob: для звука', async () => {
    await addAndChoose();
    const { default: worker } = await import('../src/index');
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request('https://sdominanta.net/', { headers: HTML }), keyed as never, ctx);
    const csp = res.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("connect-src 'self' https://*.sndcdn.com https://*.soundcloud.cloud");
    expect(csp).toContain('media-src blob:');
    expect(await res.text()).toContain('data-key="1"');
  });

  it('миграция 0011 создаёт таблицу треков', () => {
    expect(mig11).toContain('CREATE TABLE tracks');
  });
});

const sine = (hz: number, sec: number, sr = 44100) => Float32Array.from({ length: sr * sec }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / sr));
const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('Спектр трека для виджета', () => {
  it('спектр синуса 1 кГц — пик в полосе с 1 кГц; за концом трека — тишина; файл SDB1 туда и обратно', () => {
    const s = spectrumOf(sine(1000, 2), 44100);
    expect(s).toMatchObject({ fps: 60, bands: BANDS, frames: 120, durationMs: 2000 });
    const out = new Float32Array(BANDS);
    bandsAt(s, 1000, out);
    const top = out.indexOf(Math.max(...out));
    const e = bandEdges(BANDS, 44100, 2048), hz = 44100 / 2048;
    expect(e[top] * hz).toBeLessThanOrEqual(1000);
    expect(e[top + 1] * hz).toBeGreaterThan(1000);
    expect(out[0]).toBe(0);
    expect(bandsAt(s, 2100, out)).toBeNull();
    const u = unpackBands(packBands(s))!;
    expect(u).toMatchObject({ fps: 60, bands: BANDS, frames: 120, durationMs: 2000 });
    expect([...u.data]).toEqual([...s.data]);
    expect(unpackBands(new Uint8Array(20))).toBeNull();
  });

  it('хранитель сохраняет спектр трека; витрина берёт его по номеру SoundCloud; плохие данные — отказ', async () => {
    const { cookie, id } = await addAndChoose();
    const page = await (await get('/k/music', { Cookie: cookie })).text();
    expect(page).toContain('<script type="module" src="/vitrina/bands-k.js"></script>');
    // Поле файла без имени: аудиофайл в форму не уходит, только полосы.
    expect(page).toMatch(/<input type="file" accept="audio\/\*" class="bands-file"(?![^>]*name=)/);
    expect((await get('/k/music', { Cookie: cookie })).headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect((await get('/music/bands/1234567')).status).toBe(404);

    const s = spectrumOf(sine(200, 3), 44100);
    const send = (o: Record<string, string> = {}) =>
      musicForm(cookie, 'bands', { id: String(id), fps: String(s.fps), bands: String(s.bands), frames: String(s.frames), duration: String(s.durationMs), data: b64url(s.data), ...o });
    expect((await send({ frames: String(s.frames + 1) })).status).toBe(400);
    expect((await send({ duration: '9000' })).status).toBe(400);
    expect((await send({ data: '' })).status).toBe(400);
    expect((await send({ data: 'не base64' })).status).toBe(400);
    expect((await send({ id: '99999' })).status).toBe(404);
    const ok = await send();
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Спектр сохранён');
    // Пересчёт заменяет, а не дописывает.
    expect((await send()).status).toBe(200);

    const res = await get('/music/bands/1234567');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    const u = unpackBands(await res.arrayBuffer())!;
    expect(u).toMatchObject({ fps: 60, bands: BANDS, frames: s.frames, durationMs: 3000 });
    expect([...u.data]).toEqual([...s.data]);
    expect(await (await get('/', HTML)).text()).toContain('data-bands="1"');

    // Убрать трек — уходит и спектр.
    expect((await musicForm(cookie, 'off', {})).status).toBe(200);
    expect((await musicForm(cookie, 'remove', { id: String(id) })).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM track_band_chunks').first('n')).toBe(0);
    expect((await get('/music/bands/1234567')).status).toBe(404);
  });

  it('длинный спектр лежит кусками и собирается целиком', async () => {
    const { cookie, id } = await addAndChoose();
    const frames = 3000, data = Uint8Array.from({ length: frames * BANDS }, (_, i) => (i * 7) % 256);
    const csrf = csrfOf(await (await get('/k/music', { Cookie: cookie })).text());
    const r = await post('/k/music/bands', { csrf, id: String(id), fps: '30', bands: String(BANDS), frames: String(frames), duration: '100000', data: b64url(data) }, cookie);
    expect(r.status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM track_band_chunks').first('n')).toBe(3);
    const u = unpackBands(await (await get('/music/bands/1234567')).arrayBuffer())!;
    expect(u.frames).toBe(frames);
    expect(u.data.every((v: number, i: number) => v === (i * 7) % 256)).toBe(true);
  });

  it('миграция 0016: вид трека и спектр кусками', () => {
    expect(mig16).toContain('ALTER TABLE tracks ADD COLUMN kind');
    expect(mig16).toContain('CREATE TABLE track_band_chunks');
  });
});

describe('Слух холста (sound.js)', () => {
  it('полосы логарифмические, растут, не пустые', () => {
    const e = bandEdges(BANDS, 48000, 2048);
    expect(e.length).toBe(BANDS + 1);
    for (let k = 1; k <= BANDS; k++) expect(e[k]).toBeGreaterThan(e[k - 1]);
    expect(e[BANDS]).toBeLessThanOrEqual(1024);
  });

  it('спектр → полосы 0..1; басы громче — low больше high; всплеск басов — удар', () => {
    const e = bandEdges(BANDS, 48000, 2048);
    const bytes = new Uint8Array(1024);
    const out = new Float32Array(BANDS);
    const ear = new Ear(BANDS);
    for (let i = 0; i < 30; i++) ear.update(bandsOf(bytes, e, out), 1 / 60);
    expect(ear.beat).toBeLessThan(0.01);
    bytes.fill(255, 0, e[6]);
    bandsOf(bytes, e, out);
    expect(out[0]).toBe(1);
    expect(out[BANDS - 1]).toBe(0);
    ear.update(out, 1 / 60);
    expect(ear.beat).toBe(1);
    for (let i = 0; i < 20; i++) ear.update(out, 1 / 60);
    expect(ear.low).toBeGreaterThan(ear.high);
    for (let i = 0; i < 60; i++) ear.quiet(1 / 60);
    expect(ear.level).toBeLessThan(0.05);
    expect(ear.on).toBe(false);
  });
});
