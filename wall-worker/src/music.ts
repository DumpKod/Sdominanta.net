import { Env, clientIp } from './util';
import { hit } from './rate';

// Музыка витрины: хранитель выбирает трек SoundCloud в /k/music, витрина играет его по кругу после ▶ посетителя.
// Звук не хранится и не проходит через сайт: Worker по ключу API получает адрес потока, браузер берёт звук у SoundCloud сам.
// Один адрес потока — один заход (луп крутит его в плеере), повтор — при перезагрузке страницы.
// До ▶ к SoundCloud не уходит ни одного запроса: подпись трека (название, автор, ссылки) лежит в нашей базе.
// Ключ — Secrets SC_CLIENT_ID и SC_CLIENT_SECRET, их вносит хранитель; без них поток отвечает ERR NO_KEY.

export const SC_API = 'https://api.soundcloud.com';
export const SC_AUTH = 'https://secure.soundcloud.com/oauth/token';
export const SC_OEMBED = 'https://soundcloud.com/oembed';
/** Запросов потока с одного адреса в час: страницу перезагружают, но не сотни раз. */
const STREAM_PER_HOUR = 60;

/** Внешние вызовы — через этот объект: тесты подменяют send. */
export const sc = { send: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init) };

export interface Track {
  id: number;
  url: string;
  sc_id: number;
  title: string;
  artist: string;
  artist_url: string;
  added_at: number;
  by_sign: string;
}

export const hasKey = (env: Env) => !!(env.SC_CLIENT_ID && env.SC_CLIENT_SECRET);

export async function currentTrack(env: Env): Promise<Track | null> {
  return env.DB.prepare(`SELECT t.* FROM tracks t JOIN meta m ON m.k = 'music' AND CAST(m.v AS INTEGER) = t.id`).first<Track>();
}

/** Адрес трека: https://soundcloud.com/{автор}/{трек}, без параметров. Плейлисты (/sets/) и профили не принимаются. */
export function normTrackUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^(www\.|m\.)?soundcloud\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[1] === 'sets' || !parts.every((p) => /^[A-Za-z0-9_-]{1,100}$/.test(p))) return null;
  return `https://soundcloud.com/${parts[0]}/${parts[1]}`;
}

const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Подпись трека по oEmbed SoundCloud (ключ не нужен): название, автор, ссылка на автора, номер трека.
 * Номер — из адреса плеера в ответе (api.soundcloud.com/tracks/N).
 */
export async function resolveTrack(url: string): Promise<Omit<Track, 'id' | 'added_at' | 'by_sign'> | { error: string }> {
  let res: Response;
  try {
    res = await sc.send(`${SC_OEMBED}?format=json&url=${encodeURIComponent(url)}`, { headers: { Accept: 'application/json' } });
  } catch {
    return { error: 'SoundCloud не ответил' };
  }
  if (res.status === 404) return { error: 'трек не найден или закрыт' };
  if (!res.ok) return { error: `SoundCloud ответил ${res.status}` };
  let j: { title?: string; author_name?: string; author_url?: string; html?: string };
  try {
    j = await res.json();
  } catch {
    return { error: 'ответ SoundCloud не разобран' };
  }
  const m = /api\.soundcloud\.com%2Ftracks%2F(\d{1,20})/.exec(j.html ?? '') ?? /api\.soundcloud\.com\/tracks\/(\d{1,20})/.exec(j.html ?? '');
  if (!m) return { error: 'это не трек (плейлист или профиль?)' };
  const artist = clean(j.author_name, 120);
  let title = clean(j.title, 200);
  if (artist && title.endsWith(` by ${artist}`)) title = title.slice(0, -` by ${artist}`.length);
  const artistUrl = normProfile(j.author_url) ?? url.split('/').slice(0, 4).join('/');
  if (!title || !artist) return { error: 'у трека нет названия или автора' };
  return { url, sc_id: Number(m[1]), title, artist, artist_url: artistUrl };
}

function normProfile(raw: unknown): string | null {
  try {
    const u = new URL(String(raw));
    const p = u.pathname.split('/').filter(Boolean);
    return u.protocol === 'https:' && /^(www\.)?soundcloud\.com$/.test(u.hostname) && p.length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(p[0])
      ? `https://soundcloud.com/${p[0]}`
      : null;
  } catch {
    return null;
  }
}

// ---------- ключ и поток ----------

/** Токен приложения (client credentials) живёт в кэше Cloudflare до конца срока, в базу не пишется. */
const TOKEN_CACHE = 'https://sdominanta.net/__cache/sc-token';

async function appToken(env: Env): Promise<string | null> {
  const cache = caches.default;
  const hitRes = await cache.match(TOKEN_CACHE);
  if (hitRes) return hitRes.text();
  const res = await sc.send(SC_AUTH, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.SC_CLIENT_ID}:${env.SC_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  const ttl = Math.max(60, Math.min(3600, (j.expires_in ?? 3600) - 120));
  await cache.put(TOKEN_CACHE, new Response(j.access_token, { headers: { 'Cache-Control': `max-age=${ttl}` } }));
  return j.access_token;
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", ...extra,
    },
  });
/** Отказ: код для плеера и текст для человека (плеер показывает его рядом со ссылкой на трек). */
const err = (code: string, text: string, status: number, extra: Record<string, string> = {}) => json({ error: code, text }, status, extra);

/**
 * GET /music/stream/{id} — только для трека, который сейчас на витрине: это src плеера. Ответ — 302 на адрес звука
 * у SoundCloud (подписанный, временный); браузер идёт туда сам, сайт звук не трогает. Отказ — JSON {error, text}.
 * Плеер ставит src прямо в нажатии ▶: так браузер разрешает звук без второго нажатия.
 */
export async function streamRoute(env: Env, req: Request, id: number, now: number): Promise<Response> {
  const t = await currentTrack(env);
  if (!t || t.id !== id) return err('NO_TRACK', 'Этот трек сейчас не на витрине.', 404);
  if (!hasKey(env)) return err('NO_KEY', 'Ключ API SoundCloud ещё не внесён: трек можно послушать по ссылке на SoundCloud.', 503);
  const rate = await hit(env, 'music', clientIp(req), STREAM_PER_HOUR, now);
  if (!rate.ok) return err('RATE', 'Слишком часто: подождите.', 429, { 'Retry-After': String(rate.retryAfter) });
  try {
    const token = await appToken(env);
    if (!token) return err('KEY', 'SoundCloud не принял ключ.', 502);
    const auth = { Authorization: `OAuth ${token}`, Accept: 'application/json' };
    const s = await sc.send(`${SC_API}/tracks/${t.sc_id}/streams`, { headers: auth });
    if (s.status === 429) return err('LIMIT', 'Суточный лимит потоков SoundCloud исчерпан: трек можно послушать по ссылке.', 503);
    if (!s.ok) return err('STREAM', `SoundCloud не дал поток (${s.status}).`, 502);
    const urls = (await s.json()) as Record<string, string | undefined>;
    const api = urls.http_mp3_128_url;
    if (!api || !api.startsWith(SC_API + '/')) return err('STREAM', 'У трека нет потока mp3 для сторонних плееров.', 502);
    // Адрес потока API требует ключ: Worker спрашивает его сам и отдаёт браузеру только итоговый адрес звука.
    const r = await sc.send(api, { headers: auth, redirect: 'manual' });
    const loc = r.headers.get('Location');
    if (r.status < 300 || r.status >= 400 || !loc || !/^https:\/\/[a-z0-9.-]+\.sndcdn\.com\//.test(loc)) return err('STREAM', 'SoundCloud не дал адрес звука.', 502);
    return new Response(null, { status: 302, headers: { Location: loc, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch {
    return err('STREAM', 'SoundCloud не ответил.', 502);
  }
}
