#!/usr/bin/env node
// REAL-browser check for the 2026-10-25 review findings F2–F5.
//
// Loads the unpacked extension in Chromium, then drives the REAL service
// worker with REAL FileSystemDirectoryHandles (OPFS folders stand in for
// user-picked ones — same handle API the extension uses in production).
//
//   node tests/unit/browser_smoke.mjs <path-to-extension-dir>
//
// Needs `playwright` resolvable and an extension-capable Chromium
// (channel "chromium"); the headless shell cannot load extensions.
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert";

const EXT = process.argv[2];
if (!EXT) { console.error("usage: node browser_smoke.mjs <extension-dir>"); process.exit(2); }
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-smoke-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: process.env.OFB_BROWSER_CHANNEL || "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
console.log("service worker:", sw.url());

const res = await sw.evaluate(async () => {
  const opfs = await navigator.storage.getDirectory();
  try { for (const [n] of await opfs.entries()) await opfs.removeEntry(n, { recursive: true }); } catch (e) {}
  const mk = async (name, layout) => {
    const base = await opfs.getDirectoryHandle(name, { create: true });
    for (const [p, t] of Object.entries(layout)) {
      const parts = p.split("/");
      let d = base;
      for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
      const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable(); await w.write(t); await w.close();
    }
    return base;
  };
  const A = await mk("rootA", { "same.txt": "in A", "a-only.txt": "A" });
  const B = await mk("rootB", { "same.txt": "in B", "b-only.txt": "B", "sub/target4.txt": "deep B" });
  enabledRoots = async () => [
    { id: "rA", alias: "Shared", enabled: true, handle: A },
    { id: "rB", alias: "Archive", enabled: true, handle: B },
  ];
  const call = async (m, p, body) => {
    const r = await fsRoute(m, p, body === undefined ? null : JSON.stringify(body), false, { tabId: 5 });
    return { status: r.status, body: JSON.parse(r.body || "{}") };
  };
  const snap = async (d) => { const o = []; for await (const [n] of d.entries()) o.push(n); return o.sort(); };
  const log = { version: FS_VERSION };

  const f = await call("GET", "/find?name=target4");
  log.find = f.body.matches.map((m) => m.path);
  log.roundtrip = [];
  for (const m of f.body.matches) {
    const st = await call("GET", "/stat?path=" + encodeURIComponent(m.path));
    log.roundtrip.push([m.path, st.status, st.body.path, st.body.root_id]);
  }
  log.same = [];
  for (const m of (await call("GET", "/find?name=same")).body.matches) {
    const rd = await call("GET", "/read?path=" + encodeURIComponent(m.path) + "&raw=1");
    log.same.push([m.path, String(rd.body.content || "").trim()]);
  }
  log.cap1 = (await call("GET", "/find?name=o&max=1")).body.truncated;
  log.capFew = (await call("GET", "/find?name=only&max=50")).body.truncated;
  log.exactCap = (await call("GET", "/find?name=only&max=2")).body.truncated;

  const before = await snap(A);
  confirmGate = async () => ({ denied: true });
  const denied = await call("POST", "/move",
    { moves: [{ from: "rA/a-only.txt", to: "rA/denied/new/a-only.txt" }] });
  log.denied = { status: denied.status, before, after: await snap(A) };

  const tabs = [];
  confirmGate = async (m, p, b, tab) => { tabs.push(tab); return { denied: true }; };
  await call("POST", "/move", { from: "rA/a-only.txt", to: "rA/x/a-only.txt" });
  log.tabs = tabs;
  return log;
});
await ctx.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
console.log(JSON.stringify(res, null, 1));

assert.match(res.version, /^\d+\.\d+\.\d+-EXT$/, "FS_VERSION readable in the real SW");
assert.deepStrictEqual(res.find, ["rB/sub/target4.txt"], "F2: only the second root has target4");
assert.deepStrictEqual(res.roundtrip[0], ["rB/sub/target4.txt", 200, "rB/sub/target4.txt", "rB"],
  "F2: /stat resolves the qualified find path in the SAME root");
assert.deepStrictEqual(res.same.sort(), [["rA/same.txt", "in A"], ["rB/same.txt", "in B"]],
  "F2: identical names in two roots read their OWN file");
assert.strictEqual(res.cap1, true, "F5: more matches than the cap -> truncated");
assert.strictEqual(res.capFew, false, "F5: fewer than the cap -> not truncated");
assert.strictEqual(res.exactCap, false, "F5: exact cap, search finished -> not truncated");
assert.strictEqual(res.denied.status, 403, "F4: denied batch move is refused");
assert.deepStrictEqual(res.denied.after, res.denied.before, "F4: denial created no folders");
assert.deepStrictEqual(res.tabs, [5], "F3: request-local tab reaches the late gate");
console.log("\nBROWSER SMOKE PASS");
