// Synchronisation chiffrée entre appareils via un dépôt GitHub privé.
//
// Les données sont chiffrées sur l'appareil avant l'envoi (AES-GCM 256 bits, clé tirée
// de la phrase secrète par PBKDF2) : GitHub ne stocke que des fichiers illisibles.
// La phrase secrète n'est jamais enregistrée, seule la clé dérivée (non exportable) l'est.
//
// Un fichier par mois de repas plus un fichier commun (profil, réglages, aliments,
// suppressions) : chaque envoi reste petit et l'historique du dépôt grossit peu.
//
// Déroulé d'une synchronisation : lister les fichiers en ligne, télécharger ceux qui ont
// changé, les intégrer aux données locales (le plus récent gagne, suppressions comprises),
// puis renvoyer les fichiers dont le contenu diffère de la version en ligne.

import { db, rawDb, onDbChange } from './db.js';

const DIR = 'health-app';
const COMMON_PATH = `${DIR}/commun.json`;
const ENVELOPE = 'health-app-chiffre';
const PBKDF2_ITER = 600000;
const DEBOUNCE_MS = 4000;
const MAX_ATTEMPTS = 4;
const CONFIG_KEY = 'sync-config';
const LOCAL_KEY = 'sync-local';
const CACHE_KEY = 'sync-cache';
// Clés propres à chaque appareil : jamais synchronisées.
const DEVICE_KEYS = new Set(['draft', 'sim', 'meta']);
// Erreurs qui demandent une action de l'utilisateur (les autres se règlent seules).
const SERIOUS = new Set(['auth', 'forbidden', 'repo', 'public', 'passphrase', 'format', 'http']);

export class SyncError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------------------------------------------------------------- Encodage

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(String(b64).replace(/\s/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const canZip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// JSON aux clés triées : deux contenus identiques donnent toujours le même texte.
export function canonical(x) {
  return JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]]))
    : v));
}

// ---------------------------------------------------------------- Chiffrement

export async function deriveKey(passphrase, salt, iterations = PBKDF2_ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

// Le chemin du fichier est lié au chiffrement : un fichier déplacé ou échangé est refusé.
export async function seal(doc, key, saltB64, iterations, path) {
  let bytes = enc.encode(JSON.stringify(doc));
  if (canZip) bytes = await pipe(bytes, new CompressionStream('gzip'));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(path) }, key, bytes));
  return JSON.stringify({
    format: ENVELOPE, v: 1,
    kdf: { name: 'PBKDF2-SHA256', iter: iterations, salt: saltB64 },
    zip: canZip, iv: toB64(iv), data: toB64(data),
  });
}

export function readEnvelope(text) {
  let env;
  try { env = JSON.parse(text); } catch (e) { env = null; }
  if (!env || env.format !== ENVELOPE || !env.kdf || !env.iv || !env.data) {
    throw new SyncError('format', 'Un fichier du dépôt n’est pas une sauvegarde Health App.');
  }
  return env;
}

export async function unseal(env, key, path) {
  let bytes;
  try {
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: enc.encode(path) }, key, fromB64(env.data)));
  } catch (e) {
    throw new SyncError('passphrase', 'Phrase secrète incorrecte : impossible de lire les données en ligne.');
  }
  if (env.zip) bytes = await pipe(bytes, new DecompressionStream('gzip'));
  return JSON.parse(dec.decode(bytes));
}

// ---------------------------------------------------------------- GitHub

export function github({ repo, token }, fetchFn = (...a) => fetch(...a)) {
  const base = `https://api.github.com/repos/${repo}`;

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchFn(base + path, {
        method, cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new SyncError('network', 'Pas de connexion à GitHub.');
    }
    if (res.status === 401) throw new SyncError('auth', 'Clé d’accès GitHub refusée ou expirée. Si elle a expiré, créez-en une nouvelle et reconnectez cet appareil.');
    if (res.status === 403) throw new SyncError('forbidden', 'GitHub refuse l’accès : vérifiez que la clé a le droit « Contents : Read and write » sur ce dépôt.');
    return res;
  }

  async function fail(res) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch (e) { /* corps vide */ }
    return new SyncError('http', `Erreur GitHub ${res.status}${msg ? ` : ${msg}` : ''}.`);
  }

  return {
    async repo() {
      const res = await call('GET', '');
      if (res.status === 404) throw new SyncError('repo', 'Dépôt introuvable, ou la clé d’accès n’y a pas accès.');
      if (!res.ok) throw await fail(res);
      return res.json();
    },
    // Fichiers de l'app dans le dépôt : chemin → identifiant de contenu (sha).
    async list(branch) {
      const res = await call('GET', `/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (res.status === 409 || res.status === 404) return new Map(); // dépôt encore vide
      if (!res.ok) throw await fail(res);
      const { tree = [] } = await res.json();
      return new Map(tree
        .filter(t => t.type === 'blob' && t.path.startsWith(DIR + '/') && t.path.endsWith('.json'))
        .map(t => [t.path, t.sha]));
    },
    async read(sha) {
      const res = await call('GET', `/git/blobs/${sha}`);
      if (!res.ok) throw await fail(res);
      const j = await res.json();
      return dec.decode(fromB64(j.content));
    },
    // sha : version remplacée (absente pour un nouveau fichier). Refusé si le fichier a changé entre-temps.
    async write(path, text, sha) {
      const res = await call('PUT', `/contents/${path}`, {
        message: 'Health App : synchronisation chiffrée',
        content: toB64(enc.encode(text)),
        ...(sha ? { sha } : {}),
      });
      if (res.status === 409 || res.status === 422) throw new SyncError('conflict', 'Le dépôt a changé pendant l’envoi.');
      if (!res.ok) throw await fail(res);
      return (await res.json()).content.sha;
    },
  };
}

// ---------------------------------------------------------------- Fusion

const newer = (a, b) => (a.updatedAt || '') > (b.updatedAt || '');
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const monthOf = m => (/^\d{4}-\d{2}/.test(m.date || '') ? m.date.slice(0, 7) : 'sans-date');
const monthPath = k => `${DIR}/repas-${k}.json`;

function stripTheme(s) {
  if (!s) return null;
  const { theme, ...rest } = s;
  return rest;
}

function latest(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!out[k] || v > out[k]) out[k] = v;
  return out;
}

// Rassemble les fichiers en ligne (déjà déchiffrés) en un seul jeu de données.
export function collectRemote(files) {
  const common = files[COMMON_PATH]?.doc || {};
  return {
    meals: Object.entries(files).filter(([p]) => p !== COMMON_PATH).flatMap(([, f]) => f.doc.meals || []),
    foods: common.foods || [],
    equivs: common.equivs || {},
    profile: common.profile || null,
    profileAt: common.profileAt || '',
    settings: common.settings || null,
    settingsAt: common.settingsAt || '',
    deleted: { meals: common.deleted?.meals || {}, foods: common.deleted?.foods || {} },
  };
}

function planRecords(local, remote, deleted) {
  const cur = new Map(local.map(r => [r.id, r]));
  const best = new Map();
  for (const r of remote) { const b = best.get(r.id); if (!b || newer(r, b)) best.set(r.id, r); }
  const put = [];
  for (const [id, r] of best) {
    if (deleted[id] && deleted[id] >= (r.updatedAt || '')) continue;
    const c = cur.get(id);
    if (!c || newer(r, c)) put.push(r);
  }
  const putIds = new Set(put.map(r => r.id));
  const del = [...cur.values()]
    .filter(c => deleted[c.id] && deleted[c.id] >= (c.updatedAt || '') && !putIds.has(c.id))
    .map(c => c.id);
  return { put, del };
}

// Ce qu'il faut changer localement pour intégrer les données en ligne.
// local : { meals, foods, equivs, profile, settings } ; sync : { stamps, deleted, firstSyncDone }.
export function planApply(local, remote, sync) {
  const deleted = {
    meals: latest(sync.deleted.meals, remote.deleted.meals),
    foods: latest(sync.deleted.foods, remote.deleted.foods),
  };
  const meals = planRecords(local.meals, remote.meals, deleted.meals);
  const foods = planRecords(local.foods, remote.foods, deleted.foods);
  const stamps = { ...sync.stamps };
  const first = !sync.firstSyncDone;
  const plan = { meals, foods, deleted, stamps };

  // Profil et réglages : la version la plus récente gagne. À la toute première
  // synchronisation d'un appareil, c'est la version en ligne qui est reprise.
  // Contenu identique : on reprend la date en ligne, pour ne rien renvoyer pour rien
  // (par exemple après un simple changement de thème, propre à chaque appareil).
  if (remote.profile && canonical(remote.profile) === canonical(local.profile)) stamps.profile = remote.profileAt;
  if (remote.settings && canonical(remote.settings) === canonical(stripTheme(local.settings))) stamps.settings = remote.settingsAt;
  if (remote.profile && canonical(remote.profile) !== canonical(local.profile)
      && (first || !local.profile || remote.profileAt > (stamps.profile || ''))) {
    plan.profile = remote.profile;
    stamps.profile = remote.profileAt;
  }
  if (remote.settings && canonical(remote.settings) !== canonical(stripTheme(local.settings))
      && (first || !local.settings || remote.settingsAt > (stamps.settings || ''))) {
    plan.settings = { ...remote.settings, ...(local.settings?.theme ? { theme: local.settings.theme } : {}) };
    stamps.settings = remote.settingsAt;
  }
  const equivs = { ...remote.equivs, ...(local.equivs || {}) };
  if (canonical(equivs) !== canonical(local.equivs || {})) plan.equivs = equivs;
  return plan;
}

// Contenu attendu de chaque fichier en ligne à partir des données locales.
export function buildFiles(local, sync, existingPaths = []) {
  const files = new Map();
  files.set(COMMON_PATH, {
    v: 1, kind: 'commun',
    profile: local.profile || null, profileAt: sync.stamps.profile || '',
    settings: stripTheme(local.settings), settingsAt: sync.stamps.settings || '',
    equivs: local.equivs || {},
    foods: [...local.foods].sort(byId),
    deleted: sync.deleted,
  });
  // Un mois qui n'a plus de repas est vidé plutôt que supprimé.
  for (const p of existingPaths) {
    const m = /repas-(.+)\.json$/.exec(p);
    if (m) files.set(p, { v: 1, kind: 'repas', month: m[1], meals: [] });
  }
  const months = new Map();
  for (const meal of local.meals) {
    const k = monthOf(meal);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(meal);
  }
  for (const [k, list] of months) files.set(monthPath(k), { v: 1, kind: 'repas', month: k, meals: list.sort(byId) });
  return files;
}

// ---------------------------------------------------------------- Moteur

const S = {
  cfg: null,       // { repo, token, branch, key, salt, iter }
  local: null,     // { stamps, deleted, dirty, lastSync, firstSyncDone }
  cache: {},       // chemin → { sha, doc } : dernière version en ligne connue, déchiffrée
  status: { state: 'off' },
  running: null,
  again: false,
  timer: null,
  started: false,
  onApplied: () => {},
  onStatus: () => {},
};

const freshLocal = () => ({ stamps: {}, deleted: { meals: {}, foods: {} }, dirty: 0, lastSync: null, firstSyncDone: false });
const saveLocal = () => rawDb.set(LOCAL_KEY, S.local);

function setStatus(st) {
  S.status = st;
  try { S.onStatus(syncStatus()); } catch (e) { console.error(e); }
}

export function syncStatus() {
  return {
    ...S.status,
    enabled: !!S.cfg,
    repo: S.cfg?.repo || null,
    lastSync: S.local?.lastSync || null,
    serious: S.status.state === 'error' && SERIOUS.has(S.status.code),
  };
}

function onChange(kind, store, key) {
  if (store === 'kv' && (DEVICE_KEYS.has(key) || String(key).startsWith('sync-'))) return;
  const now = new Date().toISOString();
  if (kind === 'del' && (store === 'meals' || store === 'foods')) S.local.deleted[store][key] = now;
  if (kind === 'set' && (key === 'profile' || key === 'settings')) S.local.stamps[key] = now;
  S.local.dirty++;
  saveLocal();
  schedule();
}

function schedule() {
  if (!S.cfg) return;
  clearTimeout(S.timer);
  S.timer = setTimeout(() => syncNow(), DEBOUNCE_MS);
}

export async function startSync({ onApplied, onStatus } = {}) {
  if (S.started) return;
  S.started = true;
  if (onApplied) S.onApplied = onApplied;
  if (onStatus) S.onStatus = onStatus;
  const [cfg, local, cache] = await Promise.all([db.get(CONFIG_KEY), db.get(LOCAL_KEY), db.get(CACHE_KEY)]);
  S.cfg = cfg || null;
  S.local = { ...freshLocal(), ...(local || {}) };
  S.cache = cache || {};
  onDbChange(onChange);

  // À l'ouverture et au retour dans l'app : récupérer. En quittant : envoyer ce qui attend.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || S.local.dirty) syncNow();
  });
  window.addEventListener('pagehide', () => { if (S.local.dirty) syncNow(); });
  window.addEventListener('online', () => syncNow());

  setStatus({ state: S.cfg ? 'idle' : 'off' });
  if (S.cfg) syncNow();
}

export function syncNow() {
  if (!S.cfg) return Promise.resolve();
  if (S.running) { S.again = true; return S.running; }
  S.running = (async () => {
    try {
      do { S.again = false; await runOnce(); } while (S.again && S.cfg);
    } finally {
      S.running = null;
    }
  })();
  return S.running;
}

async function runOnce() {
  clearTimeout(S.timer);
  if (navigator.onLine === false) { setStatus({ state: 'offline' }); return; }
  setStatus({ state: 'syncing' });
  for (let attempt = 1; ; attempt++) {
    try {
      await syncCore();
      S.local.lastSync = new Date().toISOString();
      await saveLocal();
      setStatus({ state: 'ok' });
      return;
    } catch (e) {
      if (e.code === 'conflict' && attempt < MAX_ATTEMPTS) continue;
      if (!(e instanceof SyncError)) console.error(e);
      setStatus(e.code === 'network'
        ? { state: 'offline' }
        : { state: 'error', code: e.code || 'bug', message: e.message || String(e) });
      return;
    }
  }
}

async function readLocal() {
  const [meals, foods, equivs, profile, settings] = await Promise.all([
    db.all('meals'), db.all('foods'), db.get('equivs'), db.get('profile'), db.get('settings'),
  ]);
  return { meals: meals || [], foods: foods || [], equivs: equivs || {}, profile: profile || null, settings: settings || null };
}

async function syncCore() {
  const cfg = S.cfg;
  const gh = github(cfg);
  const dirtyAtStart = S.local.dirty;

  // 1. Récupérer les fichiers qui ont changé en ligne.
  const remoteFiles = await gh.list(cfg.branch);
  for (const [path, sha] of remoteFiles) {
    if (S.cache[path]?.sha === sha) continue;
    const env = readEnvelope(await gh.read(sha));
    if (env.kdf.salt !== cfg.salt || env.kdf.iter !== cfg.iter) {
      throw new SyncError('passphrase', 'Les données en ligne ont été chiffrées avec une autre phrase secrète : déconnectez cet appareil puis reconnectez-le.');
    }
    S.cache[path] = { sha, doc: await unseal(env, cfg.key, path) };
  }
  for (const path of Object.keys(S.cache)) if (!remoteFiles.has(path)) delete S.cache[path];
  await rawDb.set(CACHE_KEY, S.cache);

  // 2. Les intégrer aux données locales.
  const plan = planApply(await readLocal(), collectRemote(S.cache), S.local);
  let changed = false;
  for (const [store, p] of [['meals', plan.meals], ['foods', plan.foods]]) {
    for (const id of p.del) { await rawDb.del(store, id); changed = true; }
    if (p.put.length) { await rawDb.putMany(store, p.put); changed = true; }
  }
  if (plan.profile) { await rawDb.set('profile', plan.profile); changed = true; }
  if (plan.settings) { await rawDb.set('settings', plan.settings); changed = true; }
  if (plan.equivs) { await rawDb.set('equivs', plan.equivs); changed = true; }
  S.local.deleted = plan.deleted;
  S.local.stamps = { ...S.local.stamps, ...plan.stamps };
  await saveLocal();
  if (changed) { try { await S.onApplied(); } catch (e) { console.error(e); } }

  // 3. Envoyer les fichiers dont le contenu diffère de la version en ligne.
  const files = buildFiles(await readLocal(), S.local, Object.keys(S.cache));
  for (const [path, doc] of files) {
    const cur = S.cache[path];
    if (cur && canonical(cur.doc) === canonical(doc)) continue;
    const text = await seal(doc, cfg.key, cfg.salt, cfg.iter, path);
    const sha = await gh.write(path, text, cur?.sha);
    S.cache[path] = { sha, doc: JSON.parse(JSON.stringify(doc)) };
    await rawDb.set(CACHE_KEY, S.cache);
  }

  S.local.firstSyncDone = true;
  S.local.dirty = Math.max(0, S.local.dirty - dirtyAtStart);
  if (S.local.dirty) S.again = true;
}

// ---------------------------------------------------------------- Connexion

export function normalizeRepo(input) {
  return String(input || '').trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\/+$/, '').replace(/\.git$/i, '');
}

export async function connectSync({ repo, token, passphrase, confirm }) {
  repo = normalizeRepo(repo);
  token = String(token || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new SyncError('input', 'Indiquez le dépôt sous la forme utilisateur/nom, par exemple gab22222/health-app-donnees.');
  if (!token) throw new SyncError('input', 'Collez la clé d’accès GitHub.');
  if ((passphrase || '').length < 10) throw new SyncError('input', 'Choisissez une phrase secrète d’au moins 10 caractères.');
  if (passphrase !== confirm) throw new SyncError('input', 'Les deux phrases secrètes ne correspondent pas.');

  const gh = github({ repo, token });
  const info = await gh.repo();
  if (!info.private) throw new SyncError('public', 'Ce dépôt est public : choisissez un dépôt privé.');
  const branch = info.default_branch || 'main';
  const files = await gh.list(branch);

  let salt, iter = PBKDF2_ITER, key;
  const [path, sha] = files.has(COMMON_PATH) ? [COMMON_PATH, files.get(COMMON_PATH)] : [...files][0] || [];
  if (path) {
    // Des données existent déjà : la phrase secrète doit permettre de les lire.
    const env = readEnvelope(await gh.read(sha));
    salt = fromB64(env.kdf.salt);
    iter = env.kdf.iter;
    key = await deriveKey(passphrase, salt, iter);
    await unseal(env, key, path);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKey(passphrase, salt, iter);
  }

  S.cfg = { repo, token, branch, key, salt: toB64(salt), iter };
  await rawDb.set(CONFIG_KEY, S.cfg);
  S.cache = {};
  await rawDb.set(CACHE_KEY, S.cache);
  S.local = { ...S.local, firstSyncDone: false, lastSync: null };
  await saveLocal();
  await syncNow();
  return syncStatus();
}

export async function disconnectSync() {
  clearTimeout(S.timer);
  S.cfg = null;
  S.cache = {};
  await rawDb.set(CONFIG_KEY, null);
  await rawDb.set(CACHE_KEY, {});
  S.local = { ...S.local, firstSyncDone: false, lastSync: null };
  await saveLocal();
  setStatus({ state: 'off' });
}
