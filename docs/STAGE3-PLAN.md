# Open File Bridge — Stage 3 Plan (extension-ONLY product)

Status: **APPROVED — Dandan, 2026-09-06. Decisions locked; build may
start.** Branch `feat/stage3-extension` off `origin/master` (4e85c58 —
already carries the v2.11.0 confirmation-token removal, 119d3f7; no
rebase needed). All work stays on the feature branch; Dandan merges.

Stage-1 context: `docs/EXTENSION-PLAN.md` on `feat/browser-extension`
(spike COMPLETE, all cells green). Its §8 sketched Stage 3 as
"serverless mode: extension page calls showDirectoryPicker() for a
persistent user-chosen folder; real read/write with no local server at
all."

Decisions locked by Dandan 2026-09-06 (not open for relitigation):

- **SKIP Stage 2 (native messaging) entirely.** The desktop bridge APP
  is REMOVED from the product story: no loopback fetch, no port 8765,
  no resident process. **The extension IS the product.**
- **DROP /convert** — not core; the skill tells users to convert legacy
  formats with their native office app.
- **PDF ops port to pdfium-WASM** (BSD — never MuPDF/AGPL in a public
  CWS extension): /pdf_text, /pdf_op, /image_info.
- **/pdf_from_text stays fpdf2-in-Pyodide** (already works there).
- **OCR = tesseract.js + bundled tessdata_fast** — swe+eng
  å/ä/ö+digits parity must be PROVEN against native tesseract (spike 4)
  before we claim it.
- **Bundle src/wheels/ (2.5 MB, 8 pure-Python wheels) inside the
  extension**; the service worker serves them via the existing
  `{ofb, id, method, path, b64:true}` pipe — no app /wheels dependency.

---

## 1. Architecture — FileSystemHandle adapter behind the same pipe

```
Stage 1 (today):                          Stage 3 (target):
Pyodide sandbox iframe                    Pyodide sandbox iframe
  │ postMessage (unchanged)                 │ postMessage (unchanged)
  ▼                                          ▼
page relay.js (content script)            page relay.js (UNCHANGED)
  │ chrome.runtime.sendMessage               │ chrome.runtime.sendMessage
  ▼                                          ▼
extension service worker                   extension service worker
  │ fetch http://127.0.0.1:8765              │ fs-adapter over FileSystemHandle
  ▼                                          ▼   (granted roots, handles +
Open File Bridge desktop app                permissions persisted in IndexedDB)
(Python — REMOVED from the story)
```

Same message pipe end to end. **relay.js stays byte-for-byte unchanged;
sw.js swaps its transport core** from `fetch(BRIDGE_ORIGIN + path)` to a
router that dispatches `{method, path, body}` against the FS-handle
backend. The v2 API surface (paths, query/body shapes, status-code
semantics 401/403/404/409/413/429/501 per `references/v2-endpoints.md`)
is preserved, so every existing skill recipe keeps working: the
extension is a drop-in replacement for the bridge app on the same
protocol.

Why this shape:

- The Pyodide side and every skill recipe are untouched — transport
  swap only. Proven pipe mechanics (Stage 1) carry over as-is.
- The Stage-1 security work (narrow pipe, descendant-iframes-only,
  id-correlated replies, rate limits, caps) carries over verbatim (§5).
- The bridge app's Python logic (path resolution, caps, snapshots,
  trash, audit, readonly) is the reference semantics; Stage 3 ports
  the *endpoint surface*, not the app.

## 2. Endpoint matrix — kept / ported / moved / dropped

Authoritative current surface, verified by grep of `src/file_bridge.py`
dispatch literals on this branch (2026-09-06): **41 file endpoints +
2 prefix-route families (`/wheels/<name>`, `/click/<nonce>`) + 4
`/api/*` routes** (`/api/preview`, `/api/root`, `/api/pick_folder`,
`/api/shutdown`). Note: `/picker` is NOT an endpoint (it is a risk-table
key + the app's UI name) — the picker UI is `/api/pick_folder`.

### KEPT — FS-native in the adapter, same shapes (17)

/health /version /state /list /stat /peek /read /read_b64 /search
/directory_tree /write /write_b64 /write_many /edit /delete /zip /unzip

- Direct File System Access API work (iterate handles, getFile,
  createWritable). Write safety semantics (snapshot-before-overwrite,
  trash, rate breaker, readonly roots) carried over — §5.4.
- /health reports the new engine flags in the same `addons` shape:
  `{pdf: <pdfium available>, ocr: <tesseract.js available>}`.
- /version reports `{"bridge": "3.0.0-EXT", "skill_min": "2.5"}` — the
  extension takes over the backend version role; SKILL_MIN stays 2.5
  (the extension implements the full ≥2.5 surface).

### KEPT — same shapes, JS engine port (4)

- **/image_info** — verified in source: the app's `_image_info()` is
  ALREADY a pure-stdlib binary-header parser (PNG/GIF/BMP/WEBP/JPEG
  struct unpacking; no pymupdf). Straight JS port, byte-identical
  semantics.
- **/image_b64** — same JSON shape; the pymupdf auto-downscale is
  replaced by OffscreenCanvas/createImageBitmap downscale (no engine).
- **/csv_head /csv_stats** — small JS CSV port (must handle quoted
  fields + embedded newlines like Python's csv module). Fallback if the
  port grows past ~300 lines: move to a Pyodide recipe (stdlib csv is
  available there) — decided at build time, both keep the skill working.

### KEPT — degraded UX, honest (2 + 1 family)

- **/link /reveal /click/`<nonce>`** — an extension cannot open the OS
  file manager. /link issues nonce URLs hosted by the EXTENSION PAGE
  (`chrome-extension://…/open.html?n=…`) showing the file path + a copy
  button; /click keeps its CSRF shape-gate (Dest:document +
  Mode:navigate only) in that page; /reveal returns the absolute path +
  the honest hint. Skill wording in §7. (No `tabs` permission — the
  page uses window.open.)

### KEPT — new serving source (1 + 1 family)

- **/wheels + /wheels/`<name>`** — the SW serves the BUNDLED wheels
  directory (§3b) over the same b64 pipe. The /wheels listing response
  gains nothing new; the bytes come from `extension/vendor/wheels/`
  instead of the app's src/wheels. Recipe unchanged (§7).

### KEPT — page-hosted (1)

- **/guide** — the bundled recovery-guide.html rendered by the
  extension page (same version-matched-file rule as the app).

### PORTED — new engines (4)

| Endpoint | Today (app) | Stage 3 |
|---|---|---|
| /pdf_text | pymupdf `get_text("text")` | pdfium-WASM text extraction — text-mode parity gate vs pymupdf on the addon-suite corpus (spike 3). Route choice (JS binding vs pypdfium2-in-Pyodide, which ships wasm32 wheels) decided by spike 3. |
| /pdf_op (split/merge/rotate) | pymupdf | pdfium-WASM: split = page-range copy; merge = importPages; rotate = setPageRotation. Same op/spec/angle request shape. |
| /ocr | tesseract subprocess + tessdata | tesseract.js + bundled tessdata_fast; swe+eng å/ä/ö+digits parity gate vs native tesseract (spike 4). |
| /ocr_pdf | pymupdf render + tesseract | composed: pdfium renders pages → tesseract.js recognizes → pdfium writes the invisible text layer. Parity gate = addon-suite ocr_pdf fixtures (probe-term hits in extracted text). |

### MOVED — Pyodide recipes, endpoint retired from the backend (11)

/docx_read /docx_write /docx_merge /docx_mailmerge /pptx_read
/pptx_from_template /xlsx_read /xlsx_append /pdf_from_text /eml_read
/html_text

- All of these already execute in Pyodide today (python-docx/-pptx/
  openpyxl/fpdf2 from wheels; stdlib email/html.parser for eml/html).
  The skill gains explicit recipes (read via /read_b64 → parse in
  Pyodide; write via /write_b64), exactly the pattern Stage 1 proved
  end-to-end (openpyxl wheel → import → real xlsx via /write_b64).
- pdf_from_text: zero change — already fpdf2-in-Pyodide (Dandan's
  decision).
- Old endpoint names get a clean "not available in extension mode; use
  the recipe" error, never a hang (negative test, §8).

### DROPPED (1 + 2 api)

- **/convert** — Dandan: not core. Skill user-message guidance in §7.
- **/api/root, /api/shutdown** — app-shell lifecycle; the extension
  options page owns settings; nothing to shut down.
- **/api/preview, /api/pick_folder** — REPLACED by the extension page's
  own grant/preview UI (§4).

### Arithmetic self-check (41 endpoints)

17 FS-native + 4 JS-port + 2 degraded + 1 bundled + 1 page + 4 ported
+ 11 moved + 1 dropped = 41 ✓ (plus the /click and /wheels/ prefix
families counted with their parents, plus 4 /api/*: 2 dropped, 2
replaced-by-page).

## 3. Manifest changes

```jsonc
{
  "manifest_version": 3,
  "name": "Open File Bridge",
  "version": "3.0.0",
  "permissions": ["storage"],
  // host_permissions: NONE — the loopback permission disappears with
  // the loopback fetch. No tabs/downloads/alarms/unlimitedStorage.
  "background": { "service_worker": "sw.js" },
  "content_scripts": [{ "matches": ["https://*/*"], "js": ["relay.js"],
                        "run_at": "document_idle" }],
  "options_page": "options.html",
  "action": { "default_title": "Open File Bridge" }
  // "web_accessible_resources" only if the in-page panel ships;
  // "minimum_chrome_version" pinned after spike 1.
}
```

- **`host_permissions: http://127.0.0.1:8765/` goes away — big CWS
  review win.** With no host permissions and no network egress at all,
  the EXTENSION-PLAN §7 Q2 scope question becomes **moot**: what
  remains reviewable is one UI-less content script (message listener,
  no DOM scraping, no network, no storage of page data) + a service
  worker that only touches extension storage, extension pages, and the
  user-granted folder. Verified against the live CWS review-process doc
  (2026-09-06): its stated review-time factors are broad match
  patterns, powerful permissions, and code volume/obfuscation — we now
  score low on all three (relay matches stay `https://*/*` — the one
  broad thing; the docs frame breadth as review-TIME, not rejection;
  the deferred lever of `optional_host_permissions` origin-pinning
  stays documented if real review feedback ever demands it).
- Permissions budget: `storage` only. No `unlimitedStorage` (IndexedDB
  holds handles + audit + settings = kilobytes; tessdata/wheels are
  packaged resources, not storage).

### 3b. Bundled assets & size budget (~50 MB)

| Asset | Size | Source/notes |
|---|---|---|
| wheels/ — 8 pure-Python .whl | 2.5 MB | measured: `src/wheels/` on this branch (defusedxml, et_xmlfile, fonttools 1.2M, fpdf2, openpyxl, python_docx, python_pptx, typing_extensions) |
| tessdata_fast, top-8 languages | ~40 MB (est.) | upstream tessdata_fast per-language files; the repo's own 74 MB set is the *standard* variant (measured: swe 4.0, eng 3.9, dan 2.5 MB …) — fast files are roughly ⅓–½ those sizes. Exact set + real bytes measured and frozen in spike 2. Default top-8 proposal: eng swe dan nor deu fra spa chi_sim + osd (rotation detection) — Dandan can veto/extend the list; it is a packaging variable, not code. |
| tesseract.js + worker + wasm core | ~5 MB | tesseract.js v5/v6 + tesseract-core-simd LSTM wasm |
| pdfium-WASM + glue | ~3 MB | pdfium wasm build (~2.5–4 MB) |
| extension code (sw.js, relay.js, fs-adapter, options, pages) | ~0.1 MB | zero-dependency, as-authored |
| **Total** | **~50 MB** | matches the budget Dandan set |

- **CWS size cap: no numeric item-size limit is published on the
  current developer docs** (register / set-up-account / prepare /
  publish / FAQ pages pulled live 2026-09-06 — they publish the
  per-publisher item-count limit and review-time factors, not an item
  size). The "2 GB" number in circulation traces to a 2011-era support
  page and stale copies; do not trust it in either direction. Spike 2
  verifies the dashboard's actual upload constraint before submission
  planning (and notes the new-publisher 2-item limit).
- ~50 MB is far inside anything ever published; the real review risk
  per the live docs is **code volume + minification/obfuscation** —
  hence: ship our JS as-authored (docs explicitly recommend it), keep
  vendored blobs versioned + sourced + licensed in
  `extension/vendor/NOTICE.md` (pdfium BSD/Apache-2.0, tesseract.js
  Apache-2.0, tessdata_fast Apache-2.0, wheels carry dist-info
  licenses), keep first-party code small and readable.

## 4. Folder-grant UX & MV3 SW lifetime vs long file ops

**Grant flow (first run):**

1. The user clicks the extension action → opens the extension's own
   page (`chrome-extension://…/setup.html`) in a tab — a **visible
   extension page**, because `showDirectoryPicker()` requires a user
   gesture in a visible document and does not exist in service-worker
   scope (verified against the live File System Access docs
   2026-09-06: secure-context + user-gesture requirements; the picker
   is exposed on Window, not WorkerGlobalScope).
2. `const root = await showDirectoryPicker({ mode: "readwrite" })` →
   store `{handle, alias, mode, grantedAt}` in **IndexedDB** (handles
   are structured-cloneable; chrome.storage cannot hold them).
3. The fs-adapter loads handles from IndexedDB on demand and
   re-checks `queryPermission({mode})` before every op family; on
   `prompt` it returns a structured `permission-needed` error so the
   skill tells the user to click the extension → **Reconnect folder**
   (one button on the stored handle — `requestPermission()` re-asks,
   the folder is NOT re-picked).
4. After browser restarts permission is not always persisted (docs):
   the same Reconnect path covers it. Multi-root: the app's model
   (id/path/alias, max 4) carries over; the adapter maps root id →
   handle; a root granted `read` only = the app's readonly-root
   semantics (writes 403).

**MV3 SW termination vs long file ops** — the core Stage-3 design
problem (MV3 SWs die after ~30 s idle, 5-min hard lifetime cap since
Chrome 110):

1. **Chunked transfer as the long-op protocol.** Anything plausibly
   >5 s is chunked: writes >1 MB split into append-chunks
   (createWritable → write → … → close) tracked in an IndexedDB
   transfer record — an interrupted write leaves a resumable
   part-file, never a corrupt target. SW death mid-chunk is fine: the
   next message wakes the SW; handles are browser-side objects that
   survive SW death; the adapter resumes from the transfer record.
   The pipe's caps stay (10 MB/message, 64 MB response, b64 for
   binary) and relay rate caps stay as-is (a 10 MB write at 1 MB
   chunks = 10 messages, far under 120/min).
2. **Heavy engines run in a PAGE, not the SW.** tesseract.js and
   pdfium-WASM instantiate in the extension page (or a dedicated
   hidden extension iframe) woken by the SW; the SW stays a thin
   router. WASM re-instantiation per SW cold start would be slow and
   burn the 5-min cap. Principle: **SW = routing + small FS ops;
   page = engines.** (Final split tuned on spike-1/3/4 evidence.)
3. **No keep-alive hacks.** No alarms spam, no infinite ports. Long
   ops are chunked or page-hosted; the SW is allowed to die between
   chunks — the transfer record + resumable protocol makes that safe.
4. **Audit trail** in IndexedDB (op, path, bytes, ok/err, ts) — the
   app's audit-log semantics carried over; surfaced by /state and the
   extension page. (Evidence discipline unchanged: claims triangulate
   against this log.)
5. **Atomicity:** FS Access has no cross-handle atomic rename; the
   pattern is temp-file-in-same-dir + `move()` onto the target with
   snapshot-first (§5.4) — overwrite safety stays testable.

## 5. Security invariants (carried from EXTENSION-PLAN §3, adapted)

1. **Narrow pipe.** SW accepts only `{ofb:true, id, method, path,
   body?}` (+`b64:true`). With the loopback backend gone there is **no
   network egress from the extension at all** — a message can choose a
   path within granted roots, never a destination host. Stage-1
   negative cells carry over with FS-backend semantics (`//evil.com/x`
   → no-such-path, port/host/url fields dropped, PUT refused).
2. **Tier-2 token: RETIRED (Dandan approved 2026-09-06).** The token
   authenticated page→app over loopback; extension-only, the boundary
   is the browser's own permission gate (per-op queryPermission) + the
   relay's descendant-iframe/id/rate gates. The options page gains the
   replacement consent control: a per-root "writes enabled" toggle
   (default on for readwrite roots; readonly grants exist at pick
   time). The confirmation-token flow (the v2.11.0 removal on the app
   line) carries over BY CONSTRUCTION: the adapter never had an
   approval round trip — writes are immediate + snapshot-first, same
   contract as app 2.11+ / skill 2.11+.
3. **Relay gates unchanged** (descendant-iframes-only, id-correlated
   targeted replies, ≤30 in-flight, ≤120/min, 10 MB payload cap) —
   relay.js is byte-for-byte the Stage-1 file.
4. **Write safety carried from the app:** snapshot-before-overwrite
   (copy target into `.ofb-trash/` before replace), trash-deletes,
   snapshot-on-restore, write-rate breaker + MB caps (the Safety-card
   equivalents on the options page), readonly roots refuse writes with
   the app's 403 shape.
5. **/state** reports roots, modes, caps, engine flags, audit summary —
   same contract as the app's.
6. **No obfuscation/minification** of first-party code; vendor NOTICE;
   CWS docs explicitly prefer as-authored code.
7. **Zip-slip guard** on /unzip identical to the app's path checks.

## 6. Skill changes (SKILL-EXT gets a Stage-3 section)

SKILL-EXT.md 2.10-EXT → **3.0-EXT** (manual publish until setup_owui
wiring — unchanged follow-up status):

- **Transport: unchanged.** `ofb_fetch` / `ofb_fetch_b64` /
  `bridge_get` / `bridge_post` exactly as shipped; the pipe is the same.
- **/convert dropped, user-message guidance added** (wording): "I can't
  convert legacy formats directly — please open the file in your
  office app (Word / Excel / LibreOffice) and save it as .docx / .xlsx,
  then I can read and edit it."
- **Wheels recipe unchanged** — `ofb_fetch_b64("/wheels/<name>.whl")`
  → `zipfile.extractall(purelib)`; only the byte source changes
  (bundled in the extension).
- **PDF/OCR endpoints same shapes** — model code unchanged; /health's
  `addons` flags reflect the new engines.
- **401/token guidance REMOVED** (token retired with the app).
- New bootstrap notes: /health `permission-needed` → tell the user to
  click the extension icon → Reconnect folder; writes >1 MB chunk
  automatically (model code never chunks manually); /link /reveal
  honest-degrade wording (extension page shows the path + copy
  button, cannot open the OS file manager); moved-endpoint recipes
  (docx/pptx/xlsx/eml/html via /read_b64 + /write_b64 with bundled
  wheels).
- SKILL_MIN: unchanged 2.5 policy — the extension reports
  `{"bridge": "3.0.0-EXT", "skill_min": "2.5"}`; standard SKILL.md /
  SKILL-STRICT.md variants are untouched in Stage 3 (they serve the
  app product line; story merge happens at Dandan's merge time).

## 7. Prove-or-kill spikes (in order — stop and report on any kill)

1. **FS-handle backend through the existing pipe** (the foundation,
   biggest unknown): showDirectoryPicker from an extension page →
   handle persisted in IndexedDB → /health /list /read /write
   implemented through the REAL relay.js + sw.js pipe (transport core
   swapped to the adapter) → full round-trip in a real browser.
   Automation risk to prove early: Playwright cannot grant the native
   directory picker — spike proves the headed/Xvfb + OS-level drive
   path (Stage-1 PWA cell precedent) or a test-only pre-grant hook;
   budget a day for this alone.
2. **CWS practicalities** (against CURRENT pages — research already
   begun in this plan): exact size cap (none published — verify
   dashboard-side), fat-extension review friction (~50 MB bundle of
   traineddata + wheels + wasm), new-publisher 2-item limit, and
   whether large WASM/data blobs trip automated checks.
3. **pdfium-WASM /pdf_text parity** vs pymupdf on the addon-suite PDF
   corpus (reuse tests/addon_test.sh fixtures). Metric:
   whitespace-normalized per-page text equality, 100% on corpus; also
   decides the route (JS binding vs pypdfium2-in-Pyodide).
4. **tesseract.js swe+eng parity** vs native tesseract on the same
   fixtures — portable tesseract at ~/tools/tesseract-5.3.4 with
   TESSERACT_CMD/LD_LIBRARY_PATH via the /tmp/run_addon.sh pattern
   (recreate the script if /tmp was wiped). Gate: å/ä/ö AND digits
   both correct with swe+eng combo (project history: single-language
   breaks one or the other). Fallbacks if fast data fails: standard
   swe+eng (~8 MB more), or LSTM-only configs; kill criterion =
   parity unachievable at acceptable size.

## 8. Test strategy

- **Spike gates 1–4** (§7) with stop-and-report; each spike's verdict
  recorded with real-browser evidence / real files / audit lines.
- **Extension e2e** (build phase): extend tests/extension_e2e.py —
  Stage-1 phases a/c/d/e (load, round-trip+negatives, rate limit,
  binary b64 wheel→xlsx) re-targeted at the FS backend, plus new
  cells: permission-revoked mid-session, root-not-granted, path
  outside roots, SW-restart mid-chunk (terminate the SW and continue
  the chunk stream), zip-slip refusal, snapshot-before-overwrite file
  on disk, readonly-root write refusal, moved-endpoint clean error
  (no hang).
- **Parity tests** for every ported endpoint vs the app on addon-suite
  fixtures (pdf_text, pdf_op outputs, ocr text, ocr_pdf probe terms).
- **Build rules honored:** full Chromium
  (`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`) +
  launchPersistentContext + FRESH profile dir per run (MV3 SW cache);
  port 8765 kept free / stray-kill only via `pgrep -af "file_bridg[e]"`;
  owui-test container (docker start owui-test) serves harness Pyodide;
  harness pages over http://127.0.0.1 with the test manifest copy;
  unique test filenames per run (the 409 gate); every claim needs a
  real run/file/audit line behind it.
- **Regression suites:** `uv run --with pymupdf --with
  rapidocr-onnxruntime bash tests/e2e_test.sh` AND
  `bash tests/addon_test.sh` (via /tmp/run_addon.sh) green before
  every commit — Stage 3 must not touch src/file_bridge.py, so these
  stay green on the app line.

## 9. Build phases (after approval)

- P0: vendor dirs + NOTICE; recreate /tmp/run_addon.sh if wiped;
  environment checks (8765 free, owui-test up, Chromium present).
- P1: fs-adapter core — handle store, permission re-check, roots,
  /health /list /read /write /stat round-trip through the real pipe
  (fresh profile). P1b: Stage-1 negative cells + caps re-run.
- P2: bundled wheels served via pipe → openpyxl import in sandboxed
  Pyodide → real xlsx via /write_b64 → /stat 200. P2b: CWS-readiness
  pass (manifest final, NOTICE, as-authored, measured du, zip).
- P3: pdfium /pdf_text + /pdf_op per spike-3 route + parity green.
- P4: tesseract.js /ocr + /ocr_pdf + parity green.
- P5: skill 3.0-EXT section + /state flags + degrade wording; docs.
- P6: full extension e2e + both regression suites + employer sweep
  (`git grep -il` employer-name variants over staged tree AND branch
  log) + commit as Dandan Wei <chopper.ddw@gmail.com> + push feature
  branch (never master; Dandan merges).

## 10. Risks & honest unknowns

- SW-death-mid-chunk resume correctness — unproven until spike 1 /
  P1 (transfer-record protocol).
- tesseract.js parity NOT assumed — spike 4 gate is mandatory
  (tessdata_fast quality on swe is exactly the kind of thing that
  breaks å/ä/ö).
- pdfium text-extraction order/ligatures differ from mupdf —
  normalized-compare metric settled in spike 3.
- Native-picker automation in tests is the flakiest link — headed
  Xvfb + OS-level driving; budgeted in spike 1.
- CWS automated review of ~45 MB of wasm/traineddata is an unknown;
  live docs frame size as review-time, not rejection; NOTICE +
  as-authored is the mitigation.
- /reveal //link degrade honestly (no OS file manager from an
  extension) — documented, not hidden.
- App/extension story split in README is deferred to merge time
  (Dandan's merge decision).

---

## Approval box (Dandan) — APPROVED 2026-09-06, decisions locked

- [x] §1 Architecture: FS-handle adapter behind the unchanged pipe;
      app removed from the product story
- [x] §2 Endpoint matrix: 17 kept FS-native / 4 JS-port / 4 ported
      engines / 11 moved to Pyodide recipes / 1 dropped (/convert) —
      including the MOVED list (docx/pptx/xlsx/eml/html as recipes)
      and csv JS-port-vs-recipe default
- [x] §3 Manifest: storage-only, host_permissions 8765 GONE (scope
      question moot)
- [x] §3b Size budget ~50 MB + tessdata top-8 default list
      (eng swe dan nor deu fra spa chi_sim + osd)
- [x] §4 Folder-grant UX (visible extension page, IndexedDB handle,
      Reconnect-after-restart) + SW-lifetime design (chunked writes,
      engines in page, no keep-alive hacks)
- [x] §5.2 Token retirement — APPROVED (replacement = per-root write
      toggle)
- [x] §6 Skill changes (3.0-EXT section, /convert user message,
      unchanged wheels recipe)
- [x] §7 Spike order + stop-and-report rule
- [x] §9 Build phases

Additional instruction locked at approval (Dandan, 2026-09-06): the
app line's v2.11.0 confirmation-token removal applies here too — the
branch base (4e85c58) already carries 119d3f7, so the extension
inherits the no-approval, writes-immediate + snapshot-first contract;
no rebase needed. All Stage-3 work stays on `feat/stage3-extension`;
Dandan merges to master.

---

*Drafted 2026-09-06 on `feat/stage3-extension` (off origin/master
4e85c58). Grounding: live CWS docs (register, set-up-account, prepare,
publish, FAQ, review-process) and live File System Access docs, both
pulled 2026-09-06; repo facts measured on this branch — 41 dispatched
file endpoints + /wheels//click/ prefix families + 4 /api/* routes
(grep of src/file_bridge.py), wheels 2.5 MB / 8 .whl, tessdata
standard 74 MB / 22 langs (fast variants estimated, frozen in spike
2).*
