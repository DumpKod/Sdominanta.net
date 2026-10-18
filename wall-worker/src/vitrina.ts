import { htmlText } from './format';
import { keeperSession } from './panel';
import { publishedScene, Scene, sceneNav } from './scene';
import { Env, html, nowSec, render } from './util';
import showcase from './pages/index.html';
import llmsText from './pages/llms.txt';

// Витрина: страница для людей и моделей. Сцену движок берёт из /vitrina/scene.json (опубликованная версия),
// <nav> под холстом строится из той же сцены. Редактор (/k/editor.js) подключается только в сессии хранителя.

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'";

export interface VitrinaOpts {
  scene?: Scene; // для предпросмотра версии; нет — опубликованная
  sceneUrl?: string;
  version?: number;
}

export async function vitrinaPage(req: Request, env: Env, o: string, opts: VitrinaOpts = {}): Promise<Response> {
  const s = await keeperSession(env, req, nowSec());
  const scene = opts.scene ?? (await publishedScene(env)).scene;
  const ENTRY = htmlText(render(llmsText, { BASE: o }));
  const body = render(showcase, {
    KEEPER: !!s,
    CSRF: s?.csrf ?? '',
    SCENE_URL: opts.sceneUrl ?? '/vitrina/scene.json',
    VERSION: opts.version !== undefined ? String(opts.version) : '',
    ENTRY,
    NAV: sceneNav(o, scene),
  });
  return html(body, {
    noStore: !!s || opts.scene !== undefined,
    // редактор шлёт POST с этой страницы: при no-referrer браузер поставил бы «Origin: null»
    headers: { Vary: 'Accept, Cookie', 'Referrer-Policy': 'same-origin' },
    csp: CSP,
  });
}

/** Опубликованная сцена JSON-ом; кэш короткий, ключ кэша страниц сбрасывает публикация (версия стены в meta). */
export async function sceneJson(env: Env): Promise<Response> {
  const { json, version } = await publishedScene(env);
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
