// brc-send: emails BRC 3D print estimate PDFs from binghamresearch@usu.edu.
//
// Endpoints:
//   POST /send            — passcode-gated; emails the PDF via Graph sendMail
//   GET  /setup/start     — one-time OAuth bootstrap (gated by ?key=SETUP_KEY)
//   GET  /setup/callback  — OAuth redirect target; stores the refresh token in KV
//   cron daily            — refreshes the token so its 90-day lifetime never lapses
//
// Auth model: delegated Mail.Send as the mailbox, confidential client.
// The refresh token lives only in KV; the mailbox password is never seen here.

const SCOPE = 'https://graph.microsoft.com/Mail.Send offline_access';
const MAX_BODY_BYTES = 1_500_000;
const DAILY_SEND_CAP = 40;
const FROM_ADDRESS = 'binghamresearch@usu.edu';

const tokenUrl = (env) => `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`;
const authUrl = (env) => `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/authorize`;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(env, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

// Exchanges the stored refresh token for an access token; persists the
// rotated refresh token (Entra issues a new one on every redemption).
async function refreshAccessToken(env) {
  const refreshToken = await env.TOKENS.get('refresh_token');
  if (!refreshToken) return { error: 'reauth_needed' };

  const res = await fetch(tokenUrl(env), {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      refresh_token: refreshToken,
      scope: SCOPE,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === 'invalid_grant') return { error: 'reauth_needed' };
    return { error: 'token_error', detail: data.error_description || data.error };
  }
  if (data.refresh_token) await env.TOKENS.put('refresh_token', data.refresh_token);
  await env.TOKENS.put('last_refresh', new Date().toISOString());
  return { accessToken: data.access_token };
}

async function handleSend(request, env) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) return json(env, 413, { error: 'too_large' });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(env, 400, { error: 'bad_json' });
  }

  const { passcode, to, filename, quoteNo, total, pdfBase64 } = body;
  if (typeof passcode !== 'string' || !(await timingSafeEqual(passcode, env.SEND_PASSCODE))) {
    return json(env, 401, { error: 'bad_passcode' });
  }
  if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return json(env, 400, { error: 'bad_recipient' });
  }
  if (typeof pdfBase64 !== 'string' || pdfBase64.length < 100) {
    return json(env, 400, { error: 'bad_pdf' });
  }

  const day = new Date().toISOString().slice(0, 10);
  const sentToday = Number((await env.TOKENS.get(`sends:${day}`)) || 0);
  if (sentToday >= DAILY_SEND_CAP) return json(env, 429, { error: 'daily_cap' });
  await env.TOKENS.put(`sends:${day}`, String(sentToday + 1), { expirationTtl: 172800 });

  const token = await refreshAccessToken(env);
  if (token.error === 'reauth_needed') return json(env, 503, { error: 'reauth_needed' });
  if (token.error) return json(env, 502, { error: 'token_error', detail: token.detail });

  const safeName = /^[\w.-]{1,120}\.pdf$/.test(filename || '') ? filename : 'brc-estimate.pdf';
  const safeQuote = String(quoteNo || '').slice(0, 40);
  const safeTotal = String(total || '').slice(0, 20);

  const mail = {
    message: {
      subject: `BRC 3D Print Estimate — ${safeQuote}`,
      body: {
        contentType: 'Text',
        content:
          `Attached is your BRC 3D print estimate ${safeQuote} — total ${safeTotal}.\n\n` +
          'The estimate is based on sliced weight and print time; final price is confirmed at pickup.\n\n' +
          'Bingham Research Center\n320 North Aggie Blvd, Vernal, UT 84078\n(435) 722-1740',
      },
      toRecipients: [{ emailAddress: { address: to } }],
      attachments: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: safeName,
          contentType: 'application/pdf',
          contentBytes: pdfBase64,
        },
      ],
    },
    saveToSentItems: true,
  };

  const graphRes = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(mail),
  });
  if (graphRes.status !== 202) {
    const detail = (await graphRes.text()).slice(0, 500);
    console.log(JSON.stringify({ event: 'graph_send_failed', status: graphRes.status, detail }));
    return json(env, 502, { error: 'send_failed' });
  }

  console.log(JSON.stringify({ event: 'sent', quoteNo: safeQuote, sentToday: sentToday + 1 }));
  return json(env, 200, { ok: true, from: FROM_ADDRESS });
}

function redirectUri(url) {
  return `${url.origin}/setup/callback`;
}

async function handleSetupStart(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!env.SETUP_KEY || !(await timingSafeEqual(key, env.SETUP_KEY))) {
    return new Response('Not found', { status: 404 });
  }
  const state = crypto.randomUUID();
  await env.TOKENS.put('oauth_state', state, { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(url),
    response_mode: 'query',
    scope: SCOPE,
    state,
    prompt: 'select_account',
  });
  return Response.redirect(`${authUrl(env)}?${params}`, 302);
}

async function handleSetupCallback(url, env) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const saved = await env.TOKENS.get('oauth_state');
  if (!code || !state || !saved || state !== saved) {
    return new Response('Invalid or expired setup link. Start over from /setup/start.', { status: 400 });
  }
  await env.TOKENS.delete('oauth_state');

  const res = await fetch(tokenUrl(env), {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(url),
      scope: SCOPE,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    return new Response(`Authorization failed: ${data.error_description || data.error || 'no refresh token returned'}`, { status: 502 });
  }
  await env.TOKENS.put('refresh_token', data.refresh_token);
  await env.TOKENS.put('last_refresh', new Date().toISOString());
  return new Response('Authorized — estimate sending is live. You can close this tab.', {
    headers: { 'Content-Type': 'text/plain' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }
      if (request.method === 'POST' && url.pathname === '/send') {
        return await handleSend(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/setup/start') {
        return await handleSetupStart(url, env);
      }
      if (request.method === 'GET' && url.pathname === '/setup/callback') {
        return await handleSetupCallback(url, env);
      }
      return json(env, 404, { error: 'not_found' });
    } catch (err) {
      console.log(JSON.stringify({ event: 'unhandled_error', message: String(err) }));
      return json(env, 500, { error: 'internal' });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      refreshAccessToken(env).then((r) =>
        console.log(JSON.stringify({ event: 'cron_refresh', ok: !r.error, error: r.error }))
      )
    );
  },
};
