'use client';

import {
  capBody,
  pruneHistory,
  type HistoryEntry,
  HISTORY_MAX_ENTRIES,
} from './prune';

/*
 * Where history is kept.
 *
 * IndexedDB rather than localStorage: a recorded body can be tens of
 * kilobytes, and localStorage writes are synchronous on the main thread, so
 * saving a response would stutter the UI it just rendered. IndexedDB is also
 * the only client store with room for a hundred of them.
 *
 * Everything degrades to "no history" rather than throwing. A browser in
 * private mode, with storage disabled, or over quota must still be able to
 * send requests — history is a convenience, not a dependency.
 */

const DB_NAME = 'wac-history';
const STORE = 'entries';
const VERSION = 1;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('at', 'at');
        store.createIndex('requestId', 'requestId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function finish(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function listHistory(): Promise<HistoryEntry[]> {
  const db = await open();
  if (!db) return [];
  try {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).getAll();
    const entries = await new Promise<HistoryEntry[]>((resolve) => {
      request.onsuccess = () => resolve(request.result as HistoryEntry[]);
      request.onerror = () => resolve([]);
    });
    return entries.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Records one response and enforces the retention policy. */
export async function recordHistory(
  entry: Omit<HistoryEntry, 'id' | 'at' | 'bodyTruncated'> & { at?: number },
): Promise<HistoryEntry | null> {
  const db = await open();
  if (!db) return null;

  const capped = capBody(entry.body);
  const stored: HistoryEntry = {
    ...entry,
    body: capped.body,
    bodyTruncated: capped.truncated,
    at: entry.at ?? Date.now(),
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };

  try {
    const existing = await (async () => {
      const read = db.transaction(STORE, 'readonly');
      const request = read.objectStore(STORE).getAll();
      return new Promise<HistoryEntry[]>((resolve) => {
        request.onsuccess = () => resolve(request.result as HistoryEntry[]);
        request.onerror = () => resolve([]);
      });
    })();

    const keep = pruneHistory([stored, ...existing]);
    const keepIds = new Set(keep.map((item) => item.id));

    const write = db.transaction(STORE, 'readwrite');
    const store = write.objectStore(STORE);
    store.put(stored);
    for (const item of existing) {
      if (!keepIds.has(item.id)) store.delete(item.id);
    }
    await finish(write);
    return stored;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function clearHistory(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).clear();
    await finish(transaction);
  } catch {
    // Nothing to do: the next read simply returns whatever survived.
  } finally {
    db.close();
  }
}

export { HISTORY_MAX_ENTRIES };
export type { HistoryEntry };
