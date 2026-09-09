// Open File Bridge — FS adapter core (Stage 3).
//
// Shared semantics ported from the desktop app (src/file_bridge.py v2.11):
// constants, ignore patterns, sensitive-name floor, root/permission layer,
// rate breaker, snapshots, trash, audit rows. The router lives in
// fs-adapter.js; pages and the SW both load this file first.

"use strict";

const FS_VERSION = "3.0.4-EXT";
const FS_SKILL_MIN = "2.11";
const MAX_LIST = 500;
const MAX_BINARY = 8000000;          // b64 endpoints
const MAX_READ = 200000;             // chars (text)
const MAX_LINE_CHARS = 500;
const DEFAULT_MAX_LINES = 2000;
const CHUNK = 1024 * 1024;           // 1 MB write chunks
const SNAP_DIR = ".ofb-snapshots";
const TRASH_DIR = ".ofb-trash";
const CHUNKS_DIR = ".ofb-chunks";
const SNAP_MAX_BYTES = 8000000;

const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".jsonl",
  ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".log", ".py", ".pyi", ".js", ".mjs", ".ts", ".jsx", ".tsx", ".html",
  ".htm", ".css", ".scss", ".less", ".svg", ".sql", ".sh", ".bash",
  ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".make", ".mk", ".dockerfile",
  ".tex", ".srt", ".vtt", ".sub", ".c", ".h", ".cpp", ".hpp", ".cc",
  ".java", ".rs", ".go", ".rb", ".php", ".pl", ".pm", ".lua", ".r",
  ".swift", ".kt", ".kts", ".scala", ".vue", ".svelte", ".diff", ".patch",
]);
const KNOWN_BASENAMES = new Set([
  "makefile", "dockerfile", "license", "licence", "readme", "changelog",
  "contributing", "authors", "notice", "codeowners", ".gitignore",
  ".gitattributes", ".dockerignore", ".editorconfig", ".env", ".npmrc",
  ".gitmodules",
]);
const SENSITIVE_NAMES = new Set([
  ".env", ".env.local", ".env.production", ".env.development",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk",
  "authorized_keys", "known_hosts", "ssh_config", "config.ssh",
  "credentials", "credentials.json", "credentials.xml", "secrets",
  "secrets.json", "secrets.yaml", "secrets.yml", "secrets.toml",
  ".npmrc", ".pypirc", ".netrc", ".htpasswd", ".git-credentials",
  "serviceaccount.json", "firebase-adminsdk",
]);
const SENSITIVE_EXTS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".kdbx", ".env"]);
const SENSITIVE_PATTERNS = new RegExp(
  "(^|[-_])(id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys|" +
  "credentials|secret|token|\\.htpasswd|\\.netrc|\\.pypirc|\\.npmrc)", "i");

const OFFICE_ZIP_EXTS = new Set([".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".epub"]);
const DEFAULT_IGNORE = [".DS_Store", "._*", "Thumbs.db", "desktop.ini",
  SNAP_DIR + "/", TRASH_DIR + "/", CHUNKS_DIR + "/"];

/* magic-byte signatures: list of [prefixString, kind] where the string's
 * char codes are compared to raw bytes (non-ASCII chars stand for their
 * low byte, mirroring the app's latin-1 flavored byte strings). */
const MAGIC = [
  ["%PDF-", "pdf"],
  ["PK\x03\x04", "zip"], ["PK\x05\x06", "zip"], ["PK\x07\x08", "zip"],
  ["\x89PNG", "image"], ["\xff\xd8\xff", "image"], ["GIF87a", "image"],
  ["GIF89a", "image"], ["BM", "image"], ["II*\x00", "image"],
  ["MM\x00*", "image"], ["RIFF", "binary"], ["\x7fELF", "binary"],
  ["MZ", "binary"], ["\xca\xfe\xba\xbe", "binary"],
  ["SQLite format 3\x00", "binary"], ["OggS", "binary"],
  ["fLaC", "binary"], ["ID3", "binary"], ["\x1f\x8b", "binary"],
  ["\xfd7zXZ\x00", "binary"], ["BZh", "binary"],
];

/* ---------------- small helpers ---------------- */

function fsFail(status, obj) { return { status, body: JSON.stringify(obj) }; }
function fsOk(obj) { return { status: 200, body: JSON.stringify(obj) }; }

function b64enc(bytes) {
  let bin = "";
  const CH = 32768;
  for (let i = 0; i < bytes.length; i += CH)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
function b64dec(s) {
  const bin = atob(String(s || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hexRand(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function unquoteComp(s) {
  try { return decodeURIComponent(String(s)); } catch (e) { return String(s); }
}
function parseQueryString(qs) {
  const out = {};
  let s = String(qs || "");
  const qIdx = s.indexOf("?");
  if (qIdx >= 0) s = s.slice(qIdx + 1);
  s.split("&").forEach((kv) => {
    if (!kv) return;
    const i = kv.indexOf("=");
    if (i < 0) out[kv] = "";
    else out[kv.slice(0, i)] = kv.slice(i + 1);
  });
  return out;
}
function extOf(name) {
  const m = String(name).match(/(\.[^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}
function sniffKind(head) {
  for (const [sig, kind] of MAGIC) {
    let match = true;
    if (head.length < sig.length) continue;
    for (let i = 0; i < sig.length; i++) {
      if (head[i] !== (sig.charCodeAt(i) & 0xff)) { match = false; break; }
    }
    if (match) return kind;
  }
  return null;
}
function routingHint(kind, ext) {
  if (kind === "pdf") return "PDF detected — use /pdf_text (text layer) or /ocr (scanned)";
  if (kind === "zip" && OFFICE_ZIP_EXTS.has(ext))
    return ext + " is a zip-based Office file — use /read_b64 and the Pyodide office stack (see skill)";
  if (kind === "zip") return "zip archive — use /read_b64 (Pyodide can open it via zipfile)";
  if (kind === "image") return "image file — use /ocr (for text in it) or /read_b64";
  return "binary file — /read_b64 if you truly need the bytes";
}

/* ---------------- ignore patterns (app _ignore_match port) ---------------- */

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function fnmatchStar(name, pat) {
  const rx = new RegExp("^" + pat.split("*").map(escapeRx).join(".*").replace(/\?/g, ".") + "$");
  return rx.test(name);
}
function ignoreMatch(rel, isDir, patterns) {
  const parts = rel.split("/").filter(Boolean);
  const cands = [];
  for (let i = 0; i < parts.length; i++) cands.push(parts.slice(0, i + 1).join("/"));
  for (const pat0 of patterns) {
    const pat = pat0.trim();
    if (!pat || pat.startsWith("#")) continue;
    let p = pat;
    const dirOnly = p.endsWith("/");
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.startsWith("/");
    if (anchored) p = p.slice(1);
    if (!p) continue;
    let tests;
    if (p.includes("/")) tests = cands;
    else if (anchored) tests = parts.slice(0, 1);
    else tests = parts;
    for (let i = 0; i < tests.length; i++) {
      if (i === tests.length - 1 && dirOnly && !isDir) continue;
      if (fnmatchStar(tests[i], p)) return pat0;
    }
  }
  return null;
}
function sensitiveName(name) {
  const base = String(name).split("/").pop().toLowerCase();
  if (SENSITIVE_NAMES.has(base)) return true;
  const i = base.lastIndexOf(".");
  if (i > 0 && SENSITIVE_EXTS.has(base.slice(i))) return true;
  return SENSITIVE_PATTERNS.test(base);
}
// Async since the settings-page ignore editor landed: the global list
// lives in the kv store (ignore_global), per-root extras on the root row.
async function allIgnorePatterns(rootRec) {
  const per = (rootRec && Array.isArray(rootRec.ignore)) ? rootRec.ignore : [];
  let global = await kvGet("ignore_global", []);
  if (!Array.isArray(global)) global = [];
  return per.concat(global, DEFAULT_IGNORE);
}

/* ---------------- kv / roots / permissions ---------------- */

async function kvGet(key, dflt) {
  try {
    const v = await OFBIDB.get("kv", key);
    return v === undefined ? dflt : v;
  } catch (e) { return dflt; }
}
async function kvSet(key, value) { await OFBIDB.put("kv", value, key); }

async function allRootRows() {
  try { return (await OFBIDB.all("roots")) || []; } catch (e) { return []; }
}
async function enabledRoots() {
  const rows = await allRootRows();
  return rows.filter((r) => r.enabled !== false && r.handle);
}

async function permState(handle, mode) {
  try { return await handle.queryPermission({ mode: mode || "readwrite" }); }
  catch (e) {
    try { return await handle.queryPermission({ mode: "read" }); }
    catch (e2) { return "denied"; }
  }
}

/* ---------------- OpFail + resolve (app resolve_any/guarded port) ------- */

class OpFail extends Error {
  constructor(status, obj) {
    super((obj && obj.error) || "op failed");
    this.status = status;
    this.obj = obj;
  }
}

const ROOT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Returns {rootRec, parts, relInRoot}. Throws OpFail with the app's shapes. */
async function resolveGuarded(rel, opts) {
  const forWrite = !!(opts && opts.forWrite);
  const roots = await enabledRoots();
  if (!roots.length) {
    throw new OpFail(503, {
      error: "no shared folder configured — click the Open File Bridge toolbar icon and choose a folder",
    });
  }
  let s = String(rel || "").trim();
  if (s.startsWith("/") || (s.length > 1 && s[1] === ":")) {
    throw new OpFail(400, {
      error: "absolute paths are not allowed — address files relative to a shared root",
    });
  }
  s = s.replace(/^\/+/, "").replace(/\\/g, "/");
  let rootRec = roots[0];
  const seg0 = s.split("/")[0];
  if (seg0 && ROOT_ID_RE.test(seg0) && roots.some((r) => r.id === seg0)) {
    rootRec = roots.find((r) => r.id === seg0);
    s = s.slice(seg0.length).replace(/^\/+/, "");
  }
  const parts = s.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..")) {
    throw new OpFail(400, { error: "path escapes shared root" });
  }
  if (!parts.length) {
    throw new OpFail(400, { error: "path is a root itself or empty" });
  }
  const relInRoot = parts.join("/");
  const leafName = parts[parts.length - 1];
  if (sensitiveName(leafName)) {
    throw new OpFail(403, {
      error: "'" + leafName + "' looks like a credential/secret file — the bridge refuses to serve it. Ask the user to handle it manually.",
    });
  }
  const hit = ignoreMatch(relInRoot, false, await allIgnorePatterns(rootRec));
  if (hit) {
    throw new OpFail(404, {
      error: "excluded by ignore settings: " + hit,
      excluded: true,
      hint: "excluded by settings — tell the user; ignore patterns are editable in the Open File Bridge settings page",
    });
  }
  // per-op permission re-check (plan §4.3): browser gate replaced the token
  const needed = forWrite ? "readwrite" : "read";
  const ps = await permState(rootRec.handle, needed);
  if (ps !== "granted") {
    throw new OpFail(403, {
      error: "permission needed: the browser requires the user to re-confirm access to '" +
        (rootRec.alias || rootRec.id) + "'",
      permission_needed: true,
      root_id: rootRec.id,
      mode: needed,
      hint: "tell the user: click the Open File Bridge toolbar icon and press Reconnect — the folder is NOT re-picked, permission is re-asked on the stored handle",
    });
  }
  if (forWrite) {
    // global switch from the settings page (Safety & recovery card) — same
    // 403 shape as the per-root flags below it
    if (await kvGet("readonly_global", false)) {
      throw new OpFail(403, { error: "read-only mode is active — writes are disabled" });
    }
    if (rootRec.mode === "read" || rootRec.readonly) {
      throw new OpFail(403, { error: "read-only mode is active — writes are disabled" });
    }
    if (rootRec.writesEnabled === false) {
      throw new OpFail(403, { error: "writes are disabled for this folder in the Open File Bridge settings" });
    }
  }
  return { rootRec, parts, relInRoot };
}

/** Walk to the parent dir of `parts`; returns {dir, fileName} or null. */
async function walkToParent(rootRec, parts, createDirs) {
  let dir = rootRec.handle;
  const fileName = parts[parts.length - 1];
  const dirParts = parts.slice(0, -1);
  for (const seg of dirParts) {
    try {
      dir = await dir.getDirectoryHandle(seg);
    } catch (e) {
      if (createDirs) dir = await dir.getDirectoryHandle(seg, { create: true });
      else return null;
    }
  }
  return { dir, fileName };
}

/** Get the File for a path or throw 404. */
async function getFileFor(rootRec, parts) {
  const w = await walkToParent(rootRec, parts, false);
  if (!w) throw new OpFail(404, { error: "no such file: " + parts.join("/") });
  let fh;
  try { fh = await w.dir.getFileHandle(w.fileName); }
  catch (e) { throw new OpFail(404, { error: "no such file: " + parts.join("/") }); }
  return await fh.getFile();
}

async function dirExists(rootRec, parts) {
  let dir = rootRec.handle;
  for (const seg of parts) {
    try { dir = await dir.getDirectoryHandle(seg); }
    catch (e) { return false; }
  }
  return true;
}

/* ---------------- rate breaker (60 s rolling window) ---------------- */

const _writeLog = { arr: [] };
async function rateLimits() {
  const w = await kvGet("rate_max_writes", 20);
  const mb = await kvGet("rate_max_mb", 50);
  return {
    w: Math.max(1, Math.min(Number(w) || 20, 10000)),
    b: Math.max(1, Math.min(Number(mb) || 50, 2048)) * 1024 * 1024,
  };
}
async function rateCheck(nbytes) {
  const now = Date.now();
  const lim = await rateLimits();
  _writeLog.arr = _writeLog.arr.filter((t) => now - t[0] < 60000);
  const count = _writeLog.arr.length;
  const bytes = _writeLog.arr.reduce((a, t) => a + t[1], 0);
  if (count + 1 > lim.w || bytes + nbytes > lim.b) {
    return {
      ok: false,
      err: "write-rate circuit breaker: " + count + " writes / " + Math.floor(bytes / 1024) +
        " KiB in the last 60 s (limits " + lim.w + " / " + Math.floor(lim.b / 1024 / 1024) +
        " MiB). STOP and ask the user to confirm the mass edit before continuing.",
    };
  }
  _writeLog.arr.push([now, nbytes]);
  return { ok: true };
}

/* ---------------- audit ---------------- */

async function auditRow(row) {
  try {
    await OFBIDB.add("audit", Object.assign({ ts: Date.now() }, row));
  } catch (e) { /* best effort */ }
}

/* ---------------- timestamps ---------------- */

function tsStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + "-" + hexRand(2);
}

/* ---------------- file copy / write primitives ---------------- */

async function bytesToFileHandle(bytes, fh) {
  const w = await fh.createWritable();
  await w.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  await w.close();
}

async function copyFileToFile(srcFile, dstHandle) {
  const w = await dstHandle.createWritable();
  const buf = new Uint8Array(await srcFile.arrayBuffer());
  await w.write(buf);
  await w.close();
}

async function removeQuiet(dirHandle, name) {
  try { await dirHandle.removeEntry(name); return true; } catch (e) { return false; }
}

/** Write bytes to root+parts creating parent dirs. Snapshot handled by the
 * caller (write endpoints) so the ORDER is always snapshot → write. */
async function writeFileBytes(rootRec, parts, bytes) {
  const w = await walkToParent(rootRec, parts, true);
  let target;
  try { target = await w.dir.getFileHandle(w.fileName, { create: true }); }
  catch (e) { throw new OpFail(404, { error: "cannot create file: " + parts.join("/") }); }
  await bytesToFileHandle(bytes, target);
  return w.fileName;
}

/* ---------------- snapshots (in-root .ofb-snapshots/, plan §5.4) -------- */

async function snapshotBeforeWrite(rootRec, parts) {
  try {
    let fh;
    const w = await walkToParent(rootRec, parts, false);
    if (!w) return null;
    try { fh = await w.dir.getFileHandle(w.fileName); } catch (e) { return null; }
    const file = await fh.getFile();
    if (file.size > SNAP_MAX_BYTES) return { skipped: "too_large", size: file.size };
    const ts = tsStamp();
    let dir = rootRec.handle;
    for (const seg of [SNAP_DIR, ts].concat(parts.slice(0, -1))) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    const dst = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    await copyFileToFile(file, dst);
    await auditRow({ op: "snapshot", path: parts.join("/"), size: file.size, status: 200 });
    return { ts: ts, path: parts.join("/"), size: file.size };
  } catch (e) {
    return { skipped: "error: " + e };
  }
}

async function collectDirFiles(dirHandle, prefix, out, targetRel) {
  for await (const [name, h] of dirHandle.entries()) {
    const rel = prefix.length ? prefix.join("/") + "/" + name : name;
    if (h.kind === "file") {
      if (!targetRel || rel === targetRel) {
        const f = await h.getFile();
        out.push({ path: rel, size: f.size, mtime: Math.floor(f.lastModified / 1000) });
      }
    } else {
      await collectDirFiles(h, prefix.concat(name), out, targetRel);
    }
  }
}

async function listSnapshotDirs(rootRec, dirName, targetRel) {
  const out = [];
  try {
    let root;
    try { root = await rootRec.handle.getDirectoryHandle(dirName); }
    catch (e) { return out; }
    for await (const [ts, h] of root.entries()) {
      if (h.kind !== "directory") continue;
      const entries = [];
      try { await collectDirFiles(h, [], entries, targetRel); } catch (e) {}
      out.push({ ts: ts, entries: entries });
    }
  } catch (e) { /* best effort */ }
  out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return out;
}
