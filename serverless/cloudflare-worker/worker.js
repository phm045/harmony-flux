/**
 * Harmony Flux — Worker d'approbation des témoignages
 * ----------------------------------------------------
 * Le site phm045.github.io/harmony-flux est statique. Pour que l'admin
 * (Tony) puisse approuver des témoignages SANS accès GitHub et SANS
 * manipuler de Personal Access Token, ce Worker reçoit la requête depuis
 * admin.html, vérifie un secret partagé, puis met à jour temoignages.json
 * via l'API GitHub avec un token stocké uniquement côté serveur.
 *
 * Variables d'environnement (Settings → Variables → Add variable, en
 * cochant "Encrypt") :
 *   GITHUB_TOKEN          fine-grained PAT, repo unique, scope Contents:RW
 *   REPO_OWNER            ex: phm045
 *   REPO_NAME             ex: harmony-flux
 *   REPO_BRANCH           ex: main (optionnel, défaut: main)
 *   ADMIN_SHARED_SECRET   secret long aléatoire, partagé avec l'admin
 *   ALLOWED_ORIGIN        ex: https://phm045.github.io  (optionnel mais
 *                         recommandé — défaut: https://phm045.github.io)
 *
 * Endpoints :
 *   GET  /health                → { ok: true }
 *   POST /publish-temoignage    → publie un témoignage validé
 *
 * Le client (admin.html) envoie :
 *   Headers: { "Content-Type": "application/json",
 *              "x-admin-secret": "<ADMIN_SHARED_SECRET>" }
 *   Body:    { prenom, ville, note, soin, modalite, texte }
 */

const ALLOWED_SOINS = ['global', 'douleur', 'stress', 'blocage', 'enfant', 'suivi'];
const ALLOWED_MODALITES = ['presentiel', 'distance'];

const MAX_PRENOM = 40;
const MAX_VILLE = 40;
const MAX_TEXTE = 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || 'https://phm045.github.io';

    // Pré-flight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true }, 200, origin);
    }

    if (request.method === 'POST' && url.pathname === '/publish-temoignage') {
      try {
        return await handlePublish(request, env, origin);
      } catch (e) {
        // Erreur non verbeuse côté client, log côté Worker
        console.error('publish-temoignage error', e && e.stack || e);
        return json({ error: 'internal_error' }, 500, origin);
      }
    }

    return json({ error: 'not_found' }, 404, origin);
  }
};

async function handlePublish(request, env, origin) {
  // 1. Auth — secret partagé
  const provided = request.headers.get('x-admin-secret') || '';
  const expected = env.ADMIN_SHARED_SECRET || '';
  if (!expected || !timingSafeEqual(provided, expected)) {
    return json({ error: 'unauthorized' }, 401, origin);
  }

  // 2. Sanity côté env
  if (!env.GITHUB_TOKEN || !env.REPO_OWNER || !env.REPO_NAME) {
    return json({ error: 'server_misconfigured' }, 500, origin);
  }

  // 3. Parse + validate input
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'invalid_json' }, 400, origin);
  }

  const sanitized = sanitizeInput(body);
  if (!sanitized) {
    return json({ error: 'invalid_input' }, 400, origin);
  }

  // 4. Récupère temoignages.json + sha
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

  // 5. id auto-incrémenté
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

  // 6. PUT vers GitHub
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

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

function json(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin)
    }
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
