/**
 * Minimal IndexedDB key/value store for the song pack (audio blobs, lyric text, timing).
 * localStorage cannot hold 10 MB of audio; IndexedDB persists per origin and survives reloads.
 * Every call degrades to a rejected promise (never a hang) when storage is blocked.
 */

const DB_NAME = 'pitchhero';
const STORE = 'files';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB.'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'));
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
        tx.oncomplete = () => db.close();
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
        };
      }),
  );
}

export const idb = {
  get<T = unknown>(key: string): Promise<T | undefined> {
    return run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  put(key: string, value: unknown): Promise<void> {
    return run('readwrite', (s) => s.put(value, key)).then(() => undefined);
  },
  delete(key: string): Promise<void> {
    return run('readwrite', (s) => s.delete(key)).then(() => undefined);
  },
  keys(): Promise<string[]> {
    return run<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((ks) => ks.map(String));
  },
};
