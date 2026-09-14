/**
 * The last deck, kept in this browser (IndexedDB) so reopening the app picks up where the
 * presentation stopped. Nothing leaves the computer.
 */
export interface RecentDeck {
  name: string;
  bytes: Uint8Array;
  pages: number;
  /** Last slide shown, 1-based. */
  page: number;
  savedAt: number;
}

const DB_NAME = 'airdeck';
const STORE = 'decks';
const KEY = 'last';
/** Bigger PDFs are not kept, to stay polite with browser storage. */
const MAX_BYTES = 80 * 1024 * 1024;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function loadRecentDeck(): Promise<RecentDeck | null> {
  try {
    const deck = await withStore<RecentDeck | undefined>('readonly', store => store.get(KEY));
    return deck && deck.bytes instanceof Uint8Array && deck.pages > 0 ? deck : null;
  } catch {
    return null;
  }
}

export async function saveRecentDeck(deck: Omit<RecentDeck, 'savedAt'>): Promise<boolean> {
  if (deck.bytes.byteLength > MAX_BYTES) return false;
  try {
    await withStore('readwrite', store => store.put({ ...deck, savedAt: Date.now() }, KEY));
    return true;
  } catch {
    return false;
  }
}

/** Remembers the slide the presentation is on, for the deck already saved. */
export async function saveRecentPage(page: number) {
  try {
    const deck = await loadRecentDeck();
    if (deck && deck.page !== page) await withStore('readwrite', store => store.put({ ...deck, page, savedAt: Date.now() }, KEY));
  } catch {
    // Storage blocked: resuming just starts from the first slide.
  }
}

export async function forgetRecentDeck() {
  try {
    await withStore('readwrite', store => store.delete(KEY));
  } catch {
    // Nothing stored.
  }
}
