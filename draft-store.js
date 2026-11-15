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
    let result;
    const setResult = (value) => { result = value; };
    const request = operation(transaction.objectStore(draftStoreName), setResult);
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error || request?.error);
  });
}

function runRequest(mode, operation) {
  return draftTransaction(mode, (store, setResult) => {
    const request = operation(store);
    request.onsuccess = () => setResult(request.result);
    return request;
  });
}

function visitDrafts(mode, visit, initialResult) {
  return draftTransaction(mode, (store, setResult) => {
    setResult(initialResult);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      visit(cursor);
      cursor.continue();
    };
    return request;
  });
}

export const draftStore = {
  get(id) { return runRequest("readonly", (store) => store.get(id)); },
  list() {
    const entries = [];
    return visitDrafts("readonly", (cursor) => {
      const { id, meta, updatedAt, expiresAt } = cursor.value;
      entries.push({ id, meta, updatedAt, expiresAt });
    }, entries);
  },
  put(draft) { return runRequest("readwrite", (store) => store.put(draft)); },
  update(id, changes) {
    return draftTransaction("readwrite", (store, setResult) => {
      setResult(false);
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result) return;
        store.put({ ...request.result, ...changes, id });
        setResult(true);
      };
      return request;
    });
  },
  delete(id) { return runRequest("readwrite", (store) => store.delete(id)); },
  clear() { return runRequest("readwrite", (store) => store.clear()); },
  deleteExpired(now = Date.now()) {
    return visitDrafts("readwrite", (cursor) => {
      if (Number.isFinite(cursor.value.expiresAt) && cursor.value.expiresAt <= now) cursor.delete();
    });
  }
};
