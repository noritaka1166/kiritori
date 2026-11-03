// Shared local storage for recoverable editor drafts. This file has no side effects
// until one of the exported methods is called.
const draftDatabaseName = "kiritori-editor-drafts";
const draftStoreName = "drafts";
let draftDatabasePromise;

function openDraftDatabase() {
  if (draftDatabasePromise) return draftDatabasePromise;
  draftDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(draftDatabaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(draftStoreName)) {
        request.result.createObjectStore(draftStoreName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); draftDatabasePromise = undefined; };
      resolve(database);
    };
    request.onerror = () => { draftDatabasePromise = undefined; reject(request.error); };
    request.onblocked = () => { draftDatabasePromise = undefined; reject(new Error("Draft database is blocked")); };
  });
  return draftDatabasePromise;
}

async function draftTransaction(mode, operation) {
  const database = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(draftStoreName, mode);
    const request = operation(transaction.objectStore(draftStoreName));
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error);
  });
}

export const draftStore = {
  get(id) { return draftTransaction("readonly", (store) => store.get(id)); },
  async list() {
    const database = await openDraftDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(draftStoreName, "readonly");
      const request = transaction.objectStore(draftStoreName).openCursor();
      const entries = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const { id, meta, updatedAt, expiresAt } = cursor.value;
        entries.push({ id, meta, updatedAt, expiresAt });
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(entries);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error);
    });
  },
  put(draft) { return draftTransaction("readwrite", (store) => store.put(draft)); },
  async update(id, changes) {
    const database = await openDraftDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(draftStoreName, "readwrite");
      const store = transaction.objectStore(draftStoreName);
      const request = store.get(id);
      let found = false;
      request.onsuccess = () => {
        if (!request.result) return;
        found = true;
        store.put({ ...request.result, ...changes, id });
      };
      transaction.oncomplete = () => resolve(found);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error);
    });
  },
  delete(id) { return draftTransaction("readwrite", (store) => store.delete(id)); },
  clear() { return draftTransaction("readwrite", (store) => store.clear()); },
  async deleteExpired(now = Date.now()) {
    const database = await openDraftDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(draftStoreName, "readwrite");
      const request = transaction.objectStore(draftStoreName).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (Number.isFinite(cursor.value.expiresAt) && cursor.value.expiresAt <= now) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error);
    });
  }
};
