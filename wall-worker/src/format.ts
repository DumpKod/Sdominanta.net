// Слой совместимости: одно ядро — текстовые страницы стены и ответы /a — и три формы выдачи.
//   по умолчанию     минимальный HTML: текст в <pre>, ссылки <a href>, без скриптов (читает любой инструмент)
//   /m/… или Accept: text/markdown   markdown как есть
//   /json/…          те же данные структурой
// Маршруты отдают markdown или text/plain; форма выбирается здесь, после маршрута, поэтому кэш страниц один на все формы.

export type Format = 'html' | 'md' | 'json';

const PREFIX: Record<string, Format> = { m: 'md', json: 'json' };

/** Форма по префиксу пути или Accept; запрос без префикса. */
export function pickFormat(req: Request): { fmt: Format; prefixed: boolean; req: Request } {
  const url = new URL(req.url);
  const m = /^\/(m|json)(\/.*)?$/.exec(url.pathname);
  if (m) {
    url.pathname = m[2] || '/';
    return { fmt: PREFIX[m[1]], prefixed: true, req: new Request(url.toString(), req) };
  }
  const accept = (req.headers.get('Accept') ?? '').toLowerCase();
  return { fmt: accept.includes('text/markdown') ? 'md' : 'html', prefixed: false, req };
}

/** Адреса, которые всегда в своём формате: соглашения llms.txt и robots.txt, витрина и статические файлы. */
const NATIVE = new Set(['/robots.txt', '/llms.txt']);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const URL_RE = /https?:\/\/[^\s<>()\[\]`"']+[^\s<>()\[\]`"'.,;:!?»]/g;
const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Строка текста → HTML: [метка](адрес) становится «метка: адрес», каждый адрес — ссылка, адрес остаётся виден текстом. */
function htmlLine(line: string): string {
  const parts: string[] = [];
  let last = 0;
  const text = line.replace(MD_LINK, (_, label: string, href: string) => `${label}: ${href}`);
  for (const m of text.matchAll(URL_RE)) {
    parts.push(esc(text.slice(last, m.index)), `<a href="${esc(m[0])}">${esc(m[0])}</a>`);
    last = m.index! + m[0].length;
  }
  parts.push(esc(text.slice(last)));
  return parts.join('');
}

function title(text: string): string {
  const h = /^# (.+)$/m.exec(text)?.[1] ?? text.split('\n').find((l) => l.trim()) ?? 'Sdominanta';
  return h.trim().slice(0, 120);
}

/** Текст для <pre>: экранирован, адреса — ссылки. */
export const htmlText = (text: string) => text.split('\n').map(htmlLine).join('\n');

export function toHtml(text: string): string {
  return (
    '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${esc(title(text))}</title>\n</head>\n<body>\n<pre style="white-space: pre-wrap">\n` +
    htmlText(text) +
    '\n</pre>\n</body>\n</html>\n'
  );
}

const FIELD = /^([A-Z][A-Z0-9_-]*(?: [A-Z0-9_-]+)*|[А-ЯЁ][А-ЯЁ0-9 ]*[А-ЯЁ0-9]): (.+)$/;
const RECORD_START = /^--- ЗАПИСЬ ⟦/;
const RECORD_END = /^--- КОНЕЦ ЗАПИСИ ⟦/;

/**
 * Те же данные структурой: первая строка OK/ERR, поля «КЛЮЧ: значение» в начале строки, ссылки, весь текст.
 * Строки внутри записей авторов в поля не попадают: автор не может подделать NEXT: или CODE:.
 */
export function toJson(text: string, status: number): string {
  const lines = text.split('\n');
  const fields: Record<string, string> = {};
  const notes: string[] = [];
  let inRecord = false;
  for (const l of lines) {
    if (RECORD_START.test(l)) inRecord = true;
    else if (RECORD_END.test(l)) inRecord = false;
    else if (!inRecord) {
      const f = FIELD.exec(l);
      if (f && !(f[1] in fields)) fields[f[1]] = f[2].trim();
      else if (/^- /.test(l) && /^(OK|ERR)\b/.test(lines[0])) notes.push(l.slice(2));
    }
  }
  const head = lines[0] ?? '';
  const links = [...text.matchAll(MD_LINK)].map((m) => ({ label: m[1], href: m[2] }));
  const out = {
    status,
    ok: /^OK\b/.test(head) ? true : /^ERR\b/.test(head) ? false : null,
    head: /^(OK|ERR)\b/.test(head) ? head : null,
    title: /^# /.test(head) ? head.slice(2) : null,
    fields,
    notes,
    links,
    text,
  };
  return JSON.stringify(out, null, 1) + '\n';
}

const isText = (res: Response) => /^text\/(markdown|plain)/.test(res.headers.get('Content-Type') ?? '');

/** Ответ маршрута → выбранная форма. Ссылки на свои страницы в /m/ и /json/ сохраняют префикс. */
export async function present(res: Response, fmt: Format, prefixed: boolean, origin: string, path: string, method: string): Promise<Response> {
  if (!isText(res) || (NATIVE.has(path) && !prefixed)) return res;
  let text = await res.text();
  if (prefixed) text = text.split(origin + '/').join(`${origin}/${fmt === 'md' ? 'm' : 'json'}/`);
  const h = new Headers(res.headers);
  if (!/\bAccept\b/.test(h.get('Vary') ?? '')) h.set('Vary', [h.get('Vary'), 'Accept'].filter(Boolean).join(', '));
  let body: string;
  if (fmt === 'md') {
    body = text;
  } else if (fmt === 'json') {
    body = toJson(text, res.status);
    h.set('Content-Type', 'application/json; charset=utf-8');
  } else {
    body = toHtml(text);
    h.set('Content-Type', 'text/html; charset=utf-8');
    h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  }
  // Длина явно: часть загрузчиков хуже переносит ответы без Content-Length.
  h.set('Content-Length', String(new TextEncoder().encode(body).length));
  return new Response(method === 'HEAD' ? null : body, { status: res.status, headers: h });
}
