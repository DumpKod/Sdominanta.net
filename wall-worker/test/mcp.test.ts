import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { card, O } from './helpers';
import { wallPath } from '../src/mcp';

// MCP-дверь: POST /mcp, обе эпохи протокола, пять инструментов поверх того же ядра.

let ipSeq = 0;
let idSeq = 1;
type Rpc = { jsonrpc: string; id: number | null; result?: any; error?: { code: number; message: string; data?: any } };

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return (exports as unknown as { default: Fetcher }).default.fetch(
    new Request(O + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': `10.9.${ipSeq >> 8 & 255}.${ipSeq++ & 255}`, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

/** Прежняя эпоха (2025-11-25): без _meta. */
async function legacy(method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
  const res = await post({ jsonrpc: '2.0', id: idSeq++, method, params }, { 'MCP-Protocol-Version': '2025-11-25' });
  expect(res.headers.get('Content-Type')).toContain('application/json');
  return res.json();
}

/** Эпоха 2026-07-28: версия в _meta и в заголовках. */
function modern(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  const h: Record<string, string> = { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method };
  if (method === 'tools/call') h['Mcp-Name'] = String(params.name);
  return post({ jsonrpc: '2.0', id: idSeq++, method, params: { ...params, _meta } }, { ...h, ...headers });
}

const call = async (name: string, args: Record<string, unknown>) => (await legacy('tools/call', { name, arguments: args })).result;

describe('MCP: протокол', () => {
  it('initialize (прежняя эпоха): версия, возможности, инструкции', async () => {
    const r = await legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.result.serverInfo.name).toBe('sdominanta-wall');
    expect(r.result.instructions).toContain('wall_read');
    const unknown = await legacy('initialize', { protocolVersion: '2099-01-01', capabilities: {} });
    expect(unknown.result.protocolVersion).toBe('2025-11-25');
  });

  it('уведомление — 202 без тела; GET — 405; чужой Origin — 403; OPTIONS — CORS', async () => {
    const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe('');
    const g = await (exports as unknown as { default: Fetcher }).default.fetch(new Request(O + '/mcp', { headers: { Accept: 'text/event-stream' } }));
    expect(g.status).toBe(405);
    expect(g.headers.get('Allow')).toBe('POST, OPTIONS');
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://claude.ai' })).status).toBe(200);
    const o = await (exports as unknown as { default: Fetcher }).default.fetch(new Request(O + '/mcp', { method: 'OPTIONS' }));
    expect(o.status).toBe(204);
    expect(o.headers.get('Access-Control-Allow-Headers')).toContain('Mcp-Method');
  });

  it('разбор и неизвестный метод', async () => {
    const bad = await post('{не json');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Rpc).error!.code).toBe(-32700);
    expect((await legacy('resources/list')).error!.code).toBe(-32601);
    expect((await legacy('tools/call', { name: 'approve', arguments: {} })).error!.code).toBe(-32602);
  });

  it('пакет запросов отвечает массивом', async () => {
    const res = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const r = (await res.json()) as Rpc[];
    expect(r.map((x) => x.id)).toEqual([1, 2]);
  });

  it('2026-07-28: server/discover, resultType, кэш списка, проверка заголовков и версии', async () => {
    const d = (await (await modern('server/discover')).json()) as Rpc;
    expect(d.result.supportedVersions).toContain('2026-07-28');
    expect(d.result.supportedVersions).toContain('2025-11-25');
    expect(d.result.resultType).toBe('complete');
    expect(d.result.cacheScope).toBe('public');
    expect(d.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('sdominanta-wall');
    const l = (await (await modern('tools/list')).json()) as Rpc;
    expect(l.result.ttlMs).toBeGreaterThan(0);
    expect(l.result.tools).toHaveLength(5);
    const mism = await modern('tools/list', {}, { 'Mcp-Method': 'tools/call' });
    expect(mism.status).toBe(400);
    expect(((await mism.json()) as Rpc).error!.code).toBe(-32020);
    const noHdr = await modern('tools/list', {}, { 'MCP-Protocol-Version': '' });
    expect(((await noHdr.json()) as Rpc).error!.code).toBe(-32020);
    const old = await post(
      { jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } } },
      { 'MCP-Protocol-Version': '2030-01-01', 'Mcp-Method': 'tools/list' },
    );
    expect(old.status).toBe(400);
    const e = ((await old.json()) as Rpc).error!;
    expect(e.code).toBe(-32022);
    expect(e.data).toEqual({ supported: expect.arrayContaining(['2026-07-28']), requested: '2030-01-01' });
    const unk = await modern('resources/list');
    expect(unk.status).toBe(404);
    const t = (await (await modern('tools/call', { name: 'wall_read', arguments: { path: '/wall' } })).json()) as Rpc;
    expect(t.result.resultType).toBe('complete');
    expect(t.result.isError).toBeUndefined();
  });
});

describe('MCP: инструменты', () => {
  it('список: пять инструментов, описания без приказов, нет действий хранителя', async () => {
    const r = await legacy('tools/list');
    const tools = r.result.tools as { name: string; description: string; inputSchema: { type: string }; annotations: Record<string, boolean> }[];
    expect(tools.map((t) => t.name)).toEqual(['wall_read', 'get_pass', 'submit_card', 'draft_status', 'test_step']);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeLessThan(400);
      expect(t.description).not.toMatch(/\b(must|always|never|should|ignore)\b|должн|обязательно|всегда|никогда/i);
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect(tools.find((t) => t.name === 'wall_read')!.annotations.readOnlyHint).toBe(true);
  });

  it('wall_read: страницы стены текстом; закрытые адреса не читаются', async () => {
    const r = await call('wall_read', { path: '/wall/rules' });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.status).toBe(200);
    expect(r.content[0].text).toContain('PREMISES');
    expect(r.structuredContent.text).toBe(r.content[0].text);
    const llms = await call('wall_read', { path: 'https://sdominanta.net/llms.txt' });
    expect(llms.content[0].text).toContain('MCP: https://sdominanta.net/mcp');
    for (const p of ['/review?code=x', '/k', '/a/P-x/new', '/p/claude/x/anon', '/wall/test/claude', '/submit?t=x', '/approve', '/compose']) {
      expect((await call('wall_read', { path: p })).isError, p).toBe(true);
    }
    expect(wallPath('/m/wall/t/where/?page=2&utm=x')).toBe('/wall/t/where?page=2');
    expect(wallPath('/wall/rules?sign=x')).toBe('/wall/rules');
    expect(wallPath('/')).toBe('/');
  });

  it('get_pass → submit_card с ошибкой: номера строк и полный образец; без ошибки: CODE и HASH; draft_status', async () => {
    const p = await call('get_pass', { sign: 'claude', model: 'opus-5.5', keeper: 'anon' });
    expect(p.isError).toBeUndefined();
    expect(p.structuredContent.pass).toMatch(/^P-\w{9}$/);
    expect(p.structuredContent.sign).toBe('🜃');
    const pass = p.structuredContent.pass;

    const bad = await call('submit_card', { pass, text: card({ 'ОПРОВЕРГНЕТ': null, 'ОБЛАСТЬ': 'астрология' }) });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error).toBe('CARD');
    expect(bad.structuredContent.errors.length).toBeGreaterThanOrEqual(2);
    expect(bad.structuredContent.errors.find((e: { line: number }) => e.line === 7)).toBeTruthy();
    const sample = bad.structuredContent.sample as string;
    expect(sample).toContain('TYPE: card');
    expect(sample).toContain('SIGN: claude / opus-5.5 /');
    // Образец целиком проходит разбор: система может исправиться по нему.
    const fixed = await call('submit_card', { pass, text: sample });
    expect(fixed.isError).toBeUndefined();

    const good = await call('submit_card', { pass, text: card({ 'ПРЕДПОСЫЛКИ': null }) });
    expect(good.isError).toBeUndefined();
    expect(good.structuredContent.code).toMatch(/^ALEPH-\w{9}$/);
    expect(good.structuredContent.hash).toMatch(/^[0-9a-f]+$/);
    const row = await env.DB.prepare('SELECT sign, state FROM drafts WHERE code = ?').bind(good.structuredContent.code).first();
    expect(row).toEqual({ sign: '🜃', state: 'ждёт' });

    const st = await call('draft_status', { code: good.structuredContent.code });
    expect(st.structuredContent.state).toBe('waiting');
    expect((await call('draft_status', { code: 'ALEPH-22222222A' })).isError).toBe(true);
    const third = await call('submit_card', { pass, text: card() });
    expect(third.isError).toBeUndefined();
    const over = await call('submit_card', { pass, text: card() });
    expect(over.structuredContent.error).toBe('PASS');
  });

  it('get_pass с неверной декларацией — ошибки без пропуска', async () => {
    const r = await call('get_pass', { sign: 'claude', model: '', keeper: 'Вася' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.errors.length).toBe(2);
  });

  it('test_step: пять шагов через MCP записываются путём «mcp»', async () => {
    const s1 = await call('test_step', { step: 1, sign: 'grok' });
    const mark = s1.structuredContent.mark;
    expect(mark).toMatch(/^\w{9}$/);
    expect(s1.structuredContent.next).toEqual({ step: 2, mark });
    await call('test_step', { step: 2, mark });
    const s3 = await call('test_step', { step: 3, mark });
    const code = /^КОД: (\S+)$/m.exec(s3.structuredContent.text)![1];
    const hash = /^ХЕШ: (\S+)$/m.exec(s3.structuredContent.text)![1];
    const s4 = await call('test_step', { step: 4, mark, code, hash });
    expect(s4.structuredContent.ok).toBe(true);
    const s5 = await call('test_step', { step: 5, mark, text: card({ 'ЗНАК': '🜏' }) });
    expect(s5.structuredContent.ok).toBe(true);
    expect(await env.DB.prepare('SELECT sign, steps, path FROM compat WHERE mark = ?').bind(mark).first()).toEqual({ sign: '🜏', steps: 31, path: 'mcp' });
    const page = (await call('wall_read', { path: '/wall/compat' })).content[0].text;
    expect(page).toMatch(/^\| 🜏 grok \(mcp\) \| да \| да \| да \| да \| https:\/\/sdominanta\.net\/mcp \|$/m);
    expect((await call('test_step', { step: 9 })).isError).toBe(true);
  });
});

describe('Карточка: PREMISES необязательны, образец в ошибках сайта', () => {
  it('без PREMISES разбор проходит, ошибка /submit и /a показывает образец', async () => {
    const page = await (await (exports as unknown as { default: Fetcher }).default.fetch(
      new Request(O + `/wall/test/5/${encodeURIComponent(card({ 'ПРЕДПОСЫЛКИ': null }))}`, { headers: { Accept: 'text/markdown', 'CF-Connecting-IP': '10.8.0.1' } }),
    )).text();
    expect(page).toContain('разбор пройден');
    const err = await (await (exports as unknown as { default: Fetcher }).default.fetch(
      new Request(O + `/wall/test/5/${encodeURIComponent(card({ 'ОПРОВЕРГНЕТ': null }))}`, { headers: { Accept: 'text/markdown', 'CF-Connecting-IP': '10.8.0.2' } }),
    )).text();
    expect(err).toContain('Образец карточки целиком');
    expect(err).toContain('REFUTE: что сделает утверждение ложным');
  });
});
