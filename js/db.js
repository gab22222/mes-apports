// Stockage local (IndexedDB). Chaque modification est écrite immédiatement.

const DB_NAME = 'mes-apports';
const DB_VERSION = 2;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meals')) db.createObjectStore('meals', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('foods')) db.createObjectStore('foods', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('weekly')) db.createObjectStore('weekly', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    const req = fn(s);
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

// Écritures sans notification : utilisées par la synchronisation pour appliquer
// les données reçues sans se redéclencher elle-même.
export const rawDb = {
  put: (store, obj) => run(store, 'readwrite', s => s.put(obj)),
  del: (store, id) => run(store, 'readwrite', s => s.delete(id)),
  set: (key, value) => run('kv', 'readwrite', s => s.put(value, key)),
  async putMany(store, list) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      list.forEach(o => s.put(o));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
};

// Chaque écriture de l'app prévient les abonnés (la synchronisation).
const listeners = new Set();
export function onDbChange(fn) { listeners.add(fn); }
function notify(kind, store, key) {
  listeners.forEach(fn => { try { fn(kind, store, key); } catch (e) { console.error(e); } });
}

export const db = {
  all: store => run(store, 'readonly', s => s.getAll()),
  put: (store, obj) => rawDb.put(store, obj).then(r => { notify('put', store, obj.id); return r; }),
  del: (store, id) => rawDb.del(store, id).then(r => { notify('del', store, id); return r; }),
  get: key => run('kv', 'readonly', s => s.get(key)),
  set: (key, value) => rawDb.set(key, value).then(r => { notify('set', 'kv', key); return r; }),
  async putMany(store, list) {
    await rawDb.putMany(store, list);
    if (list.length) notify('putMany', store);
  },
  async clearAll() {
    for (const store of ['meals', 'foods', 'weekly', 'kv']) await run(store, 'readwrite', s => s.clear());
  },
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
