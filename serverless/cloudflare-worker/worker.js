/**
 * Harmony Flux — Worker backend
 * --------------------------------------------------------------
 * Ce Worker assure trois rôles backend pour le site statique
 * phm045.github.io/harmony-flux :
 *
 *   1) Approbation / publication des témoignages (PAT GitHub côté serveur).
 *   2) Proxy authentifié vers l'API Cal.eu — la CAL_API_KEY ne doit JAMAIS
 *      apparaître dans le navigateur. Le client appelle ce Worker, qui
 *      ajoute l'en-tête Authorization côté serveur.
 *   3) Authentification admin serveur : endpoint /admin/login qui vérifie
 *      l'email + le hash du mot de passe, et pose un cookie de session
 *      signé HMAC, HttpOnly, Secure, SameSite=None (cross-site GitHub
 *      Pages → workers.dev).
 *
 * Variables d'environnement (Settings → Variables) :
 *
 *   Secrets (chiffrés / "Encrypt") :
 *     GITHUB_TOKEN          fine-grained PAT, repo unique, scope Contents:RW
 *     ADMIN_SHARED_SECRET   secret long aléatoire (publication témoignages)
 *     CAL_API_KEY           clé Cal.eu (Bearer)
 *     ADMIN_PASSWORD_HASH   sha256(password) en hexadécimal minuscules
 *     SESSION_HMAC_SECRET   secret long aléatoire (signature cookie session)
 *
 *   Variables non secrètes (texte clair dans wrangler.toml) :
 *     REPO_OWNER            ex: phm045
 *     REPO_NAME             ex: harmony-flux
 *     REPO_BRANCH           ex: main (optionnel, défaut: main)
 *     ADMIN_EMAIL           ex: tonydegois84@gmail.com
 *     ALLOWED_ORIGIN        ex: https://phm045.github.io
 *     SESSION_TTL_SECONDS   ex: 28800 (8 h, optionnel)
 *
 * Endpoints :
 *     GET  /health                → { ok: true }
 *     POST /admin/login           → { ok: true } + Set-Cookie hf_admin
 *     POST /admin/logout          → { ok: true } + Set-Cookie expirée
 *     GET  /admin/session         → { ok: true } si cookie valide
 *     ALL  /cal/*                 → proxy vers https://api.cal.eu/v2/* (auth)
 *     POST /publish-temoignage    → publie un témoignage (auth: cookie OU
 *                                   x-admin-secret legacy pour compat)
 */

const ALLOWED_SOINS = ['global', 'douleur', 'stress', 'blocage', 'enfant', 'suivi'];
const ALLOWED_MODALITES = ['presentiel', 'distance'];

const MAX_PRENOM = 40;
const MAX_VILLE = 40;
const MAX_TEXTE = 1000;
const MAX_PAYLOAD_BYTES = 8 * 1024;

const SESSION_COOKIE = 'hf_admin';
const DEFAULT_SESSION_TTL = 8 * 60 * 60;

const CAL_UPSTREAM_BASE = 'https://api.cal.eu/v2';
const CAL_API_VERSION = '2024-08-13';

const RATE_BUCKET = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || 'https://phm045.github.io';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, true) });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true }, 200, origin);
      }

      if (request.method === 'POST' && url.pathname === '/admin/login') {
        return await handleLogin(request, env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/admin/logout') {
        return handleLogout(origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/session') {
        return await handleSessionCheck(request, env, origin);
      }

      if (url.pathname === '/publish-temoignage' && request.method === 'POST') {
        return await handlePublish(request, env, origin);
      }

      if (url.pathname.startsWith('/cal/')) {
        return await handleCalProxy(request, env, origin, url);
      }

      return json({ error: 'not_found' }, 404, origin);
    } catch (e) {
      console.error('worker error', (e && e.stack) || e);
      return json({ error: 'internal_error' }, 500, origin);
    }
  }
};

// ─── Auth admin (cookie signé) ──────────────────────────────────────────────

async function handleLogin(request, env, origin) {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD_HASH || !env.SESSION_HMAC_SECRET) {
    return json({ error: 'server_misconfigured' }, 500, origin);
  }
  const ip = clientIp(request);
  if (!rateLimit('login:' + ip, 5, 5 * 60)) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  const body = await readJson(request);
  if (!body) return json({ error: 'invalid_json' }, 400, origin);

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return json({ error: 'invalid_credentials' }, 401, origin);
  }

  const hash = await sha256Hex(password);
  const emailOk = timingSafeEqual(email, env.ADMIN_EMAIL.toLowerCase());
  const passOk = timingSafeEqual(hash, env.ADMIN_PASSWORD_HASH.toLowerCase());
  if (!(emailOk && passOk)) {
    return json({ error: 'invalid_credentials' }, 401, origin);
  }

  const ttl = parseInt(env.SESSION_TTL_SECONDS || '', 10) || DEFAULT_SESSION_TTL;
  const cookie = await issueSessionCookie(env.SESSION_HMAC_SECRET, email, ttl);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': cookie,
    ...corsHeaders(origin, true),
    ...securityHeaders()
  };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

function handleLogout(origin) {
  const expired = [
    SESSION_COOKIE + '=',
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Max-Age=0'
  ].join('; ');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': expired,
    ...corsHeaders(origin, true),
    ...securityHeaders()
  };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleSessionCheck(request, env, origin) {
  const sub = await verifySession(request, env);
  if (!sub) return json({ ok: false }, 401, origin);
  return json({ ok: true, email: sub }, 200, origin);
}

async function verifySession(request, env) {
  if (!env.SESSION_HMAC_SECRET) return null;
  const cookieHeader = request.headers.get('Cookie') || '';
  const raw = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!raw) return null;
  return await verifySessionToken(env.SESSION_HMAC_SECRET, raw);
}

async function issueSessionCookie(secret, email, ttlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = base64UrlEncode(JSON.stringify({ sub: email, exp }));
  const sig = await hmacSha256Hex(secret, payload);
  const token = payload + '.' + sig;
  return [
    SESSION_COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Max-Age=' + ttlSeconds
  ].join('; ');
}

async function verifySessionToken(secret, token) {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSha256Hex(secret, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  let parsed;
  try { parsed = JSON.parse(base64UrlDecode(payload)); } catch (_) { return null; }
  if (!parsed || typeof parsed.exp !== 'number' || typeof parsed.sub !== 'string') return null;
  if (Math.floor(Date.now() / 1000) > parsed.exp) return null;
  return parsed.sub;
}

// ─── Proxy Cal.eu ───────────────────────────────────────────────────────────

async function handleCalProxy(request, env, origin, url) {
  const sub = await verifySession(request, env);
  if (!sub) return json({ error: 'unauthorized' }, 401, origin);
  if (!env.CAL_API_KEY) return json({ error: 'server_misconfigured' }, 500, origin);

  const ip = clientIp(request);
  if (!rateLimit('cal:' + ip, 120, 60)) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  // /cal/bookings?status=upcoming → https://api.cal.eu/v2/bookings?status=upcoming
  const upstreamPath = url.pathname.replace(/^\/cal\//, '/');
  const upstreamUrl = CAL_UPSTREAM_BASE + upstreamPath + url.search;

  const allowedMethods = ['GET', 'POST'];
  if (!allowedMethods.includes(request.method)) {
    return json({ error: 'method_not_allowed' }, 405, origin);
  }

  // Validation périmètre des chemins autorisés (whitelist défensive)
  if (!/^\/bookings(\/|$)/.test(upstreamPath)) {
    return json({ error: 'forbidden_path' }, 403, origin);
  }

  let upstreamBody;
  if (request.method === 'POST') {
    const cl = parseInt(request.headers.get('content-length') || '0', 10);
    if (Number.isFinite(cl) && cl > MAX_PAYLOAD_BYTES) {
      return json({ error: 'payload_too_large' }, 413, origin);
    }
    upstreamBody = await request.text();
    if (upstreamBody.length > MAX_PAYLOAD_BYTES) {
      return json({ error: 'payload_too_large' }, 413, origin);
    }
  }

  const upstreamResp = await fetch(upstreamUrl, {
    method: request.method,
    headers: {
      'Authorization': 'Bearer ' + env.CAL_API_KEY,
      'cal-api-version': CAL_API_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: upstreamBody
  });

  const text = await upstreamResp.text();
  return new Response(text, {
    status: upstreamResp.status,
    headers: {
      'Content-Type': upstreamResp.headers.get('Content-Type') || 'application/json; charset=utf-8',
      ...corsHeaders(origin, true),
      ...securityHeaders()
    }
  });
}

// ─── Publication témoignage ─────────────────────────────────────────────────

async function handlePublish(request, env, origin) {
  // Auth : cookie OU x-admin-secret (legacy)
  const session = await verifySession(request, env);
  let authorized = !!session;
  if (!authorized) {
    const provided = request.headers.get('x-admin-secret') || '';
    const expected = env.ADMIN_SHARED_SECRET || '';
    authorized = !!expected && timingSafeEqual(provided, expected);
  }
  if (!authorized) return json({ error: 'unauthorized' }, 401, origin);

  if (!env.GITHUB_TOKEN || !env.REPO_OWNER || !env.REPO_NAME) {
    return json({ error: 'server_misconfigured' }, 500, origin);
  }

  const ip = clientIp(request);
  if (!rateLimit('publish:' + ip, 30, 60)) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  const cl = parseInt(request.headers.get('content-length') || '0', 10);
  if (Number.isFinite(cl) && cl > MAX_PAYLOAD_BYTES) {
    return json({ error: 'payload_too_large' }, 413, origin);
  }

  const body = await readJson(request);
  if (!body) return json({ error: 'invalid_json' }, 400, origin);

  const sanitized = sanitizeInput(body);
  if (!sanitized) return json({ error: 'invalid_input' }, 400, origin);

  const branch = env.REPO_BRANCH || 'main';
  const apiBase = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/temoignages.json`;
  const ghHeaders = {
    'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'harmony-flux-worker'
  };

  const getResp = await fetch(apiBase + '?ref=' + encodeURIComponent(branch), { headers: ghHeaders });
  if (!getResp.ok) {
    return json({ error: 'github_read_failed', status: getResp.status }, 502, origin);
  }
  const file = await getResp.json();
  const sha = file.sha;
  const decoded = base64DecodeUtf8(file.content || '');
  let arr;
  try {
    arr = JSON.parse(decoded);
    if (!Array.isArray(arr)) throw new Error('not_array');
  } catch (_) {
    return json({ error: 'corrupt_temoignages_json' }, 500, origin);
  }

  const nextId = arr.reduce((m, t) => Math.max(m, parseInt(t.id, 10) || 0), 0) + 1;
  const newItem = {
    id: nextId,
    prenom: sanitized.prenom,
    ville: sanitized.ville,
    note: sanitized.note,
    soin: sanitized.soin,
    modalite: sanitized.modalite,
    texte: sanitized.texte,
    date: new Date().toISOString().split('T')[0]
  };
  arr.unshift(newItem);

  const newContent = base64EncodeUtf8(JSON.stringify(arr, null, 2) + '\n');
  const putResp = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Ajout témoignage approuvé : ' + newItem.prenom,
      content: newContent,
      sha: sha,
      branch: branch
    })
  });

  if (!putResp.ok) {
    return json({ error: 'github_write_failed', status: putResp.status }, 502, origin);
  }
  return json({ ok: true, id: newItem.id, count: arr.length }, 200, origin);
}

// ─── Validation / sanitization ──────────────────────────────────────────────

async function readJson(request) {
  try { return await request.json(); } catch (_) { return null; }
}

function sanitizeInput(body) {
  if (!body || typeof body !== 'object') return null;
  const prenom = typeof body.prenom === 'string' ? body.prenom.trim() : '';
  const texte = typeof body.texte === 'string' ? body.texte.trim() : '';
  if (!prenom || !texte) return null;

  let note = parseInt(body.note, 10);
  if (!Number.isFinite(note)) note = 5;
  note = Math.min(5, Math.max(1, note));

  const villeRaw = typeof body.ville === 'string' ? body.ville.trim() : '';
  const soinRaw = typeof body.soin === 'string' ? body.soin.trim().toLowerCase() : '';
  const modaliteRaw = typeof body.modalite === 'string' ? body.modalite.trim().toLowerCase() : '';

  return {
    prenom: prenom.slice(0, MAX_PRENOM),
    ville: villeRaw.slice(0, MAX_VILLE),
    note: note,
    soin: ALLOWED_SOINS.includes(soinRaw) ? soinRaw : '',
    modalite: ALLOWED_MODALITES.includes(modaliteRaw) ? modaliteRaw : '',
    texte: texte.slice(0, MAX_TEXTE)
  };
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function corsHeaders(origin, withCredentials) {
  const h = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
  if (withCredentials) h['Access-Control-Allow-Credentials'] = 'true';
  return h;
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains'
  };
}

function json(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin, true),
      ...securityHeaders()
    }
  });
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For') ||
         'unknown';
}

// Rate limit best-effort, mémoire de l'isolate (par-instance, non global).
// Suffisant pour ralentir un brute-force ; à remplacer par Durable Object
// si une garantie cross-isolate est nécessaire.
function rateLimit(key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const entry = RATE_BUCKET.get(key);
  if (!entry || now - entry.start >= windowSeconds) {
    RATE_BUCKET.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(message) {
  const buf = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(/;\s*/).forEach(p => {
    const eq = p.indexOf('=');
    if (eq <= 0) return;
    out[p.slice(0, eq)] = p.slice(eq + 1);
  });
  return out;
}

function base64UrlEncode(str) {
  return base64EncodeUtf8(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return base64DecodeUtf8(s);
}

function base64DecodeUtf8(b64) {
  const clean = (b64 || '').replace(/\n/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function base64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
