// Saved designs, kept in this browser's IndexedDB.
// Item: { id, name, created, updated, state, thumb (Blob) }

const DB_NAME = 'particle-shore';
const STORE = 'designs';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('this browser has no IndexedDB storage'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('could not open storage'));
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error || new Error('storage error'));
    tx.onabort = () => reject(tx.error || new Error('storage was aborted (out of space?)'));
  });
}

export async function listDesigns() {
  const all = await run('readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => b.updated - a.updated);
}

export function getDesign(id) {
  return run('readonly', (s) => s.get(id));
}

export function putDesign(item) {
  return run('readwrite', (s) => s.put(item));
}

export function deleteDesign(id) {
  return run('readwrite', (s) => s.delete(id));
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
