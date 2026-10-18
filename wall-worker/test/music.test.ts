import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { normTrackUrl, sc, streamRoute } from '../src/music';
import { BANDS, Ear, bandEdges, bandsOf } from '../public/vitrina/sound.js';
import { csrfOf, get, login, post } from './helpers';
import mig11 from '../migrations/0011-music.sql?raw';

// Музыка витрины: трек выбирает хранитель в /k/music (подпись — по oEmbed), посетитель слышит его только после ▶.
// Поток — /music/stream/{id}: 302 на адрес звука SoundCloud, только с ключом API, только для трека на витрине.

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

const oembed = (title = 'Континуум by Sdominanta', id = '1234567') =>
  Response.json({
    title, author_name: 'Sdominanta', author_url: 'https://soundcloud.com/sdominanta',
    html: `<iframe src="https://w.soundcloud.com/player/?visual=true&url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F${id}&show_artwork=true"></iframe>`,
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
    expect(res.headers.get('Content-Security-Policy')).toContain('media-src https://*.sndcdn.com');
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

  it('плейлист, профиль и чужой домен не принимаются; трек на витрине не убрать, выключить можно', async () => {
    expect(normTrackUrl('https://soundcloud.com/a/sets/b')).toBeNull();
    expect(normTrackUrl('https://soundcloud.com/a/sets')).toBeNull();
    expect(normTrackUrl('https://soundcloud.com/a')).toBeNull();
    expect(normTrackUrl('http://soundcloud.com/a/b')).toBeNull();
    expect(normTrackUrl('https://evil.com/a/b')).toBeNull();
    expect(normTrackUrl('https://m.soundcloud.com/a/b?x=1#t')).toBe('https://soundcloud.com/a/b');
    const { cookie, id } = await addAndChoose();
    expect((await musicForm(cookie, 'add', { url: 'https://soundcloud.com/a/sets/b' })).status).toBe(400);
    expect((await musicForm(cookie, 'remove', { id: String(id) })).status).toBe(409);
    expect((await musicForm(cookie, 'off', {})).status).toBe(200);
    expect(await (await get('/', HTML)).text()).not.toContain('class="music"');
    expect((await musicForm(cookie, 'remove', { id: String(id) })).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM tracks').first('n')).toBe(0);
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

  it('с ключом: токен приложения → streams → адрес звука; браузеру — 302 на sndcdn, токен из кэша', async () => {
    const { id } = await addAndChoose();
    await caches.default.delete('https://sdominanta.net/__cache/sc-token');
    const calls = mock((c) => {
      if (c.url === 'https://secure.soundcloud.com/oauth/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (c.url === 'https://api.soundcloud.com/tracks/1234567/streams') return Response.json({ http_mp3_128_url: 'https://api.soundcloud.com/tracks/soundcloud:tracks:1234567/stream?x=1' });
      if (c.url.startsWith('https://api.soundcloud.com/tracks/soundcloud:tracks:1234567/stream')) return new Response(null, { status: 302, headers: { Location: 'https://cf-media.sndcdn.com/abc.128.mp3?Policy=p&Signature=s' } });
    });
    const res = await streamRoute(keyed, req(), id, 1);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://cf-media.sndcdn.com/abc.128.mp3?Policy=p&Signature=s');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const tokenCall = calls.find((c) => c.url.includes('oauth/token'))!;
    expect((tokenCall.init!.headers as Record<string, string>).Authorization).toBe('Basic ' + btoa('test-id:test-secret'));
    expect(calls.filter((c) => c.url.includes('/streams')).every((c) => (c.init!.headers as Record<string, string>).Authorization === 'OAuth tok')).toBe(true);
    // Второй заход: токен уже в кэше.
    await streamRoute(keyed, req(), id, 2);
    expect(calls.filter((c) => c.url.includes('oauth/token'))).toHaveLength(1);
  });

  it('суточный лимит SoundCloud — ERR LIMIT; адрес не на sndcdn — отказ', async () => {
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
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example/x.mp3' } });
    });
    expect((await streamRoute(keyed, req(), id, 3)).status).toBe(502);
  });

  it('миграция 0011 создаёт таблицу треков', () => {
    expect(mig11).toContain('CREATE TABLE tracks');
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
