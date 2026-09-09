// Open File Bridge — IndexedDB wrapper (Stage 3).
//
// Shared by the service worker (fs-adapter) and the extension pages
// (setup/options). One database per extension origin:
//   roots     {id, alias, mode, handle, grantedAt, writesEnabled, ignore}
//   kv        settings (ocr_lang, link_ttl, rate_max_writes, rate_max_mb,
//             ignore_global)
//   audit     append-only op rows {ts, endpoint, method, path, size, status}
//   clicks    {token, kind, path, expiry}
//   transfers chunked-write records {tid, rootId, relPath, total, received,
//             partName, ts, status}
//
// FileSystemHandles are structured-cloneable and survive SW death here —
// chrome.storage.local CANNOT hold them (that's why this is IndexedDB).

const OFBIDB = (() => {
  const DB_NAME = "ofb-ext";
  const VERSION = 2;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("roots"))
          db.createObjectStore("roots", { keyPath: "id" });
        if (!db.objectStoreNames.contains("kv"))
          db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("audit"))
          db.createObjectStore("audit", { autoIncrement: true });
        if (!db.objectStoreNames.contains("clicks"))
          db.createObjectStore("clicks", { keyPath: "token" });
        if (!db.objectStoreNames.contains("transfers"))
          db.createObjectStore("transfers", { keyPath: "tid" });
        // v2 (2026-09-09): confirmation asks/verdicts SURVIVE service-worker
        // death — MV3 SWs die after ~30 s idle and were eating approvals
        if (!db.objectStoreNames.contains("confirm"))
          db.createObjectStore("confirm", { keyPath: "id" });
      };
      req.onsuccess = () => {
        // A v1 connection in another context (e.g. an options tab open
        // since before the upgrade) would BLOCK this open forever —
        // yield on versionchange so upgrades always go through.
        req.result.onversionchange = () => {
          req.result.close();
          dbp = null;
        };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      try {
        const out = fn(os);
        if (out && typeof out.onsuccess === "undefined") result = out;
        else {
          out.onsuccess = () => { result = out.result; };
          out.onerror = () => reject(out.error);
        }
      } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("tx aborted"));
    });
  }

  return {
    get: (store, key) => run(store, "readonly", (os) => os.get(key)),
    all: (store) => run(store, "readonly", (os) => os.getAll()),
    put: (store, value, key) =>
      run(store, "readwrite", (os) =>
        key === undefined ? os.put(value) : os.put(value, key)),
    del: (store, key) => run(store, "readwrite", (os) => os.delete(key)),
    add: (store, value) => run(store, "readwrite", (os) => os.add(value)),
    count: (store) => run(store, "readonly", (os) => os.count()),
  };
})();
