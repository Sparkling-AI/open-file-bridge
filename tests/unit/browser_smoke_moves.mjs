#!/usr/bin/env node
// REAL-browser check for F4's "approved" half plus echo-path round-trips.
//
//   node tests/unit/browser_smoke_moves.mjs <path-to-extension-dir>
//
// Complements browser_smoke.mjs (which covers denial). Real Chromium,
// real service worker, real FileSystemDirectoryHandles via OPFS.
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert";

const EXT = process.argv[2];
if (!EXT) { console.error("usage: node browser_smoke_moves.mjs <extension-dir>"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-moves-"));
const ctx = await chromium.launchPersistentContext(dir, {
  headless: true,
  channel: process.env.OFB_BROWSER_CHANNEL || "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
const extId = sw.url().split("/")[2];

const res = await sw.evaluate(async () => {
  const opfs = await navigator.storage.getDirectory();
  try { for (const [n] of await opfs.entries()) await opfs.removeEntry(n, { recursive: true }); } catch (e) {}
  const base = await opfs.getDirectoryHandle("rootA", { create: true });
  const put = async (p, t) => {
    const parts = p.split("/"); let d = base;
    for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable(); await w.write(t); await w.close();
  };
  await put("a.txt", "A"); await put("b.txt", "B");
  enabledRoots = async () => [{ id: "rA", alias: "Shared", enabled: true, handle: base }];
  const call = async (m, p, body) => {
    const r = await fsRoute(m, p, body === undefined ? null : JSON.stringify(body), false, { tabId: 9 });
    return { status: r.status, body: JSON.parse(r.body || "{}") };
  };
  const snap = async (d) => { const o = []; for await (const [n] of d.entries()) o.push(n); return o.sort(); };
  const log = {};

  // F4 approved half: ONE card, then both parents appear and both move
  confirmGate = async () => null;
  log.batch = (await call("POST", "/move", { moves: [
    { from: "rA/a.txt", to: "rA/out/deep/a.txt" },
    { from: "rA/b.txt", to: "rA/out/deep/b.txt" }] })).status;
  log.moved = await snap(await (await base.getDirectoryHandle("out")).getDirectoryHandle("deep"));

  log.single = (await call("POST", "/move", { from: "rA/out/deep/a.txt", to: "rA/solo/x/a.txt" })).status;
  log.solo = await snap(await base.getDirectoryHandle("solo"));

  // F2 echoes: /edit answers a path that /stat resolves to the SAME root
  enabledRoots = async () => [
    { id: "rA", alias: "Shared", enabled: true, handle: base },
    { id: "rB", alias: "Other", enabled: true, handle: base },
  ];
  const ed = await call("POST", "/edit", { path: "rA/out/deep/b.txt", edits: [{ from: "B", to: "B2" }] });
  const st = await call("GET", "/stat?path=" + encodeURIComponent(ed.body.path));
  log.edit = [ed.status, ed.body.path, st.status, st.body.path, st.body.root_id];
  const lst = await call("GET", "/list?path=" + encodeURIComponent("rA/out") + "&depth=1");
  log.list = lst.body.entries.map((e) => e.path).sort();
  return log;
});

const pg = await ctx.newPage();
const errs = [];
pg.on("pageerror", (e) => errs.push(String(e)));
await pg.goto(`chrome-extension://${extId}/options.html`);
await pg.waitForTimeout(1500);
const opts = { title: await pg.title(), cards: await pg.locator("details").count() };
await ctx.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ ...res, options: opts, page_errors: errs }, null, 1));

assert.strictEqual(res.batch, 200, "approved batch move succeeds");
assert.deepStrictEqual(res.moved, ["a.txt", "b.txt"], "approved batch created parents and moved both");
assert.strictEqual(res.single, 200, "approved single move succeeds");
assert.deepStrictEqual(res.solo, ["x"], "single move created the missing parent");
assert.deepStrictEqual(res.edit, [200, "rA/out/deep/b.txt", 200, "rA/out/deep/b.txt", "rA"],
  "F2: /edit path round-trips through /stat in the same root");
assert.deepStrictEqual(res.list, ["rA/out/deep"], "F2: /list entries are root-qualified too");
assert.deepStrictEqual(errs, [], "options page renders with no page errors");
assert.match(opts.title, /Open File Bridge/, "options page title");
console.log("\nBROWSER MOVES SMOKE PASS");
