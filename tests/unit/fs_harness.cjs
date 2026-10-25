// In-memory FileSystemHandle doubles + a VM context that loads the REAL
// extension modules (fs-core / fs-adapter / fs-writes / fs-confirm).
// Used by the 3.7.3 review-regression suite; no browser needed.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.resolve(__dirname, "..", "..", "extension");

class File {
  constructor(name, bytes) {
    this.kind = "file";
    this.name = name;
    this._bytes = Buffer.from(bytes || "");
    this.lastModified = 1700000000000;
  }
  async getFile() {
    const b = this._bytes;
    return {
      name: this.name,
      size: b.length,
      lastModified: this.lastModified,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
      text: async () => b.toString("utf8"),
      slice: (a, z) => ({ arrayBuffer: async () => b.buffer.slice(b.byteOffset + (a || 0), b.byteOffset + Math.min(z === undefined ? b.length : z, b.length)) }),
    };
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (d) => { chunks.push(Buffer.from(d)); },
      close: async () => { this._bytes = Buffer.concat(chunks); },
    };
  }
}

class Dir {
  constructor(name) {
    this.kind = "directory";
    this.name = name;
    this.children = new Map();
  }
  async queryPermission() { return "granted"; }
  async getDirectoryHandle(name, opts) {
    let h = this.children.get(name);
    if (h && h.kind !== "directory") {
      const err = new Error("TypeMismatchError: " + name);
      err.name = "TypeMismatchError";
      throw err;
    }
    if (!h && opts && opts.create) {
      h = new Dir(name);
      this.children.set(name, h);
    }
    if (!h || h.kind !== "directory") throw new Error("NotFoundError: " + name);
    return h;
  }
  async getFileHandle(name, opts) {
    let h = this.children.get(name);
    if (h && h.kind !== "file") {
      const err = new Error("TypeMismatchError: " + name);
      err.name = "TypeMismatchError";
      throw err;
    }
    if (!h && opts && opts.create) {
      h = new File(name);
      this.children.set(name, h);
    }
    if (!h || h.kind !== "file") throw new Error("NotFoundError: " + name);
    return h;
  }
  async removeEntry(name, opts) {
    const h = this.children.get(name);
    if (!h) throw new Error("NotFoundError: " + name);
    if (h.kind === "directory" && !(opts && opts.recursive) && h.children.size) {
      throw new Error("InvalidModificationError");
    }
    this.children.delete(name);
  }
  async *entries() { yield* this.children.entries(); }
  /* test helpers */
  file(name, text) { this.children.set(name, new File(name, text || "x")); return this; }
  /** existing-or-new subdirectory (never clobbers a populated one) */
  dir(name) {
    let d = this.children.get(name);
    if (!d || d.kind !== "directory") { d = new Dir(name); this.children.set(name, d); }
    return d;
  }
  has(name) { return this.children.has(name); }
  names() { return [...this.children.keys()].sort(); }
}

const MEM = new Map();
const OFBIDB = {
  async get(s, k) { return MEM.get(s + "|" + k); },
  async put(s, v, k) { MEM.set(s + "|" + (k !== undefined ? k : (v && (v.id || v.tid))), v); },
  async del(s, k) { MEM.delete(s + "|" + k); },
  async add(s, v) { MEM.set(s + "|auto" + MEM.size, v); },
  async all(s) { return [...MEM.entries()].filter(([k]) => k.startsWith(s + "|")).map(([, v]) => v); },
};

/** Build a VM context with the real modules loaded. `overrides` is a map
 * of extra statements evaluated AFTER the modules (to stub chrome calls,
 * gates, delays). */
function load(opts) {
  const o = opts || {};
  const sent = [];
  const ctx = vm.createContext({
    console, URL, TextEncoder, TextDecoder, Buffer, setTimeout, clearTimeout,
    setImmediate, btoa, atob,
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } },
    chrome: {
      tabs: { sendMessage: (tabId, msg) => { sent.push({ tabId, msg }); }, create: () => {} },
      action: { onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} },
        onStartup: { addListener() {} }, getURL: (p) => "chrome-extension://test/" + p },
      permissions: { onRemoved: { addListener() {} }, contains: async () => false },
      offscreen: { hasCreate: async () => false },
      alarms: { create() {}, onAlarm: { addListener() {} } },
    },
    indexedDB: { open: () => ({ onerror: null, onsuccess: null, onupgradeneeded: null }) },
  });
  ctx.OFBIDB = OFBIDB;
  for (const f of ["fs-core.js", "fs-adapter.js", "fs-writes.js", "fs-confirm.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
  }
  // deterministic, quiet defaults; tests override what they care about
  vm.runInContext(`
    kvGet = async (_k, d) => d;
    kvSet = async () => {};
    auditRow = async () => {};
    rateCheck = async () => ({ ok: true });
    maybeSweepMaintenance = async () => ({});
    secGate = async () => null;
    allIgnorePatterns = async () => [];
    _SENT = [];
    _pushLog = [];
    pushConfirmPopup = function (id, entry) { _pushLog.push({ id: id, tabId: entry.tabId, op: entry.op }); };
  `, ctx);
  if (o.setup) vm.runInContext(o.setup, ctx);
  return {
    ctx, sent,
    run: (code) => vm.runInContext(code, ctx),
    roots(roots) {
      ctx.__roots = roots;
      vm.runInContext("enabledRoots = async () => __roots;", ctx);
      return this;
    },
    /** fsRoute as the SW calls it: the tab id is request-local context. */
    async call(method, p, body, tabId) {
      const bodyText = body === undefined ? null : JSON.stringify(body);
      ctx.__ctx = { tabId: tabId === undefined ? null : tabId };
      return vm.runInContext(
        `fsRoute(${JSON.stringify(method)}, ${JSON.stringify(p)}, ${JSON.stringify(bodyText)}, false, __ctx)`,
        ctx);
    },
    json(resp) { return JSON.parse(resp.body || "{}"); },
    /** values that left the VM realm (arrays/objects) as plain JS */
    plain(v) { return JSON.parse(JSON.stringify(v)); },
  };
}

module.exports = { Dir, File, load, OFBIDB, MEM };
