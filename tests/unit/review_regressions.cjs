#!/usr/bin/env node
// Regression suite for the 2026-10-25 branch review findings F1–F5.
// Runs the REAL extension modules against in-memory FileSystemHandles.
//   node tests/unit/review_regressions.cjs
"use strict";
const assert = require("assert");
const { Dir, load } = require("./fs_harness.cjs");

let pass = 0, fail = 0;
const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    pass++; results.push("PASS  " + name);
  }, (e) => {
    fail++; results.push("FAIL  " + name + "\n      " + String(e && e.message || e).split("\n")[0]);
  });
}

/* ------------------------------------------------------------------ F1
 * bridge_path is Python. Covered by tests/unit/bridge_path_test.py, which
 * extracts the REAL function from all three copies (injected client +
 * both skill bootstraps) and runs the same table against each. */

/* ------------------------------------------------------------------ F2/F5 */
function multiRoot() {
  const A = new Dir("A"), B = new Dir("B");
  A.file("source.txt");
  B.file("target2.txt"); B.file("target3.txt");
  B.dir("sub").file("target4.txt");
  return {
    A, B,
    roots: [
      { id: "rA", alias: "Shared", handle: A },
      { id: "rB", alias: "Archive", handle: B },
    ],
  };
}

async function f2_suite() {
  await check("F2 /find qualifies match paths with the root id (multi-root)", async () => {
    const { B, roots } = multiRoot();
    const h = load().roots(roots);
    const r = await h.call("GET", "/find?name=target");
    const b = h.json(r);
    assert.strictEqual(r.status, 200);
    const paths = b.matches.map((m) => m.path).sort();
    assert.deepStrictEqual(paths, ["rB/sub/target4.txt", "rB/target2.txt", "rB/target3.txt"]);
    assert.ok(b.matches.every((m) => m.root_id === "rB" && m.root_name === "Archive"), "root metadata per match");
  });

  await check("F2 every /find path round-trips to the same file", async () => {
    const { A, B, roots } = multiRoot();
    A.file("target2.txt");          // same relative name in BOTH roots
    A.dir("sub").file("target4.txt");
    const h = load().roots(roots);
    const b = h.json(await h.call("GET", "/find?name=target"));
    assert.ok(b.matches.length >= 3);
    const seen = new Set();
    for (const m of b.matches) {
      const st = h.json(await h.call("GET", "/stat?path=" + encodeURIComponent(m.path)));
      assert.strictEqual(st.path, m.path, "stat echoes the same path: " + m.path);
      assert.strictEqual(st.root_id, m.root_id, "resolved to the match's root: " + m.path);
      seen.add(m.root_id + "|" + m.rel);
    }
    assert.strictEqual(seen.size, b.matches.length, "no two matches collapse onto one file");
  });

  await check("F2 a match ONLY in the second root resolves there", async () => {
    const { A, B, roots } = multiRoot();
    const h = load().roots(roots);
    const b = h.json(await h.call("GET", "/find?name=target2"));
    assert.strictEqual(b.matches.length, 1);
    const rd = await h.call("GET", "/read?path=" + encodeURIComponent(b.matches[0].path) + "&raw=1");
    assert.strictEqual(rd.status, 200);
  });

  await check("F2 scoped /find (path=) also qualifies and round-trips", async () => {
    const { B, roots } = multiRoot();
    const h = load().roots(roots);
    const b = h.json(await h.call("GET", "/find?name=target4&path=" + encodeURIComponent("rB/sub")));
    assert.deepStrictEqual(b.matches.map((m) => m.path), ["rB/sub/target4.txt"]);
    assert.strictEqual(b.roots_searched[0], "rB");
  });

  await check("F2 single root keeps bare relative paths (no churn)", async () => {
    const A = new Dir("A");
    A.file("only.txt");
    const h = load().roots([{ id: "main", alias: "Shared", handle: A }]);
    const b = h.json(await h.call("GET", "/find?name=only"));
    assert.deepStrictEqual(b.matches.map((m) => m.path), ["only.txt"]);
    assert.strictEqual(b.matches[0].root_id, "main");
  });

  await check("F5 more matches than the cap -> truncated:true + narrowing hint", async () => {
    const { roots } = multiRoot();
    const h = load().roots(roots);
    const b = h.json(await h.call("GET", "/find?name=target&max=1"));
    assert.strictEqual(b.matches.length, 1);
    assert.strictEqual(b.truncated, true);
    assert.match(b.hint, /cap/);
  });

  await check("F5 FEWER matches than the cap -> truncated:false", async () => {
    const { roots } = multiRoot();
    const h = load().roots(roots);
    const b = h.json(await h.call("GET", "/find?name=target&max=50"));
    assert.strictEqual(b.matches.length, 3);
    assert.strictEqual(b.truncated, false);
  });

  await check("F5 EXACTLY the cap, search complete -> truncated:false + complete-list hint", async () => {
    const A = new Dir("A");
    A.file("t1.txt"); A.file("t2.txt"); A.file("zebra.log");
    const h = load().roots([{ id: "main", alias: "Shared", handle: A }]);
    const b = h.json(await h.call("GET", "/find?name=t&max=2"));
    assert.strictEqual(b.matches.length, 2);
    assert.strictEqual(b.truncated, false, "an exact-cap search that finished is not truncated");
    assert.match(b.hint || "", /complete list/);
  });

  await check("F5 exactly the cap but MORE matches exist -> truncated:true", async () => {
    const A = new Dir("A");
    A.file("t1.txt"); A.file("t2.txt"); A.file("t3.txt");
    const h = load().roots([{ id: "main", alias: "Shared", handle: A }]);
    const b = h.json(await h.call("GET", "/find?name=t&max=2"));
    assert.strictEqual(b.matches.length, 2);
    assert.strictEqual(b.truncated, true);
  });

  await check("F5 cap probe is bounded on a huge tree (no full extra walk)", async () => {
    const A = new Dir("A");
    for (let i = 0; i < 60; i++) A.file("match" + String(i).padStart(3, "0") + ".txt");
    const big = A.dir("big");
    for (let d = 0; d < 40; d++) {          // 40 dirs x 200 files, NONE matching
      const sub = big.dir("d" + d);
      for (let i = 0; i < 200; i++) sub.file("filler-" + d + "-" + i + ".dat");
    }
    const h = load().roots([{ id: "main", alias: "Shared", handle: A }]);
    const t0 = Date.now();
    const b = h.json(await h.call("GET", "/find?name=match&max=60"));
    const ms = Date.now() - t0;
    assert.strictEqual(b.matches.length, 60);
    assert.strictEqual(b.truncated, true, "a cap it cannot prove complete must say truncated");
    assert.match(b.hint, /PARTIAL/, "unproven completeness is described, not guessed");
    assert.ok(!/more matches exist/.test(b.hint), "must not claim matches it did not find");
    assert.ok(ms < 20000, "bounded probe, took " + ms + "ms");
  });

  await check("F2 /list entries round-trip too (same defect class)", async () => {
    const A = new Dir("A"), B = new Dir("B");
    A.file("same.txt"); B.file("same.txt"); B.file("only.txt");
    const h = load().roots([{ id: "rA", alias: "Shared", handle: A },
      { id: "rB", alias: "Archive", handle: B }]);
    const b = h.json(await h.call("GET", "/list?path=" + encodeURIComponent("rB") + "&depth=1"));
    assert.deepStrictEqual(b.entries.map((e) => e.path).sort(), ["rB/only.txt", "rB/same.txt"]);
    for (const e of b.entries) {
      const st = h.json(await h.call("GET", "/stat?path=" + encodeURIComponent(e.path)));
      assert.strictEqual(st.path, e.path);
      assert.strictEqual(st.root_id, "rB");
    }
    // single root keeps the historical bare shape, keys included
    // (Stage-3 p8 pins set(keys) == {path,type} under fields=path,type)
    const h1 = load().roots([{ id: "main", alias: "Shared", handle: A }]);
    const b1 = h1.json(await h1.call("GET", "/list?depth=1"));
    assert.deepStrictEqual(b1.entries.map((e) => e.path).sort(), ["same.txt"]);
    const b1f = h1.json(await h1.call("GET", "/list?depth=1&fields=path,type"));
    assert.deepStrictEqual(b1f.entries.map((e) => Object.keys(e).sort()),
      [["path", "type"]], "single-root entry keys unchanged by the F2 fix");
    const b1d = h1.json(await h1.call("GET", "/list?depth=1"));
    assert.deepStrictEqual(b1d.entries.map((e) => Object.keys(e).sort()),
      [["mtime", "path", "size", "type"]], "single-root default entry keys unchanged");
  });

  await check("F5 results spread across roots are all reported", async () => {
    const A = new Dir("A"), B = new Dir("B");
    A.file("targetA.txt"); B.file("targetB.txt");
    const h = load().roots([{ id: "rA", alias: "S", handle: A }, { id: "rB", alias: "T", handle: B }]);
    const b = h.json(await h.call("GET", "/find?name=target"));
    assert.deepStrictEqual(b.matches.map((m) => m.path).sort(), ["rA/targetA.txt", "rB/targetB.txt"]);
    assert.deepStrictEqual(b.roots_searched.sort(), ["rA", "rB"]);
  });
}

/* ------------------------------------------------------------------ F3 */
async function f3_suite() {
  const swSrc = require("fs").readFileSync(require("path").resolve(__dirname, "..", "..", "extension", "sw.js"), "utf8");

  await check("F3 interleaved moves each keep their OWN tab in the late gate", async () => {
    const h = load({
      setup: `
        var _gateCalls = [];
        var _releaseA;
        confirmGate = async function (m, p, b, tab) {
          var o = typeof b === "string" ? JSON.parse(b) : b;
          _gateCalls.push({ from: o && (o.from || "batch"), tab: tab });
          return { denied: true };
        };
        // emulate epMove's async pre-checks: A pauses AFTER the router
        // handed the tab down, B runs to the gate meanwhile
        epMove = async function (body, opts) {
          var ctx = (opts && opts.ctx) || {};
          if (body.from === "A") await new Promise(function (r) { _releaseA = r; });
          return { status: 403, body: JSON.stringify(await confirmGateLate("POST", "/move", body, ctx)) };
        };
        __result = {};
        _handle = function (id, body, tabId) {
          return handleOfbRequest({ id: id, method: "POST", path: "/move",
            body: JSON.stringify(body) }, { tab: { id: tabId } });
        };
      `,
    });
    // sw.js is not part of the default load; pull in just its handler
    require("vm").runInContext(swSrc.replace(/^importScripts\([^)]*\);$/m, ""), h.ctx, { filename: "sw.js" });
    h.run(`
      _startA = function () { return handleOfbRequest({ id: "A", method: "POST", path: "/move",
        body: JSON.stringify({ from: "A", to: "C" }) }, { tab: { id: 11 } }); };
      _startB = function () { return handleOfbRequest({ id: "B", method: "POST", path: "/move",
        body: JSON.stringify({ from: "B", to: "D" }) }, { tab: { id: 22 } }); };
    `);
    const a = h.run("_startA()");
    await new Promise((r) => setImmediate(r));
    await h.run("_startB()");
    h.run("_releaseA()");
    await a;
    const calls = h.plain(h.run("_gateCalls"));
    // A's card is raised after B's (A was paused), but each card must
    // carry ITS OWN originating tab — under the old global both said 22.
    const tabOf = {};
    for (const c of calls) tabOf[c.from] = c.tab;
    assert.deepStrictEqual(tabOf, { A: 11, B: 22 },
      "each move's card keeps its originating tab: " + JSON.stringify(calls));
  });

  await check("F3 batch interleaved with a single move keeps tabs straight", async () => {
    const h = load({
      setup: `
        var _gateCalls = [];
        confirmGate = async function (m, p, b, tab) {
          var o = typeof b === "string" ? JSON.parse(b) : b;
          _gateCalls.push({ kind: o.moves ? "batch" : "single", tab: tab });
          return { denied: true };
        };
      `,
    });
    const A = new Dir("A"), B = new Dir("B");
    A.file("s1.txt"); A.file("s2.txt"); B.file("b1.txt");
    const roots = [{ id: "rA", alias: "A", handle: A }, { id: "rB", alias: "B", handle: B }];
    h.roots(roots);
    const r1 = await h.call("POST", "/move", { moves: [{ from: "rA/s1.txt", to: "rA/d1/s1.txt" },
      { from: "rA/s2.txt", to: "rA/d2/s2.txt" }] }, 31);
    const r2 = await h.call("POST", "/move", { from: "rB/b1.txt", to: "rB/b2.txt" }, 42);
    assert.strictEqual(r1.status, 403);
    assert.strictEqual(r2.status, 403);
    assert.deepStrictEqual(h.plain(h.run("_gateCalls")), [{ kind: "batch", tab: 31 }, { kind: "single", tab: 42 }]);
  });

  await check("F3 write_b64_chunk finalize also uses the request tab", async () => {
    const h = load({
      setup: `
        var _seen = null;
        confirmGate = async function (m, p, b, tab) { _seen = tab; return { denied: true }; };
      `,
    });
    const A = new Dir("A");
    A.file("big.bin", "x".repeat(10));
    h.roots([{ id: "main", alias: "Shared", handle: A }]);
    const r = await h.call("POST", "/write_b64_chunk", { path: "big.bin", seq: 0, total: 1,
      b64: Buffer.from("hello").toString("base64"), last: true }, 77);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(h.run("_seen"), 77, "chunk finalize gate got the request's tab");
  });

  await check("F3 no module-level last-tab global in sw.js/fs-confirm.js", async () => {
    const c = require("fs").readFileSync(require("path").resolve(__dirname, "..", "..", "extension", "fs-confirm.js"), "utf8");
    assert.ok(!/^\s*let\s+LAST_MOVE_SENDER_TAB/m.test(c), "fs-confirm.js must not declare the shared tab global");
    assert.ok(!/LAST_MOVE_SENDER_TAB\s*=/.test(swSrc), "sw.js must not ASSIGN the shared tab global");
    assert.ok(!/fsRoute\(\s*method,\s*path,\s*bodyText\s*\)/.test(swSrc), "sw.js must pass the request context to fsRoute");
  });
}

/* ------------------------------------------------------------------ F4 */
async function f4_suite() {
  function mk() {
    const A = new Dir("A");
    A.file("source.txt");
    return { A, roots: [{ id: "rA", alias: "A", handle: A }] };
  }

  await check("F4 DENIED batch move creates no destination folders", async () => {
    const { A, roots } = mk();
    const h = load({ setup: `confirmGate = async () => ({ denied: true });` }).roots(roots);
    const r = await h.call("POST", "/move",
      { moves: [{ from: "rA/source.txt", to: "rA/unapproved/new/source.txt" }] });
    const b = h.json(r);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(b.denied, true);
    assert.ok(!A.has("unapproved"), "no destination folders after a denial; got " + A.names());
    assert.ok(A.has("source.txt"), "source untouched");
  });

  await check("F4 TIMED-OUT batch move creates no destination folders", async () => {
    const { A, roots } = mk();
    const h = load({ setup: `confirmGate = async () => ({ confirmation_required: true, timed_out: true });` }).roots(roots);
    const r = await h.call("POST", "/move",
      { moves: [{ from: "rA/source.txt", to: "rA/unapproved/new/source.txt" }] });
    assert.strictEqual(r.status, 403);
    assert.ok(!A.has("unapproved"));
  });

  await check("F4 invalid LATER batch item creates no folders from the valid first item", async () => {
    const { A, roots } = mk();
    const h = load({ setup: `confirmGate = async () => null;` }).roots(roots);
    const r = await h.call("POST", "/move", { moves: [
      { from: "rA/source.txt", to: "rA/approved/new/source.txt" },
      { from: "rA/missing.txt", to: "rA/other/new/missing.txt" },
    ] });
    assert.strictEqual(r.status, 404, "pre-validation refuses before any mutation");
    assert.ok(!A.has("approved"), "no folders for the valid item either");
    assert.ok(!A.has("other"));
    assert.ok(A.has("source.txt"));
  });

  await check("F4 APPROVED batch does create the missing parents and move", async () => {
    const { A, roots } = mk();
    const h = load({ setup: `confirmGate = async () => null;` }).roots(roots);
    const r = await h.call("POST", "/move",
      { moves: [{ from: "rA/source.txt", to: "rA/approved/new/source.txt" }] });
    const b = h.json(r);
    assert.strictEqual(r.status, 200, JSON.stringify(b));
    assert.ok(A.dir("approved").has("new"), "parents created after approval");
    assert.strictEqual(A.dir("approved").dir("new").children.get("source.txt")._bytes.toString(), "x");
    assert.ok(!A.has("source.txt"), "source moved");
  });

  await check("F4 approved single move still creates parents; denied one does not", async () => {
    const ok = mk();
    const h1 = load({ setup: `confirmGate = async () => null;` }).roots(ok.roots);
    assert.strictEqual((await h1.call("POST", "/move", { from: "rA/source.txt", to: "rA/x/y/source.txt" })).status, 200);
    assert.ok(ok.A.dir("x").has("y"));

    const denied = mk();
    const h2 = load({ setup: `confirmGate = async () => ({ denied: true });` }).roots(denied.roots);
    assert.strictEqual((await h2.call("POST", "/move", { from: "rA/source.txt", to: "rA/x/y/source.txt" })).status, 403);
    assert.ok(!denied.A.has("x"), "denied single move left no folders");
  });

  await check("F4 cross-root batch is refused before any mutation", async () => {
    const A = new Dir("A"), B = new Dir("B");
    A.file("s.txt");
    const h = load({ setup: `confirmGate = async () => null;` })
      .roots([{ id: "rA", alias: "A", handle: A }, { id: "rB", alias: "B", handle: B }]);
    const r = await h.call("POST", "/move", { moves: [{ from: "rA/s.txt", to: "rB/t/s.txt" }] });
    assert.strictEqual(r.status, 400);
    assert.ok(!B.has("t"));
    assert.ok(A.has("s.txt"));
  });

  await check("F4 batch destination occupied -> 409, nothing created", async () => {
    const { A, roots } = mk();
    A.dir("d").file("source.txt");
    const h = load({ setup: `confirmGate = async () => null;` }).roots(roots);
    const r = await h.call("POST", "/move", { moves: [{ from: "rA/source.txt", to: "rA/d/source.txt" }] });
    assert.strictEqual(r.status, 409);
    assert.ok(A.has("source.txt"));
  });
}

async function mkdir_merge_suite() {
  await check("merge /mkdir preserves nested creation and canonical response fields", async () => {
    const A = new Dir("A");
    const h = load().roots([{ id: "rA", alias: "Shared", handle: A }]);
    const first = await h.call("POST", "/mkdir", { path: "out/deep" });
    const created = h.json(first);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(created.created, "out/deep");
    assert.strictEqual(created.written, "out/deep");
    assert.strictEqual(created.existed, false);
    const again = await h.call("POST", "/mkdir", { path: "out/deep" });
    assert.strictEqual(h.json(again).existed, true);
    assert.strictEqual((await h.call("GET", "/mkdir")).status, 405);
  });
  await check("merge /mkdir refuses leaf and intermediate file collisions without changing files", async () => {
    const A = new Dir("A");
    A.file("file.txt", "keep me");
    const h = load().roots([{ id: "rA", alias: "Shared", handle: A }]);
    for (const path of ["file.txt", "file.txt/child"]) {
      assert.strictEqual((await h.call("POST", "/mkdir", { path })).status, 409, path);
      assert.strictEqual(A.children.get("file.txt").kind, "file");
      assert.strictEqual(await (await A.getFileHandle("file.txt")).getFile().then(f => f.text()), "keep me");
    }
  });
  await check("merge /mkdir keeps traversal and read-only guards", async () => {
    const A = new Dir("A");
    const root = { id: "rA", alias: "Shared", handle: A };
    const h = load().roots([root]);
    assert.strictEqual((await h.call("POST", "/mkdir", { path: "../escape" })).status, 400);
    root.readonly = true;
    assert.strictEqual((await h.call("POST", "/mkdir", { path: "blocked" })).status, 403);
    assert.deepStrictEqual(A.names(), []);
  });
}

(async () => {
  await f2_suite();
  await f3_suite();
  await f4_suite();
  await mkdir_merge_suite();
  console.log(results.join("\n"));
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
