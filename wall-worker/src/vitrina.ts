import { htmlText } from './format';
import { keeperDoor, keeperSession } from './panel';
import { parentOf, publicScene, publishedScene, Scene, sceneNav } from './scene';
import { nodeParent, visibleNodes, withNodes } from './nodes';
import { publishedDocs } from './docs';
import { currentTrack, hasKey, widgetUrl } from './music';
import { Env, html, inline, md, next, nowSec, render } from './util';
import showcase from './pages/index.html';
import llmsText from './pages/llms.txt';

// Витрина: страница для людей и моделей. Сцену движок берёт из /vitrina/scene.json (опубликованная версия),
// <nav> под холстом строится из той же сцены. Редактор (/k/editor.js) подключается только в сессии хранителя.

// frame-src 'self': разделы панели хранителя открываются виджетами в окнах витрины (только своё происхождение)
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'";
/** С музыкой плеер берёт звук у SoundCloud (только после ▶ посетителя: до этого адрес потока на странице не запрашивается). */
// Музыка: официальный виджет SoundCloud (iframe и его скрипт Widget API — только после ▶) и свой плеер по ключу API (поток с sndcdn).
const SC_WIDGET = 'https://w.soundcloud.com';
const CSP_MUSIC = CSP.replace("script-src 'self'", `script-src 'self' ${SC_WIDGET}`).replace("frame-src 'self'", `frame-src 'self' ${SC_WIDGET}`) + '; media-src https://*.sndcdn.com';
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface VitrinaOpts {
  scene?: Scene; // для предпросмотра версии; нет — опубликованная
  sceneUrl?: string;
  version?: number;
  space?: string; // пространство: main — главная витрина, иначе алеф-нуль /in/{space}
}

/**
 * Сцена пространства, как её видит зритель: опубликованная нарисованная плюс узлы сети (src/nodes.ts).
 * exists — пространство есть (сцена опубликована или есть узел с таким именем); parent — откуда в него входят.
 */
export async function liveScene(env: Env, space: string, keeper: boolean) {
  const pub = await publishedScene(env, space);
  const all = await visibleNodes(env, keeper);
  const scene = space === 'main' ? pub.scene : withNodes(pub.scene, all, space, keeper, await publishedDocs(env));
  const parent = space === 'main' ? null : nodeParent(all, space) ?? (await parentOf(env, space));
  return { scene, version: pub.version, exists: space === 'main' || !!pub.version || scene !== pub.scene, parent };
}

/** Адрес сцены пространства для движка. */
export const sceneUrlOf = (space: string) => (space === 'main' ? '/vitrina/scene.json' : `/vitrina/scene/${space}.json`);
/** Адрес страницы пространства. */
export const spaceUrl = (space: string) => (space === 'main' ? '/' : `/in/${space}`);

export async function vitrinaPage(req: Request, env: Env, o: string, opts: VitrinaOpts = {}): Promise<Response> {
  const s = await keeperSession(env, req, nowSec());
  const door = s ? null : await keeperDoor(env, req, nowSec());
  const space = opts.space ?? 'main';
  const live = await liveScene(env, space, !!s);
  const scene = opts.scene ?? live.scene;
  const parent = live.parent;
  const ENTRY = htmlText(render(llmsText, { BASE: o }));
  const t = await currentTrack(env);
  const body = render(showcase, {
    KEEPER: !!s,
    CSRF: s?.csrf ?? '',
    DOOR: !!door,
    LOGIN_CSRF: door?.csrf ?? '',
    BACK: spaceUrl(space),
    // хранителю — сцена целиком, с заметками (/k/vitrina/live/…): редактор правит её и не теряет их при сохранении
    SCENE_URL: opts.sceneUrl ?? (s ? `/k/vitrina/live/${space}.json` : sceneUrlOf(space)),
    SPACE: space,
    PARENT: space === 'main' ? '' : parent ? parent.space : 'main',
    FROM: parent ? parent.id : '',
    VERSION: opts.version !== undefined ? String(opts.version) : '',
    ENTRY,
    NAV: sceneNav(o, scene, space === 'main' ? undefined : spaceUrl(parent ? parent.space : 'main')),
    MUSIC: !!t,
    TRACK_ID: t ? String(t.id) : '',
    KEY: hasKey(env) ? '1' : '0',
    TRACK_KIND: t ? t.kind : '',
    TRACK_SC: t ? String(t.sc_id) : '',
    TRACK_BANDS: t && (await env.DB.prepare('SELECT 1 AS x FROM track_bands WHERE sc_id = ?').bind(t.sc_id).first()) ? '1' : '0',
    WIDGET_URL: t ? widgetUrl(t) : '',
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
  const { scene, version, exists, parent } = await liveScene(env, space, false);
  // Неопубликованное пространство — 404: гость упирается (холст вздрагивает), хранитель входит в пустое и рисует.
  if (!exists) return new Response(JSON.stringify({ error: 'NO_SPACE' }), { status: 404, headers: jsonResponse('', { noStore: true }).headers });
  return jsonResponse(sceneOut(publicScene(scene), space, parent), { maxAge: 30, version });
}

/** JSON сцены для движка; up — пространство уровнем выше (движку при выходе наружу без перезагрузки). */
export function sceneOut(scene: Scene, space: string, parent: { space: string } | null): string {
  return JSON.stringify(space === 'main' ? scene : { ...scene, up: parent ? parent.space : 'main' });
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
  const keeper = !!(await keeperSession(env, req, nowSec()));
  const pub = await liveScene(env, space, keeper);
  const parent = pub.parent;
  if (!pub.exists && !parent && !keeper) return null;
  if (fmt === 'html') return vitrinaPage(req, env, o, { space });
  const back = spaceUrl(parent ? parent.space : 'main');
  const lines = pub.scene.objects.filter((x) => x.href || x.inner || x.window || x.doors || x.widget).map((x) => {
    const href = x.inner ? `/in/${x.inner}` : x.href;
    const w = x.window;
    let s = href ? `- [${inline(x.label)}](${o}${href})` : `- ${inline(x.label)}`;
    if (w?.title) s += `\n  ${inline(w.title)}`;
    if (w?.text) s += `\n  ${inline(w.text, 4000)}`;
    for (const l of w?.links ?? []) s += `\n  - [${inline(l.label)}](${o}${l.href})`;
    for (const d of x.doors ?? []) {
      const dh = d.inner ? `/in/${d.inner}` : d.href, label = inline(d.label || d.window?.title || x.label);
      s += dh ? `\n  - [${label}](${o}${dh})` : `\n  - ${label}`;
      if (d.window?.text) s += `\n    ${inline(d.window.text, 4000)}`;
    }
    return s;
  });
  const title = `Пространство ${space}`;
  return md(`# ${title}\n\n${lines.join('\n') || 'Пока пусто.'}\n` + next([['Наружу', o + back], ['Вход для моделей', `${o}/llms.txt`]]), { maxAge: 60 });
}
