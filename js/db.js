// Minimal IndexedDB wrapper. Two stores: "sessions" (keyPath id) and "kv" (key/value).
const DB_NAME = 'workout-coach';
const DB_VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  async getAllSessions() { return tx('sessions', 'readonly', s => reqP(s.getAll())); },
  async putSession(sess) { return tx('sessions', 'readwrite', s => { s.put(sess); }); },
  async putSessions(list) { return tx('sessions', 'readwrite', s => { list.forEach(x => s.put(x)); }); },
  async deleteSession(id) { return tx('sessions', 'readwrite', s => { s.delete(id); }); },
  async clearSessions() { return tx('sessions', 'readwrite', s => { s.clear(); }); },
  async get(key) { return tx('kv', 'readonly', s => reqP(s.get(key))); },
  async set(key, val) { return tx('kv', 'readwrite', s => { s.put(val, key); }); },
  async del(key) { return tx('kv', 'readwrite', s => { s.delete(key); }); },
};

// Ask the browser not to evict our data (important on iOS).
export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {}
  return false;
}
