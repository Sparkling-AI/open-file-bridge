#!/usr/bin/env node
// Deterministic, integrity-checked patcher for the vendored tesseract.js
// bundles — Chrome Web Store "Blue Argon" remotely-hosted-code remediation
// (extension 3.7.5, 2026-10-28).
//
// Upstream input: npm tesseract.js@7.0.0 dist files, pinned byte-for-byte in
// vendor-upstream/tesseract.js-7.0.0/. The patch series below removes the
// remotely hosted worker/core/language-data CDN defaults, deletes the blob
// worker wrapper, enforces packaged-only (same-extension-origin) code and
// language paths, and drops three dead eval-based compatibility fallbacks
// that MV3 extension CSP would forbid if they were ever reached.
//
// Usage:
//   node scripts/vendor-patch-tesseract.mjs apply    # regenerate the patched
//                                                    # files under
//                                                    # extension/vendor/tesseractjs/
//   node scripts/vendor-patch-tesseract.mjs verify   # verify the upstream
//                                                    # pins, re-derive the
//                                                    # patched files, and
//                                                    # compare them (bytes +
//                                                    # hashes) with the
//                                                    # committed result
//
// Fails (non-zero) when the upstream input changed, when a patch no longer
// matches its target exactly once, or when the committed patched files do
// not match the re-derived result. Run from the repo root.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_DIR = join(REPO, "vendor-upstream/tesseract.js-7.0.0");
const VENDOR_DIR = join(REPO, "extension/vendor/tesseractjs");
const PATCHES_JSON = join(VENDOR_DIR, "PATCHES.json");

const UPSTREAM = "tesseract.js@7.0.0 (npm dist, Apache-2.0)";

// SHA-256 of the pristine upstream inputs. The script refuses to run on any
// other bytes: bump these deliberately, together with the patch series,
// when upgrading the vendored library.
const UPSTREAM_SHA256 = {
  "tesseract.min.js":
    "000c27d9cd0def655f77b36c72a389c0ab13793aa31cb4d7aab56d09c0afbc7e",
  "worker.min.js":
    "576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d",
};

// Each patch must match its file exactly once. `why` documents the finding
// it remediates (audit .private/notes/remote-code-audit-3.7.4-2026-10-28.md).
const PATCHES = [
  {
    file: "tesseract.min.js",
    id: "T1-rhc1-worker-default",
    why: "RHC-1: remove the remote worker.min.js CDN default",
    find: 'workerPath:"https://cdn.jsdelivr.net/npm/tesseract.js@v".concat(c,"/dist/worker.min.js")',
    replace: 'workerPath:""',
  },
  {
    file: "tesseract.min.js",
    id: "T2-rhc1-spawnworker-packaged-only",
    why: "RHC-1: delete the blob-worker wrapper; only same-extension packaged worker URLs may spawn",
    find: 'function(t){var r,e=t.workerPath,n=t.workerBlobURL;if(Blob&&URL&&n){var o=new Blob([\'importScripts("\'.concat(e,\'");\')],{type:"application/javascript"});r=new Worker(URL.createObjectURL(o))}else r=new Worker(e);return r}',
    replace: 'function(t){var e=String(t.workerPath||"");if(!e||e.slice(0,1)==="/"||!/^chrome-extension:\\/\\/[^\\/]+\\//.test(e)||0!==e.indexOf(self.location.origin+"/"))throw Error("[ofb] tesseract.js workerPath must be a packaged URL within this extension ("+self.location.origin+"/vendor/tesseractjs/worker.min.js); remote and blob worker loading were removed (CWS remote-code policy); got: "+JSON.stringify(e));return new Worker(e)}',
  },
  {
    file: "tesseract.min.js",
    id: "T3-blob-option-off",
    why: "make the now-inert workerBlobURL default honest (no blob branch remains)",
    find: 't.exports={workerBlobURL:!0,logger:function(){}}',
    replace: 't.exports={workerBlobURL:!1,logger:function(){}}',
  },
  {
    file: "tesseract.min.js",
    id: "T5-page-side-path-validation",
    why: "page-side createWorker validation: reject non-packaged or missing langPath (and non-packaged corePath) immediately, before any worker spawn — worker-side language-job rejections never settle the page promise (upstream tesseract.js 7 bug), so the library-level langPath guard must fire in the page",
    find: 'l=p(u(u({},b),n)),m=l.logger,j=l.errorHandler,',
    replace: 'l=p(u(u({},b),n)),function(t){var r=String(t.langPath||""),e=String(t.corePath||""),i=self.location.origin+"/";if(!r)throw Error("[ofb] tesseract.js langPath is required: the remote language-data fallback was removed; pass this extension\'s packaged tessdata directory");if(!r.startsWith(i))throw Error("[ofb] tesseract.js langPath must be a packaged URL within this extension; got: "+r);if(e&&!e.startsWith(i))throw Error("[ofb] tesseract.js corePath must be a packaged URL within this extension ("+i+"vendor/tesseractjs/); got: "+e)}(l),m=l.logger,j=l.errorHandler,',
  },
  {
    file: "tesseract.min.js",
    id: "T6-init-chain-failures-settle-createworker",
    why: "upstream createWorker ends its load/loadLanguage/initialize chain in an EMPTY catch, so any worker-side failure (e.g. a missing packaged language model) leaves the returned promise pending forever; route the failure to the gate reject so createWorker always settles",
    find: '.then((function(){return I(X)})).catch((function(){})),t.abrupt("return",F);',
    replace: '.then((function(){return I(X)})).catch((function(t){G(t&&t.message||String(t))})),t.abrupt("return",F);',
  },
  {
    file: "tesseract.min.js",
    id: "T4-csp-regenerator-fallback",
    why: "CSP cleanup: dead eval-based regeneratorRuntime fallback (globalThis always exists in supported Chrome)",
    find: 'Function("r","regeneratorRuntime = r")(o)',
    replace: "globalThis.regeneratorRuntime=o",
  },
  {
    file: "worker.min.js",
    id: "W1-rhc2-core-default",
    why: "RHC-2: remove the remote tesseract.js-core CDN default; require an explicit packaged core path",
    find: '(c=o||"https://cdn.jsdelivr.net/npm/tesseract.js-core@v".concat(h.substring(1))).slice(-2)',
    replace: '(c=function(t){t=String(t||"");if(!t)throw Error("[ofb] tesseract.js corePath is required: loading a remote core was removed (CWS remote-code policy); pass this extension\'s packaged core directory");if(!t.startsWith(self.location.origin+"/"))throw Error("[ofb] tesseract.js corePath must be a packaged URL within this extension ("+self.location.origin+"/vendor/tesseractjs/); got: "+t);return t}(o)).slice(-2)',
  },
  {
    file: "worker.min.js",
    id: "W2-rhc2-importscripts-guard",
    why: "RHC-2: the assembled core URL must be same-extension packaged before importScripts",
    find: 'case 15:if(r.g.importScripts(l),',
    replace: 'case 15:if(!l||!String(l).startsWith(self.location.origin+"/"))throw Error("[ofb] refusing importScripts of non-packaged tesseract core URL: "+l);if(r.g.importScripts(l),',
  },
  {
    file: "worker.min.js",
    id: "W3-data1-lang-default",
    why: "DATA-1: remove the remote @tesseract.js-data CDN fallback; require the packaged tessdata directory",
    find: 'b=s||"https://cdn.jsdelivr.net/npm/@tesseract.js-data/".concat(i,m?"/4.0.0_best_int":"/4.0.0"),',
    replace: 'b=function(t){t=String(t||"");if(!t)throw Error("[ofb] tesseract.js langPath is required: the remote language-data fallback was removed; pass this extension\'s packaged tessdata directory");if(!t.startsWith(self.location.origin+"/"))throw Error("[ofb] tesseract.js langPath must be a packaged URL within this extension; got: "+t);return t}(s),',
  },
  {
    file: "worker.min.js",
    id: "W4-data1-fetch-message",
    why: "DATA-1: the missing-model failure must state the local-only policy",
    find: 'throw Error("Network error while fetching ".concat(O,". Response code: ").concat(U.status))',
    replace: 'throw Error("[ofb] language data fetch failed — packaged models only, no remote fallback: ".concat(O,". Response code: ").concat(U.status))',
  },
  {
    file: "worker.min.js",
    id: "W7-data1-fetch-rejection",
    why: "DATA-1: a missing packaged model makes fetch() REJECT (TypeError) on chrome-extension:// URLs; without this wrapper the rejection escapes the job protocol and createWorker hangs forever instead of failing",
    find: 'return O="".concat(d,"/").concat(i,".traineddata").concat(w?".gz":""),t.next=29,("webworker"===v?fetch:I.fetch)(O);',
    replace: 'return O="".concat(d,"/").concat(i,".traineddata").concat(w?".gz":""),t.next=29,("webworker"===v?fetch:I.fetch)(O).catch((function(t){throw Error("[ofb] packaged language model unavailable (no remote fallback): ".concat(O," — ").concat(t&&t.message||t))}));',
  },
  {
    file: "worker.min.js",
    id: "W5-csp-global-fallback",
    why: "CSP cleanup: dead new Function('return this') global getter (globalThis branch always wins in supported Chrome)",
    find: 'this||new Function("return this")()',
    replace: "this",
  },
  {
    file: "worker.min.js",
    id: "W6-csp-regenerator-fallback",
    why: "CSP cleanup: dead eval-based regeneratorRuntime fallback (globalThis always exists in supported Chrome)",
    find: 'Function("r","regeneratorRuntime = r")(i)',
    replace: "globalThis.regeneratorRuntime=i",
  },
];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function fail(msg) {
  console.error("vendor-patch-tesseract: FAIL — " + msg);
  process.exit(1);
}

function derive() {
  const out = {};
  for (const name of Object.keys(UPSTREAM_SHA256)) {
    let raw;
    try {
      raw = readFileSync(join(UPSTREAM_DIR, name));
    } catch {
      fail(`missing upstream input ${join(UPSTREAM_DIR, name)}`);
    }
    const actual = sha256(raw);
    if (actual !== UPSTREAM_SHA256[name]) {
      fail(
        `upstream ${name} changed (sha256 ${actual}, pinned ` +
          `${UPSTREAM_SHA256[name]}) — refusing to patch a different input; ` +
          `update the pin and the patch series together`,
      );
    }
    out[name] = raw;
  }
  for (const p of PATCHES) {
    const buf = out[p.file].toString("utf8");
    const first = buf.indexOf(p.find);
    if (first === -1) fail(`patch ${p.id}: target text not found in ${p.file}`);
    if (buf.indexOf(p.find, first + 1) !== -1) {
      fail(`patch ${p.id}: target text not unique in ${p.file}`);
    }
    out[p.file] = Buffer.from(
      buf.replace(p.find, p.replace), "utf8",
    );
  }
  return out;
}

const mode = process.argv[2] || "";

if (mode === "apply") {
  const derived = derive();
  for (const [name, buf] of Object.entries(derived)) {
    writeFileSync(join(VENDOR_DIR, name), buf);
    console.log(`patched ${name} (${buf.length} bytes, sha256 ${sha256(buf)})`);
  }
  const meta = {
    generator: "scripts/vendor-patch-tesseract.mjs",
    upstream: UPSTREAM,
    upstream_sha256: UPSTREAM_SHA256,
    patched_sha256: Object.fromEntries(
      Object.entries(derived).map(([n, b]) => [n, sha256(b)]),
    ),
    patches: PATCHES.map((p) => ({ id: p.id, file: p.file, why: p.why })),
    note: "Vendored tesseract.js bundles are PATCHED for this extension: remote worker/core/language-data CDN defaults removed; loading restricted to same-extension packaged URLs; eval-based compatibility fallbacks dropped. Regenerate with scripts/vendor-patch-tesseract.mjs.",
  };
  writeFileSync(PATCHES_JSON, JSON.stringify(meta, null, 2) + "\n");
  console.log(`wrote ${basename(PATCHES_JSON)}`);
  process.exit(0);
}

if (mode === "verify") {
  const derived = derive();
  let ok = true;
  for (const [name, buf] of Object.entries(derived)) {
    let committed;
    try {
      committed = readFileSync(join(VENDOR_DIR, name));
    } catch {
      fail(`missing committed patched file ${join(VENDOR_DIR, name)}`);
    }
    const same = committed.equals(buf);
    console.log(
      `${name}: ${same ? "MATCHES" : "DIFFERS from"} derivation ` +
        `(derived sha256 ${sha256(buf)}, committed sha256 ${sha256(committed)})`,
    );
    ok = ok && same;
  }
  let metaOk = false;
  try {
    const meta = JSON.parse(readFileSync(PATCHES_JSON, "utf8"));
    metaOk = Object.entries(meta.patched_sha256 || {}).every(
      ([n, h]) => h === sha256(derived[n]),
    );
  } catch {
    // leave metaOk false
  }
  console.log(`${basename(PATCHES_JSON)}: ${metaOk ? "consistent" : "INCONSISTENT"}`);
  if (!ok || !metaOk) {
    fail("committed patched files are not reproducible from the pinned upstream");
  }
  console.log("vendor patch verification PASSED");
  process.exit(0);
}

fail(`unknown mode ${JSON.stringify(mode)} — use "apply" or "verify"`);
