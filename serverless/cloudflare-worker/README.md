# Worker backend — Harmony Flux

Cloudflare Worker qui rassemble trois rôles backend pour le site statique
`phm045.github.io/harmony-flux` :

1. **Approbation des témoignages** — admin (Tony) approuve un avis sans
   accès GitHub ni PAT navigateur. Le PAT GitHub reste côté serveur.
2. **Proxy Cal.eu** — la clé `CAL_API_KEY` ne quitte plus le serveur. Le
   navigateur appelle `/cal/bookings…` via le Worker, qui injecte
   `Authorization: Bearer <CAL_API_KEY>` côté serveur.
3. **Auth admin serveur** — `/admin/login` vérifie email + hash du mot de
   passe et pose un cookie `hf_admin` HttpOnly, Secure, SameSite=None,
   signé HMAC-SHA256. La protection ne dépend plus uniquement d'un flag
   `sessionStorage` côté navigateur.

## Architecture

```
admin.html ──/admin/login──▶ Worker ─(vérifie hash + signe cookie)─▶ Set-Cookie
admin.html ──/cal/*       ──▶ Worker ─(Bearer CAL_API_KEY)─────────▶ api.cal.eu/v2
admin.html ──/publish-temoignage─▶ Worker ─(PAT GitHub server-side)─▶ GitHub API
```

## Pré-requis

- Compte Cloudflare gratuit
- Node ≥ 18
- `npm i -g wrangler`
- Un **fine-grained PAT GitHub** restreint à `phm045/harmony-flux`,
  scope `Contents: Read and write`.

## Déploiement

```bash
cd serverless/cloudflare-worker
wrangler login

# Secrets — chiffrés au repos chez Cloudflare
wrangler secret put GITHUB_TOKEN          # PAT fine-grained, Contents:RW
wrangler secret put ADMIN_SHARED_SECRET   # ex: openssl rand -base64 32
wrangler secret put CAL_API_KEY           # clé Cal.eu (Bearer)
wrangler secret put ADMIN_PASSWORD_HASH   # echo -n 'motdepasse' | sha256sum
wrangler secret put SESSION_HMAC_SECRET   # ex: openssl rand -base64 64

# Variables non secrètes : déjà dans wrangler.toml
wrangler deploy
```

URL résultante : `https://harmony-flux-temoignages.<sub>.workers.dev`.

```bash
curl -sS https://harmony-flux-temoignages.<sub>.workers.dev/health
# {"ok":true}
```

## Configuration côté admin

Dans `admin.html`, section **« Endpoint d'approbation »** :

1. **URL du Worker** : URL ci-dessus, sans slash final.
2. **Secret admin** : utilisé uniquement pour le mode legacy
   (`x-admin-secret`). En mode cookie, ce champ n'est pas requis.

Quand l'URL est configurée :
- Le login `admin.html` appelle `/admin/login` ; en cas de succès, un
  cookie HttpOnly est posé et tous les appels Cal passent par le Worker.
- Le navigateur n'a plus jamais accès à `CAL_API_KEY`.

## Endpoints

| Méthode | Chemin                      | Description                              |
| ------- | --------------------------- | ---------------------------------------- |
| GET     | `/health`                   | Probe                                    |
| POST    | `/admin/login`              | `{email,password}` → cookie `hf_admin`   |
| POST    | `/admin/logout`             | Invalide le cookie                       |
| GET     | `/admin/session`            | `{ok:true}` si cookie valide             |
| GET/POST| `/cal/bookings/…`           | Proxy authentifié (cookie requis)        |
| POST    | `/publish-temoignage`       | Cookie OU `x-admin-secret` (legacy)      |

## Sécurité

- Tous les secrets (`CAL_API_KEY`, `GITHUB_TOKEN`, `SESSION_HMAC_SECRET`,
  `ADMIN_PASSWORD_HASH`, `ADMIN_SHARED_SECRET`) restent **uniquement**
  côté Worker. Aucun secret réel n'est commité ni transmis au navigateur.
- Cookie `hf_admin` : HttpOnly, Secure, SameSite=None, signé HMAC-SHA256,
  TTL 8 h (configurable via `SESSION_TTL_SECONDS`).
- Comparaisons en temps constant (`timingSafeEqual`) pour les secrets,
  hash et signatures.
- CORS limité à `ALLOWED_ORIGIN` avec `Allow-Credentials: true`.
- Headers : `X-Content-Type-Options`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, `Strict-Transport-Security`.
- Limite payload 8 KiB sur `/publish-temoignage` et `POST /cal/*`.
- Rate limit best-effort (par-isolate) :
  - login : 5 tentatives / 5 min / IP
  - cal   : 120 req / 60 s / IP
  - publish : 30 / 60 s / IP
- Whitelist stricte des chemins proxy (`/bookings/…` uniquement) —
  pas d'introspection libre de l'API Cal.
- Validation stricte des champs témoignage (longueurs, valeurs `soin` /
  `modalite`, note 1–5).

> **Note rate-limit** : la table est mémoire-isolate. Suffisant pour
> ralentir un brute-force opportuniste. Pour une garantie cross-isolate,
> migrer vers un Durable Object.

## Rotation de secret

```bash
wrangler secret put CAL_API_KEY
wrangler secret put ADMIN_PASSWORD_HASH
wrangler secret put SESSION_HMAC_SECRET   # invalide toutes les sessions
```

## Mode dégradé

Si l'URL d'endpoint n'est PAS configurée dans `admin.html` :
- L'auth se rabat sur le check local SHA-256 dans `sessionStorage`
  (mode propriétaire / dev).
- Les appels Cal utilisent une clé optionnelle stockée par
  l'utilisateur dans `localStorage["hf_cal_api_key"]` ; sans cette clé,
  les requêtes Cal échouent proprement avec un message clair.

Aucune clé Cal n'est plus présente en clair dans le code source.

## Tests minimaux

```bash
# Vérification de syntaxe
node --check worker.js

# Tests unitaires Worker (validation, signature cookie, sanitize)
node --test test/worker.test.mjs
```

Le pipeline GitHub Actions `.github/workflows/ci.yml` exécute ces checks
sur chaque push/PR + un scan grep des secrets connus.
