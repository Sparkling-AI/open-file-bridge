#!/usr/bin/env node
// Remote-hosted-code policy check for the Open File Bridge extension.
// Added for the Chrome Web Store "Blue Argon" remediation (3.7.5, 2026-10-28):
// the store requires UNUSED remote executable-loading paths to be removed as
// well, so this check inspects vendored code and the packaged ZIP, not just
// first-party sources.
//
// What it enforces (run against a directory --dir extension/ and/or a
// packaged --zip artifact):
//
//  1. No external HTTP(S) URL literal in any packaged text file that is not
//     explicitly allowlisted below with a classification. This catches CDN
//     loader defaults even when the final URL is assembled at runtime
//     (string-concat prefixes end at the quote and still match), e.g. the
//     3.7.4 "https://cdn.jsdelivr.net/npm/tesseract.js@v".concat(...) worker
//     default. Executable-loader URLs have no legitimate allowlist entries:
//     everything allowlisted is a document link, license, XML namespace,
//     manifest host-permission pattern, or example-placeholder string.
//  2. Known CDN hosts are banned outright, allowlist notwithstanding.
//  3. The vendored tesseract bundles carry the packaged-only guards
//     (worker / core / language-data) and no eval-based fallbacks, and match
//     their recorded patch hashes (scripts/vendor-patch-tesseract.mjs).
//  4. WASM binaries contain no unexpected embedded URL strings.
//  5. Required packaged engine assets exist (workers, both SIMD cores,
//     language models, client, wheels) — a missing local asset is what would
//     otherwise tempt a remote fallback back in.
//  6. No backup/temp/VCS droppings anywhere in the package.
//  7. Version consistency (manifest <-> fs-core FS_VERSION, optional
//     --expect-version) and ZIP rooting (manifest.json at root, no
//     extension/ prefix, no duplicate entries).
//
// Binary container formats (wheels, .traineddata, PNG icons) are not
// text-scanned here; they were inspected in the 2026-10-28 package audit
// (.private/notes/remote-code-audit-3.7.4-2026-10-28.md) and hold data, not
// JavaScript loader code.
//
// Exit code 0 = clean; 1 = violations found (printed); 2 = usage/IO error.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------- helpers

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push({ abs: p, rel: relPath(p, base) });
  }
  return out;
}

function relPath(p, base) {
  const b = base.endsWith("/") ? base : base + "/";
  return p.startsWith(b) ? p.slice(b.length) : p;
}

function fail(msgs) {
  console.error("check-remote-code: FAIL");
  for (const m of msgs) console.error("  - " + m);
  process.exit(1);
}

// ---------------------------------------------------------------- policy

// Every external URL literal that legitimately ships in the package.
// `why` classifies it as non-executable: doc-link, license, xml-namespace,
// manifest match-pattern (host PERMISSION, not a fetched resource), or an
// example placeholder shown in the options UI. Anything else fails.
// Paths are package-root-relative (manifest.json is at the root).
const URL_ALLOWLIST = [
  { path: "confirm.js", url: "https://www.w3.org/1999/xhtml", why: "xml-namespace (xhtml ns id, not fetched)" },
  { path: "guide.html", url: "https://github.com/Sparkling-AI/open-file-bridge/blob/master/docs/recovery-guide.html", why: "doc-link" },
  { path: "inject-main.js", url: "https://…/OFB_CLIENT_INJECTION_FINDINGS.md", why: "doc-link (redacted internal pointer, not fetched)" },
  { path: "inject-main.template.js", url: "https://…/OFB_CLIENT_INJECTION_FINDINGS.md", why: "doc-link (redacted internal pointer, not fetched)" },
  { path: "manifest.json", url: "https://*/*", why: "manifest match-pattern (optional host permission, not a fetched resource)" },
  { path: "manifest.json", url: "http://127.0.0.1/*", why: "manifest match-pattern (optional host permission, not a fetched resource)" },
  { path: "manifest.json", url: "http://localhost/*", why: "manifest match-pattern (optional host permission, not a fetched resource)" },
  { path: "options.html", url: "https://github.com/Sparkling-AI/open-file-bridge/blob/master/skill/open-file-bridge/SKILL-EXT.md", why: "doc-link" },
  { path: "options.html", url: "https://github.com/Sparkling-AI/open-file-bridge", why: "doc-link" },
  { path: "options.html", url: "https://chat.example.com", why: "example placeholder shown in the options UI" },
  { path: "options.html", url: "http://127.0.0.1:8080", why: "example placeholder shown in the options UI" },
  { path: "options.html", url: "https://your-open-webUI-address", why: "example placeholder shown in the options UI" },
  { path: "options.js", url: "https://github.com/Sparkling-AI/open-file-bridge/blob/master/skill/open-file-bridge/", why: "doc-link" },
  { path: "vendor/pdfium/index.esm.js", url: "http://unicode.org/faq/utf_bom.html#utf16-3", why: "doc-link (upstream UTF-16 comment, appears twice)" },
  { path: "vendor/pdfium/index.esm.js", url: "http://en.wikipedia.org/wiki/UTF-8#Description", why: "doc-link (upstream comment)" },
  { path: "vendor/pdfium/index.esm.js", url: "https://www.ietf.org/rfc/rfc2279.txt", why: "doc-link (upstream comment)" },
  { path: "vendor/pdfium/index.esm.js", url: "https://tools.ietf.org/html/rfc3629", why: "doc-link (upstream comment)" },
  { path: "vendor/pdfium/index.esm.js", url: "https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing", why: "doc-link (upstream comment)" },
  { path: "vendor/pdflib/pdf-lib.min.js", url: "http://www.apache.org/licenses/LICENSE-2.0", why: "license" },
  { path: "vendor/pdflib/pdf-lib.min.js", url: "https://github.com/Hopding/pdf-lib", why: "doc-link (project banner)" },
  { path: "vendor/NOTICE.md", url: "https://github.com/naptha/tesseract.js/blob/main/LICENSE", why: "license (tesseract.js, referenced from the vendor notice)" },
];

// URL strings embedded in shipped WASM binaries (data, not code loaders).
const WASM_URL_ALLOWLIST = {
  "vendor/pdfium/pdfium.wasm": [
    { url: "http://ns.adobe.com/AcrobatAdhocWorkflow/1.0/", why: "xml-namespace (Adobe PDF metadata schema)" },
  ],
};

// CDN hosts that may never appear in the package, allowlist or not.
const BANNED_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "rawgit.com", "esm.sh"];

const TEXT_EXT = /\.(js|mjs|cjs|html|json|py|txt|md|css)$/;
const URL_RE = /(https?:\/\/[^\s"'`<>()\[\]{}\\]+|\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}[^\s"'`<>()\[\]{}\\]*)/gi;

const REQUIRED_FILES = [
  "manifest.json",
  "sw.js",
  "engine-impl.js",
  "engine-host.html",
  "engine-offscreen.html",
  "ofb-client.py",
  "vendor/tesseractjs/tesseract.min.js",
  "vendor/tesseractjs/worker.min.js",
  "vendor/tesseractjs/tesseract-core-simd-lstm.wasm.js",
  "vendor/tesseractjs/tesseract-core-simd-lstm.wasm",
  "vendor/tesseractjs/tesseract-core-relaxedsimd-lstm.wasm.js",
  "vendor/tesseractjs/tesseract-core-relaxedsimd-lstm.wasm",
  "vendor/tessdata-fast/eng.traineddata",
  "vendor/tessdata-fast/swe.traineddata",
  "vendor/tessdata-fast/osd.traineddata",
  "vendor/pdfium/index.esm.js",
  "vendor/pdfium/pdfium.wasm",
  "vendor/pdflib/pdf-lib.min.js",
];

const EXPECTED_TRAINEDDATA_COUNT = 22;
const EXPECTED_WHEEL_COUNT = 9;

const JUNK_RE = /(^|\/)(\.DS_Store|__MACOSX|[^/]*\.(bak|orig|rej|tmp|swp)|~[^/]*|[^/]*~)$/;

// Vendored tesseract guard tripwires: text that must / must not be present.
const TESSERACT_RULES = [
  {
    file: "vendor/tesseractjs/tesseract.min.js",
    mustInclude: ["[ofb] tesseract.js workerPath must be a packaged URL within this extension"],
    mustExclude: ["cdn.jsdelivr.net", "new Blob(['importScripts(\"", "URL.createObjectURL"],
  },
  {
    file: "vendor/tesseractjs/worker.min.js",
    mustInclude: [
      "[ofb] tesseract.js corePath is required",
      "refusing importScripts of non-packaged tesseract core URL",
      "[ofb] tesseract.js langPath is required",
      "[ofb] language data fetch failed",
    ],
    mustExclude: ["cdn.jsdelivr.net", "new Function(", 'Function("r",'],
  },
];

// ---------------------------------------------------------------- checks

function checkPackage(root, label, findings) {
  root = resolve(root); // normalize (e.g. macOS TMPDIR's trailing slash
  // produces a // in staged paths, which would break root-relative names)
  const files = walk(root);

  // -- 6. junk / backups / VCS droppings
  for (const f of files) {
    if (JUNK_RE.test(f.rel) || f.rel.startsWith(".git")) {
      findings.push(`${label}: backup/temp file in package: ${f.rel}`);
    }
  }

  // -- 5. required assets
  const rels = new Set(files.map((f) => f.rel));
  for (const req of REQUIRED_FILES) {
    if (!rels.has(req)) findings.push(`${label}: required packaged asset missing: ${req}`);
  }
  const trained = files.filter((f) => f.rel.startsWith("vendor/tessdata-fast/") && f.rel.endsWith(".traineddata"));
  if (trained.length !== EXPECTED_TRAINEDDATA_COUNT) {
    findings.push(`${label}: expected ${EXPECTED_TRAINEDDATA_COUNT} packaged language models, found ${trained.length}`);
  }
  const wheels = files.filter((f) => f.rel.startsWith("vendor/wheels/") && f.rel.endsWith(".whl"));
  if (wheels.length !== EXPECTED_WHEEL_COUNT) {
    findings.push(`${label}: expected ${EXPECTED_WHEEL_COUNT} packaged wheels, found ${wheels.length}`);
  }

  // -- 7. version consistency (manifest <-> fs-core)
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version;
  } catch {
    findings.push(`${label}: manifest.json missing or unparsable at package root`);
  }
  if (version) {
    const core = readFileSync(join(root, "fs-core.js"), "utf8");
    const m = core.match(/^const FS_VERSION = "([^"]+)";/m);
    if (!m || m[1] !== version + "-EXT") {
      findings.push(`${label}: FS_VERSION ${m ? m[1] : "(none)"} does not match manifest ${version} (expected ${version}-EXT)`);
    }
    if (expectVersion && version !== expectVersion) {
      findings.push(`${label}: manifest version ${version} != expected ${expectVersion}`);
    }
  }

  // -- 1./2. external URL literals in text files
  const allow = new Map();
  for (const a of URL_ALLOWLIST) {
    if (!allow.has(a.path)) allow.set(a.path, []);
    allow.get(a.path).push(a);
  }
  for (const f of files) {
    if (!TEXT_EXT.test(f.rel)) continue;
    const src = readFileSync(f.abs, "utf8");
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(src))) {
      const url = m[1];
      const host = (url.match(/^[a-z]+:\/\/([^/:]+)/) || [])[1] || "";
      if (BANNED_HOSTS.includes(host)) {
        findings.push(`${label}: BANNED CDN host in ${f.rel}: ${url}`);
        continue;
      }
      const entries = allow.get(f.rel) || [];
      const hit = entries.find((a) => a.url === url);
      if (hit) continue; // entries are reusable: the same doc link or match
      // pattern legitimately appears in several manifest keys / comments
      findings.push(
        `${label}: unallowlisted external URL in ${f.rel}: ${url}` +
          ` (only doc/license/namespace/match-pattern URLs may ship; loader URLs never)`,
      );
    }
  }

  // -- 4. wasm embedded URL strings
  for (const f of files.filter((x) => x.rel.endsWith(".wasm"))) {
    const seen = new Set();
    const s = readFileSync(f.abs).toString("latin1");
    const re = /https?:\/\/[!-~]{3,}/g;
    let m;
    while ((m = re.exec(s))) seen.add(m[0]);
    const ok = new Set((WASM_URL_ALLOWLIST[f.rel] || []).map((a) => a.url));
    for (const u of seen) {
      if (!ok.has(u)) findings.push(`${label}: unexpected URL string in ${f.rel}: ${u}`);
    }
  }

  // -- 3. tesseract guards + patch hashes
  for (const rule of TESSERACT_RULES) {
    const p = join(root, rule.file);
    if (!existsSync(p)) continue; // missing-file already reported above
    const src = readFileSync(p, "utf8");
    for (const needle of rule.mustInclude) {
      const n = src.split(needle).length - 1;
      if (n !== 1) findings.push(`${label}: guard tripwire ${JSON.stringify(needle)} in ${rule.file}: expected exactly 1, found ${n}`);
    }
    for (const bad of rule.mustExclude) {
      if (src.includes(bad)) findings.push(`${label}: forbidden pattern ${JSON.stringify(bad)} present in ${rule.file}`);
    }
  }
  const patchesJson = join(root, "vendor/tesseractjs/PATCHES.json");
  if (existsSync(patchesJson)) {
    try {
      const meta = JSON.parse(readFileSync(patchesJson, "utf8"));
      for (const [name, hash] of Object.entries(meta.patched_sha256 || {})) {
        const actual = createHash("sha256")
          .update(readFileSync(join(root, "vendor/tesseractjs", name)))
          .digest("hex");
        if (actual !== hash) {
          findings.push(`${label}: ${name} does not match its PATCHES.json hash (file edited outside the patch script?)`);
        }
      }
    } catch (e) {
      findings.push(`${label}: PATCHES.json unparsable: ${e.message}`);
    }
  } else {
    findings.push(`${label}: vendor/tesseractjs/PATCHES.json missing (patch provenance)`);
  }

  return files;
}

function checkZip(zipPath, label, findings) {
  // integrity + entry listing via the system unzip
  let entries;
  try {
    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
    entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    findings.push(`${label}: cannot read zip (${e.message})`);
    return;
  }
  const manifestEntries = entries.filter((e) => e === "manifest.json" || e.endsWith("/manifest.json"));
  if (manifestEntries.filter((e) => e === "manifest.json").length !== 1) {
    findings.push(`${label}: zip must contain exactly one root manifest.json (found: ${manifestEntries.join(", ") || "none"})`);
  }
  const prefixed = entries.filter((e) => e.startsWith("extension/"));
  if (prefixed.length) findings.push(`${label}: zip contains ${prefixed.length} entries under extension/ (wrongly rooted)`);
  const dup = entries.filter((e, i) => entries.indexOf(e) !== i);
  if (dup.length) findings.push(`${label}: duplicate zip entries: ${[...new Set(dup)].join(", ")}`);
  for (const e of entries) {
    if (JUNK_RE.test(e)) findings.push(`${label}: backup/temp entry in zip: ${e}`);
  }

  const tmp = mkdtempSync(join(tmpdir(), "ofb-rhc-"));
  try {
    execFileSync("unzip", ["-q", zipPath, "-d", tmp]);
    checkPackage(tmp, label, findings);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
const dirs = [];
const zips = [];
let expectVersion = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") dirs.push(args[++i]);
  else if (args[i] === "--zip") zips.push(args[++i]);
  else if (args[i] === "--expect-version") expectVersion = args[++i];
  else {
    console.error(`unknown argument ${args[i]} (use --dir <path> / --zip <path> / --expect-version <v>)`);
    process.exit(2);
  }
}
if (!dirs.length && !zips.length) dirs.push("extension");

const findings = [];
let fileCount = 0;
for (const d of dirs) {
  if (!existsSync(d) || !statSync(d).isDirectory()) {
    fail([`--dir ${d}: not a directory`]);
  }
  fileCount += checkPackage(d, `dir(${d})`, findings).length;
}
for (const z of zips) {
  if (!existsSync(z)) fail([`--zip ${z}: not a file`]);
  checkZip(z, `zip(${z})`, findings);
}

if (findings.length) fail(findings);

console.log(
  `check-remote-code: PASS — ${dirs.length} dir(s), ${zips.length} zip(s), ` +
    `${fileCount} source files; no remote executable-loading paths, guards ` +
    `and packaged assets verified` +
    (expectVersion ? ` (version ${expectVersion})` : ""),
);
