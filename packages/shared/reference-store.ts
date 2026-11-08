/**
 * Attached reference images, kept across a page reload.
 *
 * The API form itself survives a refresh because it is plain JSON in
 * localStorage. References could not: they are `Blob`s behind `URL.createObjectURL`
 * handles, and an object URL is scoped to the document that made it — after a
 * reload the handle is dead and the bytes are gone. So a refresh mid-compose
 * kept the prompt and silently dropped the pictures it referred to, which is
 * the worst half to lose: the prompt still says @image1.
 *
 * IndexedDB rather than the alternatives:
 *   - localStorage cannot hold a Blob, and base64 of a few 4K references blows
 *     past its ~5 MB quota immediately.
 *   - Convex storage would mean uploading on every attach, paying for images
 *     the user may never generate with, and having to garbage-collect them.
 * IndexedDB stores Blobs natively, same-origin, with no network and no bill.
 *
 * Everything here fails soft. Private-browsing modes and hardened profiles can
 * refuse IndexedDB outright, and losing persistence is an inconvenience — never
 * a reason to break composing.
 */

const DB_NAME = "artsnack";
const DB_VERSION = 1;
const STORE = "api-references";
/** One record holding the whole set, so a save is an atomic replace. */
const RECORD_KEY = "current";

/**
 * A ceiling on what is worth keeping. Atlas accepts as many as 30 prepared
 * references, at up to 4 MiB each in this app, so the old 64 MiB ceiling erased
 * a valid 17-image Seedance compose on reload.
 */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

/** The persistable half of a RefImage: no object URL (dead after reload) and no
 *  grokBlob (lazily derived at submit, cheaper to redo than to store). */
export type StoredReference = {
  id: string;
  blob: Blob;
  aspect: number;
  /** Optional so records written before this metadata shipped still restore. */
  width?: number;
  height?: number;
  selected: boolean;
  sourceUrl?: string;
};

/**
 * Shape-check a record read back from IndexedDB.
 *
 * Exported so it is testable without a browser: this record outlives deploys,
 * so a renamed or retyped field would otherwise surface as an undefined blob
 * handed to URL.createObjectURL. Anything malformed is dropped rather than
 * repaired — a half-restored reference set is worse than none.
 */
export function parseStoredReferences(value: unknown): StoredReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is StoredReference =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as StoredReference).id === "string" &&
      (entry as StoredReference).blob instanceof Blob &&
      typeof (entry as StoredReference).aspect === "number" &&
      Number.isFinite((entry as StoredReference).aspect) &&
      ((entry as StoredReference).width === undefined ||
        (typeof (entry as StoredReference).width === "number" &&
          Number.isFinite((entry as StoredReference).width))) &&
      ((entry as StoredReference).height === undefined ||
        (typeof (entry as StoredReference).height === "number" &&
          Number.isFinite((entry as StoredReference).height))) &&
      ((entry as StoredReference).sourceUrl === undefined ||
        typeof (entry as StoredReference).sourceUrl === "string") &&
      typeof (entry as StoredReference).selected === "boolean",
  );
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // A blocked upgrade would otherwise leave this promise pending forever and
    // hang the caller's await.
    request.onblocked = () => resolve(null);
  });
}

/** Replace the stored set. Pass an empty array to clear it. */
export async function saveApiReferences(references: StoredReference[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const total = references.reduce((sum, ref) => sum + ref.blob.size, 0);
    const payload = total > MAX_TOTAL_BYTES ? [] : references;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(payload, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

/** The stored set, or an empty array when there is nothing (or IndexedDB is unavailable). */
export async function loadApiReferences(): Promise<StoredReference[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    return await new Promise<StoredReference[]>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(RECORD_KEY);
      request.onsuccess = () => resolve(parseStoredReferences(request.result));
      request.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    });
  } finally {
    db.close();
  }
}
