# Worker d'approbation — Harmony Flux

Petit Cloudflare Worker qui permet à Tony d'approuver un témoignage depuis
`admin.html` **sans accès GitHub** et **sans Personal Access Token (PAT)**
dans le navigateur.

Le PAT GitHub reste **uniquement côté serveur**. Le navigateur n'envoie
qu'un secret partagé d'admin.

## Architecture

```
admin.html  ─POST x-admin-secret─▶  Cloudflare Worker  ─PAT GitHub─▶  GitHub Contents API
                                          │
                                          └─ valide le secret
                                          └─ valide / sanitize le payload
                                          └─ GET temoignages.json + sha
                                          └─ unshift + PUT
```

## Pré-requis

- Compte Cloudflare gratuit
- Node ≥ 18
- `npm i -g wrangler`
- Un **fine-grained PAT GitHub** restreint au seul repo `phm045/harmony-flux`,
  scope `Contents: Read and write` (ne pas réutiliser un PAT classique).

## Déploiement

```bash
cd serverless/cloudflare-worker
wrangler login

# Secrets (chiffrés au repos chez Cloudflare)
wrangler secret put GITHUB_TOKEN          # colle le PAT fine-grained
wrangler secret put ADMIN_SHARED_SECRET   # ex: openssl rand -base64 32

# Variables non secrètes — déjà dans wrangler.toml,
# à ajuster si vous changez de repo.

wrangler deploy
```

À la fin, vous obtenez une URL du type
`https://harmony-flux-temoignages.<votre-sous-domaine>.workers.dev`.

Vérifiez :

```bash
curl -sS https://harmony-flux-temoignages.<sub>.workers.dev/health
# {"ok":true}
```

## Configuration côté admin

Dans `admin.html` (panneau Témoignages), une nouvelle zone **« Configuration
de l'endpoint d'approbation »** apparaît :

1. **URL du Worker** : collez l'URL ci-dessus, sans slash final.
2. **Secret admin** : collez la même valeur que `ADMIN_SHARED_SECRET`.

Les deux valeurs sont stockées dans `localStorage` côté admin (jamais commitées
ni envoyées ailleurs que vers le Worker que vous contrôlez). Tony peut les
configurer une fois, puis approuver les témoignages d'un clic.

## Sécurité

- `GITHUB_TOKEN` : **jamais** côté frontend. Stocké chiffré chez Cloudflare.
- `ADMIN_SHARED_SECRET` : long, aléatoire, comparé en temps constant.
- CORS limité à `ALLOWED_ORIGIN` (par défaut `https://phm045.github.io`).
- Validation stricte des champs (longueurs, valeurs autorisées pour `soin` /
  `modalite`, note 1–5).
- Erreurs renvoyées génériques (`unauthorized`, `invalid_input`,
  `github_write_failed`) — pas de fuite des messages GitHub.
- Le Worker n'expose **aucune** route de lecture du token ni d'introspection.

## Rotation de secret

```bash
wrangler secret put ADMIN_SHARED_SECRET
# puis mettre à jour le secret dans le panneau admin
```

## Mode dégradé

Si l'URL d'endpoint n'est pas configurée dans `admin.html`, le panneau
revient automatiquement au flux historique GitHub PAT — utile uniquement
pour le **propriétaire GitHub**, jamais pour Tony.

## Alternatives équivalentes

Le même contrat (`POST /publish-temoignage` avec `x-admin-secret`) peut être
implémenté en quelques lignes sur :

- Netlify Functions (`netlify/functions/publish-temoignage.js`)
- Vercel Functions (`api/publish-temoignage.js`)
- Deno Deploy

L'important est : **token GitHub côté serveur uniquement**.
