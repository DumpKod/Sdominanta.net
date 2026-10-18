import { htmlText } from './format';
import { keeperDoor, keeperSession } from './panel';
import { parentOf, publishedScene, Scene, sceneNav } from './scene';
import { currentTrack, hasKey } from './music';
import { Env, html, inline, md, next, nowSec, render } from './util';
import showcase from './pages/index.html';
import llmsText from './pages/llms.txt';

// Витрина: страница для людей и моделей. Сцену движок берёт из /vitrina/scene.json (опубликованная версия),
// <nav> под холстом строится из той же сцены. Редактор (/k/editor.js) подключается только в сессии хранителя.

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'";
/** С музыкой плеер берёт звук у SoundCloud (только после ▶ посетителя: до этого адрес потока на странице не запрашивается). */
const CSP_MUSIC = CSP + '; media-src https://*.sndcdn.com';
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface VitrinaOpts {
  scene?: Scene; // для предпросмотра версии; нет — опубликованная
  sceneUrl?: string;
  version?: number;
  space?: string; // пространство: main — главная витрина, иначе алеф-нуль /in/{space}
}

/** Адрес сцены пространства для движка. */
export const sceneUrlOf = (space: string) => (space === 'main' ? '/vitrina/scene.json' : `/vitrina/scene/${space}.json`);
/** Адрес страницы пространства. */
export const spaceUrl = (space: string) => (space === 'main' ? '/' : `/in/${space}`);

export async function vitrinaPage(req: Request, env: Env, o: string, opts: VitrinaOpts = {}): Promise<Response> {
  const s = await keeperSession(env, req, nowSec());
  const door = s ? null : await keeperDoor(env, req, nowSec());
  const space = opts.space ?? 'main';
  const scene = opts.scene ?? (await publishedScene(env, space)).scene;
  const parent = space === 'main' ? null : await parentOf(env, space);
  const ENTRY = htmlText(render(llmsText, { BASE: o }));
  const t = await currentTrack(env);
  const body = render(showcase, {
    KEEPER: !!s,
    CSRF: s?.csrf ?? '',
    DOOR: !!door,
    LOGIN_CSRF: door?.csrf ?? '',
    BACK: spaceUrl(space),
    SCENE_URL: opts.sceneUrl ?? sceneUrlOf(space),
    SPACE: space,
    PARENT: space === 'main' ? '' : parent ? parent.space : 'main',
    FROM: parent ? parent.id : '',
    VERSION: opts.version !== undefined ? String(opts.version) : '',
    ENTRY,
    NAV: sceneNav(o, scene, space === 'main' ? undefined : spaceUrl(parent ? parent.space : 'main')),
    MUSIC: !!t,
    TRACK_ID: t ? String(t.id) : '',
    KEY: hasKey(env) ? '1' : '0',
    TRACK_URL: t ? attr(t.url) : '',
    TRACK_TITLE: t ? attr(t.title) : '',
    ARTIST_URL: t ? attr(t.artist_url) : '',
    ARTIST: t ? attr(t.artist) : '',
  });
  return html(body, {
    noStore: !!s || !!door || opts.scene !== undefined,
    // редактор шлёт POST с этой страницы: при no-referrer браузер поставил бы «Origin: null»
    headers: { Vary: 'Accept, Cookie', 'Referrer-Policy': 'same-origin' },
    csp: t ? CSP_MUSIC : CSP,
  });
}

/** Опубликованная сцена JSON-ом; кэш короткий, ключ кэша страниц сбрасывает публикация (версия стены в meta). */
export async function sceneJson(env: Env, space = 'main'): Promise<Response> {
  const { json, version } = await publishedScene(env, space);
  // Неопубликованное пространство — 404: гость упирается (холст вздрагивает), хранитель входит в пустое и рисует.
  if (space !== 'main' && !version) return new Response(JSON.stringify({ error: 'NO_SPACE' }), { status: 404, headers: jsonResponse('', { noStore: true }).headers });
  return jsonResponse(json, { maxAge: 30, version });
}

export function jsonResponse(json: string, o: { maxAge?: number; version?: number; noStore?: boolean } = {}): Response {
  const h = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': o.noStore ? 'no-store' : `public, max-age=${o.maxAge ?? 30}`,
  });
  if (o.version !== undefined) h.set('X-Scene-Version', String(o.version));
  return new Response(json, { headers: h });
}

/**
 * /in/{space} — алеф-нуль. Людям — витрина этого пространства (движок входит туда же изнутри объекта, без перезагрузки),
 * моделям (markdown, JSON) — подписи и ссылки его объектов текстом. Пространство есть, если оно опубликовано
 * или на него указывает объект опубликованной сцены; хранитель в сессии открывает и пустое — чтобы нарисовать.
 */
export async function spacePage(req: Request, env: Env, o: string, space: string, fmt: string): Promise<Response | null> {
  const pub = await publishedScene(env, space);
  const parent = await parentOf(env, space);
  if (!pub.version && !parent && !(await keeperSession(env, req, nowSec()))) return null;
  if (fmt === 'html') return vitrinaPage(req, env, o, { space });
  const back = spaceUrl(parent ? parent.space : 'main');
  const lines = pub.scene.objects.map((x) => {
    const href = x.inner ? `/in/${x.inner}` : x.href;
    const w = x.window;
    let s = href ? `- [${inline(x.label)}](${o}${href})` : `- ${inline(x.label)}`;
    if (w?.title) s += `\n  ${inline(w.title)}`;
    if (w?.text) s += `\n  ${inline(w.text, 4000)}`;
    for (const l of w?.links ?? []) s += `\n  - [${inline(l.label)}](${o}${l.href})`;
    return s;
  });
  const title = `Пространство ${space}`;
  return md(`# ${title}\n\n${lines.join('\n') || 'Пока пусто.'}\n` + next([['Наружу', o + back], ['Вход для моделей', `${o}/llms.txt`]]), { maxAge: 60 });
}
