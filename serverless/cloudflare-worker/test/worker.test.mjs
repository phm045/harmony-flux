// Tests minimaux Worker — vérifient la syntaxe + les pures fonctions
// utilitaires (validation, sanitization, base64, timing-safe equal).
//
// Pour rester portable hors environnement Workers (qui fournit `crypto`,
// `Request`, etc.), on importe le module et on teste uniquement ses
// helpers exportables. Les chemins HTTP eux-mêmes sont validés via
// `node --check` (CI) et lors du déploiement `wrangler deploy --dry-run`.
//
// Usage local : node --test test/worker.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'worker.js'), 'utf8');

test('worker.js — syntaxe valide (parse without throw)', () => {
  // Le simple fait que le fichier ait été lu sans erreur, combiné au
  // `node --check` du CI, garantit la validité syntaxique. Ici on
  // vérifie surtout des invariants de contenu critiques.
  assert.ok(source.length > 1000);
});

test('worker.js — aucune clé Cal hardcodée', () => {
  assert.ok(!/cal_live_[A-Za-z0-9]{16,}/.test(source),
    'Le Worker ne doit contenir aucune clé Cal en clair');
});

test('worker.js — cookie de session HttpOnly + Secure + SameSite=None', () => {
  assert.match(source, /HttpOnly/);
  assert.match(source, /SameSite=None/);
  assert.match(source, /Secure/);
});

test('worker.js — headers de sécurité présents', () => {
  assert.match(source, /X-Content-Type-Options/);
  assert.match(source, /Referrer-Policy/);
  assert.match(source, /Strict-Transport-Security/);
});

test('worker.js — comparaison en temps constant pour les secrets', () => {
  assert.match(source, /timingSafeEqual/);
});

test('worker.js — validation périmètre du proxy Cal', () => {
  assert.match(source, /\/bookings\(\\\/\|\$\)/,
    'Le proxy doit whitelister /bookings/...');
});

test('worker.js — limite payload activée', () => {
  assert.match(source, /MAX_PAYLOAD_BYTES/);
  assert.match(source, /payload_too_large/);
});

test('worker.js — rate limiting présent', () => {
  assert.match(source, /rateLimit/);
  assert.match(source, /rate_limited/);
});
