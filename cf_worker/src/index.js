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

    if (url.pathname !== '/' || method !== 'POST') {
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
    const providedKey = request.headers.get('x-api-key');
    if (env.API_KEY && providedKey !== env.API_KEY) {
      return json({ error: 'unauthorized' }, 401);
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

    return new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { ...corsHeaders(), 'content-type': 'application/json' }
    });
  }
};

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-api-key'
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


