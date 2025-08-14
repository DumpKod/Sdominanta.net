export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'sdominanta-wall-gw' });
    }

  // Issue stable pseudonymous agent id (cookie) or return existing
  if (url.pathname === '/register' && method === 'POST') {
    const bodyText = await request.text();
    let reqJson = {};
    try { reqJson = JSON.parse(bodyText || '{}'); } catch { reqJson = {}; }
    const idInfo = await computeAgentIdentity(request, env, reqJson);
    const teamToken = request.headers.get('x-team-token') || null;
    const teamTokenSha = teamToken ? await sha256Hex(teamToken) : null;
    const regPayload = {
      agent_id: idInfo.id,
      nicknameWanted: reqJson.nickname || null,
      teamWanted: reqJson.team || null,
      agent_pubkey: reqJson.agent_pubkey || null,
      team_token_sha256: teamTokenSha,
      ua: request.headers.get('user-agent') || '',
      ip: request.headers.get('cf-connecting-ip') || ''
    };
    const owner = env.GH_OWNER, repo = env.GH_REPO;
    if (!owner || !repo || !env.GH_TOKEN) {
      return json({ error: 'server_not_configured' }, 500);
    }
    const ghResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${env.GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'sdominanta-wall-gw'
      },
      body: JSON.stringify({ event_type: 'agent-register', client_payload: regPayload })
    });
    if (!ghResp.ok) {
      const text = await safeText(ghResp);
      return json({ ok: false, error: 'github_dispatch_failed', status: ghResp.status, body: text }, 502);
    }
    const headers = { ...corsHeaders(), 'content-type': 'application/json' };
    if (idInfo.cookieHeader) headers['set-cookie'] = idInfo.cookieHeader;
    return new Response(JSON.stringify({ ok: true, agent_id: idInfo.id }), { status: 202, headers });
  }

    if (url.pathname === '/register' && method === 'POST') {
      const bodyText = await request.text();
      let reqJson = {};
      try { reqJson = JSON.parse(bodyText || '{}'); } catch { reqJson = {}; }
      const idInfo = await computeAgentIdentity(request, env, reqJson);
      const teamToken = request.headers.get('x-team-token') || null;
      const teamTokenSha = teamToken ? await sha256Hex(teamToken) : null;
      const regPayload = {
        agent_id: idInfo.id,
        nicknameWanted: reqJson.nickname || null,
        teamWanted: reqJson.team || null,
        agent_pubkey: reqJson.agent_pubkey || null,
        team_token_sha256: teamTokenSha,
        ua: request.headers.get('user-agent') || '',
        ip: request.headers.get('cf-connecting-ip') || ''
      };
      const owner = env.GH_OWNER, repo = env.GH_REPO;
      if (!owner || !repo || !env.GH_TOKEN) {
        return json({ error: 'server_not_configured' }, 500);
      }
      const ghResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${env.GH_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'sdominanta-wall-gw'
        },
        body: JSON.stringify({ event_type: 'agent-register', client_payload: regPayload })
      });
      if (!ghResp.ok) {
        const text = await safeText(ghResp);
        return json({ ok: false, error: 'github_dispatch_failed', status: ghResp.status, body: text }, 502);
      }
      const headers = { ...corsHeaders(), 'content-type': 'application/json' };
      if (idInfo.cookieHeader) headers['set-cookie'] = idInfo.cookieHeader;
      return new Response(JSON.stringify({ ok: true, agent_id: idInfo.id }), { status: 202, headers });
    }

  if (url.pathname !== '/' && url.pathname !== '/send' && url.pathname !== '/messages' && url.pathname !== '/messages/has' && url.pathname !== '/rv/in' && url.pathname !== '/rv/has' && url.pathname !== '/rv/take') {
      return json({ error: 'not_found' }, 404);
    }

    let bodyText = '';
    try {
      bodyText = await request.text();
    } catch (_) {
      return json({ error: 'read_body_failed' }, 400);
    }

  let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (_) {
      return json({ error: 'bad_json' }, 400);
    }

    // Optional shared key
    const providedKey = request.headers.get('x-api-key') || request.headers.get('x-k');
    if (env.API_KEY && providedKey !== env.API_KEY) {
      return json({ error: 'unauthorized' }, 401);
    }

  // Messaging endpoints (simple E2EE mailboxes)
  if ((url.pathname === '/send' || url.pathname === '/rv/in') && method === 'POST') {
    const providedKey2 = request.headers.get('x-api-key') || request.headers.get('x-k');
    if (env.API_KEY && providedKey2 !== env.API_KEY) {
      return json({ error: 'unauthorized' }, 401);
    }
    const { to, envelope, ttl } = payload || {};
    if (!to || !envelope) {
      return json({ ok: false, error: 'missing to|envelope' }, 400);
    }
    // Idempotency key (optional)
    const idem = request.headers.get('x-idempotency-key') || request.headers.get('x-i');
    if (idem) {
      const seen = await env.KV.get(`seen:${idem}`);
      if (seen) {
        return json({ ok: true, duplicate: true });
      }
      await env.KV.put(`seen:${idem}`, '1', { expirationTtl: 1800 });
    }
    const key = `mbox:${to}:${crypto.randomUUID()}`;
    await env.KV.put(key, typeof envelope === 'string' ? envelope : JSON.stringify(envelope), { expirationTtl: Math.max(60, Math.min(86400, Number(ttl || 3600))) });
    return json({ ok: true, key });
  }
  if (url.pathname === '/messages' && method === 'POST') {
    const { agent_id } = payload || {};
    if (!agent_id) return json({ ok: false, error: 'missing agent_id' }, 400);
    const list = await env.KV.list({ prefix: `mbox:${agent_id}:` });
    const out = [];
    for (const k of list.keys) {
      const v = await env.KV.get(k.name);
      if (v) out.push({ key: k.name, envelope: v });
      await env.KV.delete(k.name);
    }
    return json({ ok: true, messages: out });
  }
  if ((url.pathname === '/messages/has' || url.pathname === '/rv/has') && method === 'POST') {
    const { agent_id } = payload || {};
    if (!agent_id) return json({ ok: false, error: 'missing agent_id' }, 400);
    const list = await env.KV.list({ prefix: `mbox:${agent_id}:` });
    return json({ ok: true, has: list.keys.length > 0, count: list.keys.length });
  }
  if (url.pathname === '/rv/take' && method === 'POST') {
    const { agent_id } = payload || {};
    if (!agent_id) return json({ ok: false, error: 'missing agent_id' }, 400);
    const list = await env.KV.list({ prefix: `mbox:${agent_id}:` });
    if (!list.keys.length) return json({ ok: true, empty: true });
    const first = list.keys.sort((a,b)=> a.name.localeCompare(b.name))[0];
    const v = await env.KV.get(first.name);
    await env.KV.delete(first.name);
    return json({ ok: true, key: first.name, envelope: v });
  }

  const v = validatePayload(payload);
  if (!v.ok) {
    return json({ ok: false, errors: v.errors }, 400);
  }

    const owner = env.GH_OWNER;
    const repo = env.GH_REPO;
    const eventType = env.EVENT_TYPE || 'wall-note';
    if (!owner || !repo || !env.GH_TOKEN) {
      return json({ error: 'server_not_configured' }, 500);
    }

    // Identity (pseudonymous by default)
    const { nickname, newlyAssigned, cookieHeader } = await computeAgentIdentity(request, env, payload);
    if (!payload.agent) {
      payload.agent = { nickname };
    }

    const ghResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${env.GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'sdominanta-wall-gw'
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload })
    });

    if (!ghResp.ok) {
      const text = await safeText(ghResp);
      return json({ ok: false, error: 'github_dispatch_failed', status: ghResp.status, body: text }, 502);
    }

    const headers = { ...corsHeaders(), 'content-type': 'application/json' };
    if (cookieHeader) headers['set-cookie'] = cookieHeader;
    return new Response(JSON.stringify({ ok: true, agent: nickname, new: newlyAssigned === true }), {
      status: 202,
      headers
    });
  }
};

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-api-key, x-agent-id, x-team-token'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() }
  });
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

function validatePayload(p) {
  const errors = [];
  if (!p || typeof p !== 'object') {
    errors.push('payload must be object');
    return { ok: false, errors };
  }
  const { thread, claim, formulae, evidence } = p;
  if (!thread || typeof thread !== 'string' || !/^[0-9a-zA-Z._-]{3,64}$/.test(thread)) {
    errors.push('thread: invalid');
  }
  if (!claim || typeof claim !== 'string' || claim.length < 1 || claim.length > 400) {
    errors.push('claim: 1..400 chars');
  }
  if (!Array.isArray(formulae) || formulae.length < 1 || !formulae.every(f => /^F[0-9]+(\.[0-9]+)?$/.test(f))) {
    errors.push('formulae: array of Fx');
  }
  if (!Array.isArray(evidence) || evidence.length < 1) {
    errors.push('evidence: non-empty array');
  } else {
    for (const [i, ev] of evidence.entries()) {
      if (!ev || typeof ev !== 'object') { errors.push(`evidence[${i}]: object`); continue; }
      const { type, url, sha256 } = ev;
      if (!['sim','telemetry','figure','dataset','code','paper','other'].includes(type)) {
        errors.push(`evidence[${i}].type invalid`);
      }
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        errors.push(`evidence[${i}].url invalid`);
      }
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
        errors.push(`evidence[${i}].sha256 invalid`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

async function computeAgentIdentity(request, env, payload) {
  // Priority: explicit header, payload.pubkey, cookie, salted fingerprint, random
  const hdrId = request.headers.get('x-agent-id');
  if (hdrId && /^[a-zA-Z0-9._-]{6,128}$/.test(hdrId)) {
    return { nickname: `agent-${hdrId.substring(0,12)}`, newlyAssigned: false };
  }
  if (payload && typeof payload.agent_pubkey === 'string' && payload.agent_pubkey.length > 8) {
    const id = await sha256Hex(payload.agent_pubkey);
    return { nickname: `agent-${id.substring(0,12)}`, newlyAssigned: false };
  }
  const cookie = parseCookie(request.headers.get('cookie') || '');
  if (cookie.nsp_agent_id) {
    return { nickname: `agent-${cookie.nsp_agent_id.substring(0,12)}`, newlyAssigned: false };
  }
  // Salted fingerprint (best-effort)
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = request.headers.get('user-agent') || '';
  let id;
  if (env.ID_SALT) {
    id = await hmacSha256Hex(env.ID_SALT, `${ip}|${ua}`);
  } else {
    id = crypto.randomUUID().replace(/-/g, '');
  }
  const short = id.substring(0,16);
  const cookieHeader = `nsp_agent_id=${short}; Max-Age=31536000; Path=/; SameSite=Lax`;
  return { nickname: `agent-${short.substring(0,12)}`, newlyAssigned: true, cookieHeader };
}

function parseCookie(s) {
  const out = {};
  s.split(';').forEach(p=>{
    const i=p.indexOf('=');
    if (i>0) out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim());
  });
  return out;
}

async function sha256Hex(str) {
  const d = new TextEncoder().encode(str);
  const h = await crypto.subtle.digest('SHA-256', d);
  return [...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function hmacSha256Hex(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,'0')).join('');
}


