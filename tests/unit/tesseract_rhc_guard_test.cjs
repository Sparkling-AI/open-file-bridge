#!/usr/bin/env node
// Unit tests for the vendored tesseract.js packaged-only guards (CWS "Blue
// Argon" remediation, extension 3.7.5). Run from the repo root:
//
//   node tests/unit/tesseract_rhc_guard_test.cjs
//
// Layer 1 (behavioral): the patched tesseract.min.js is executed in a Node
// VM with a page-like sandbox, and worker spawning is driven through the
// REAL public API (Tesseract.createWorker). Remote, blob:, data:, and
// cross-extension worker paths must be rejected with the [ofb] error;
// a same-extension packaged path must reach `new Worker(url)`.
//
// Layer 2 (structural): the CDN defaults and eval fallbacks are gone from
// both patched bundles, and the guards are in place. (The ZIP/package-level
// enforcement lives in scripts/check-remote-code.mjs; patch provenance in
// scripts/vendor-patch-tesseract.mjs verify.)
//
// A mocked Worker satisfies the page layer only; end-to-end OCR execution
// is covered by tests/stage3/tesseract_local_test.py in a real browser.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO = path.resolve(__dirname, "..", "..");
const TESS_MIN = path.join(REPO, "extension/vendor/tesseractjs/tesseract.min.js");
const WORKER_MIN = path.join(REPO, "extension/vendor/tesseractjs/worker.min.js");

const EXT_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("ok   " + name);
  } else {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

/* ---------------- layer 1: behavioral (Node VM) ---------------- */

function loadPatchedLibrary() {
  const constructed = [];
  class FakeWorker {
    constructor(url) {
      constructed.push(String(url));
      // no postMessage handshake: createWorker will never settle, which the
      // tests below handle by not awaiting the full promise for positive cases
      this.postMessage = () => {};
      this.addEventListener = () => {};
      this.terminate = () => {};
    }
  }
  const sandbox = {
    self: { location: { origin: EXT_ORIGIN, href: EXT_ORIGIN + "/engine-host.html" } },
    location: { origin: EXT_ORIGIN, href: EXT_ORIGIN + "/engine-host.html" },
    Worker: FakeWorker,
    Blob: class { constructor(parts) { this._p = parts; } },
    URL: { createObjectURL: () => "blob:fake" },
    console,
    setTimeout,
    clearTimeout,
    Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(TESS_MIN, "utf8"), sandbox, {
    filename: "tesseract.min.js",
  });
  // the UMD wrapper is invoked with our `self` object as its subject, so the
  // library lands on sandbox.self.Tesseract
  return { Tesseract: sandbox.self.Tesseract, constructed };
}

async function expectWorkerRejection(name, Tesseract, opts, wantSub) {
  // baseline valid lang/core paths so workerPath cases exercise the
  // spawnWorker guard (the page-side T5 validation runs first otherwise)
  const base = {
    logger: () => {},
    langPath: EXT_ORIGIN + "/vendor/tessdata-fast/",
    corePath: EXT_ORIGIN + "/vendor/tesseractjs/",
  };
  try {
    await Tesseract.createWorker("eng", 1, Object.assign(base, opts));
    check(name, false, "createWorker resolved, expected rejection");
  } catch (e) {
    const msg = String((e && e.message) || e);
    check(
      name,
      msg.includes("[ofb]") && msg.includes(wantSub),
      "message was: " + msg.slice(0, 220),
    );
  }
}

async function behavioralTests() {
  const { Tesseract, constructed } = loadPatchedLibrary();
  check("library evaluates and exposes Tesseract in a page-like VM", !!Tesseract);

  const goodWorker = EXT_ORIGIN + "/vendor/tesseractjs/worker.min.js";

  // page-side T5 validation (fires in createWorker before any spawn)
  await expectWorkerRejection(
    "remote langPath rejected page-side",
    Tesseract,
    { workerPath: goodWorker, langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/" },
    "langPath must be a packaged URL",
  );
  await expectWorkerRejection(
    "missing langPath rejected page-side",
    Tesseract,
    { workerPath: goodWorker, langPath: undefined },
    "langPath is required",
  );
  await expectWorkerRejection(
    "remote corePath rejected page-side",
    Tesseract,
    { workerPath: goodWorker, corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@v7.0.0" },
    "corePath must be a packaged URL",
  );

  await expectWorkerRejection(
    "remote https workerPath rejected",
    Tesseract,
    { workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@v7.0.0/dist/worker.min.js" },
    "workerPath",
  );
  await expectWorkerRejection(
    "blob: workerPath rejected",
    Tesseract,
    { workerPath: "blob:" + EXT_ORIGIN + "/some-worker" },
    "workerPath",
  );
  await expectWorkerRejection(
    "data: workerPath rejected",
    Tesseract,
    { workerPath: "data:application/javascript,importScripts(%22https%3A%2F%2Fx%2Fw.js%22)" },
    "workerPath",
  );
  await expectWorkerRejection(
    "cross-extension workerPath rejected",
    Tesseract,
    { workerPath: "chrome-extension://" + "b".repeat(32) + "/vendor/tesseractjs/worker.min.js" },
    "workerPath",
  );
  await expectWorkerRejection(
    "missing workerPath (empty default) rejected",
    Tesseract,
    {},
    "workerPath",
  );
  await expectWorkerRejection(
    "relative workerPath rejected (must be explicit packaged URL)",
    Tesseract,
    { workerPath: "vendor/tesseractjs/worker.min.js" },
    "workerPath",
  );

  // adversarial prefixes: the guards compare protocol + extension ID as an
  // explicit string prefix (self.location.origin + "/"), never URL.origin
  // parsing — these lookalikes must all be rejected
  await expectWorkerRejection(
    "suffix-spoofed extension ID rejected (aaaa…-evil)",
    Tesseract,
    { workerPath: EXT_ORIGIN + "-evil/vendor/tesseractjs/worker.min.js" },
    "workerPath",
  );
  await expectWorkerRejection(
    "userinfo-spoofed URL rejected (evil@origin)",
    Tesseract,
    { workerPath: "chrome-extension://evil@" + EXT_ORIGIN.slice("chrome-extension://".length) + "/vendor/tesseractjs/worker.min.js" },
    "workerPath",
  );
  await expectWorkerRejection(
    "origin-suffixed userinfo trick rejected (origin@evil)",
    Tesseract,
    { workerPath: EXT_ORIGIN + "@evil.com/vendor/tesseractjs/worker.min.js" },
    "workerPath",
  );
  await expectWorkerRejection(
    "scheme-lookalike rejected (chromeextension:)",
    Tesseract,
    { workerPath: EXT_ORIGIN.replace("chrome-extension://", "chromeextension://") },
    "workerPath",
  );
  await expectWorkerRejection(
    "host-lookalike https URL rejected (chrome-extension.evil.com)",
    Tesseract,
    { workerPath: "https://chrome-extension.evil.com/vendor/tesseractjs/worker.min.js" },
    "workerPath",
  );
  await expectWorkerRejection(
    "javascript: URL rejected",
    Tesseract,
    { workerPath: "javascript:importScripts(1)" },
    "workerPath",
  );
  await expectWorkerRejection(
    "uppercase-extension-ID variant rejected",
    Tesseract,
    { workerPath: EXT_ORIGIN.toUpperCase() + "/vendor/tesseractjs/worker.min.js" },
    "workerPath",
  );

  // positive: same-extension URL passes the guard and reaches new Worker().
  // createWorker never settles (FakeWorker has no real handshake), so give
  // it a moment and assert on the constructor calls.
  const p = Tesseract.createWorker("eng", 1, {
    workerPath: goodWorker,
    langPath: EXT_ORIGIN + "/vendor/tessdata-fast/",
    corePath: EXT_ORIGIN + "/vendor/tesseractjs/",
    workerBlobURL: true, // even with the legacy option forced on: no blob path exists anymore
    logger: () => {},
  });
  await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 150))]);
  check(
    "packaged same-extension workerPath reaches new Worker(url)",
    constructed.length === 1 && constructed[0] === goodWorker,
    "constructed=" + JSON.stringify(constructed),
  );
  check(
    "no blob: worker URL was ever constructed",
    constructed.every((u) => !u.startsWith("blob:")),
    JSON.stringify(constructed),
  );
}

/* ---------------- layer 2: structural ---------------- */

function structuralTests() {
  const tess = fs.readFileSync(TESS_MIN, "utf8");
  const worker = fs.readFileSync(WORKER_MIN, "utf8");

  for (const [name, src] of [["tesseract.min.js", tess], ["worker.min.js", worker]]) {
    check(name + ": no cdn.jsdelivr.net host", !src.includes("cdn.jsdelivr.net"));
    check(name + ": no external http(s) URL literal of any kind remains", !/https?:\/\//.test(src));
  }

  check(
    "tesseract.min.js: blob importScripts wrapper removed",
    !tess.includes("new Blob(['importScripts(\""),
  );
  check(
    "tesseract.min.js: packaged-only spawnWorker guard present",
    tess.includes("[ofb] tesseract.js workerPath must be a packaged URL within this extension"),
  );
  check(
    "worker.min.js: core CDN default replaced by required-path guard",
    worker.includes("[ofb] tesseract.js corePath is required") &&
      worker.includes("[ofb] tesseract.js corePath must be a packaged URL within this extension"),
  );
  check(
    "worker.min.js: importScripts guarded by same-origin check",
    worker.includes("refusing importScripts of non-packaged tesseract core URL") &&
      worker.indexOf("refusing importScripts of non-packaged") <
        worker.indexOf("r.g.importScripts(l)"),
  );
  check(
    "worker.min.js: language-data CDN fallback replaced by required-path guard",
    worker.includes("[ofb] tesseract.js langPath is required") &&
      worker.includes("[ofb] tesseract.js langPath must be a packaged URL within this extension"),
  );
  check(
    "worker.min.js: local-only language fetch failure message",
    worker.includes("[ofb] language data fetch failed"),
  );
  check(
    "tesseract.min.js: upstream empty catch in the init chain removed (createWorker settles on failure)",
    !tess.includes(".catch((function(){}))") &&
      tess.includes(".catch((function(t){G(t&&t.message||String(t))}))"),
  );
  check(
    "eval-based compatibility fallbacks removed (new Function / Function(r))",
    !worker.includes("new Function(") &&
      !worker.includes('Function("r",') &&
      !tess.includes('Function("r",'),
  );
}

/* ---------------- run ---------------- */

(async () => {
  await behavioralTests();
  structuralTests();
  if (failures) {
    console.error(`\ntesseract_rhc_guard_test: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\ntesseract_rhc_guard_test: all checks passed");
})();
