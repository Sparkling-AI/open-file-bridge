# File Bridge — Roadmap

Status legend: ☐ not started · ◐ in progress · ✅ done
Priorities: P0 = production gate · P1 = high value · P2 = later · P3 = optional

---

## P0 — Production gates (must before internal rollout)

☐ **CORS lock to OWUI origin** — today `Access-Control-Allow-Origin: *`
   lets ANY website's JS call the bridge. Fix: first-run picker asks for the
   OWUI URL, saved next to the folder choice in `~/.file-bridge.json`.
   (TODO.md #1 has the full rationale.)

☐ **Bearer token auth** — defense in depth against local pages/processes
   (Firefox does not enforce PNA). Token generated on first run, stored
   0600 (OpenWorker secrets.py pattern), shown in settings page, sent by
   the skill as a header; **never echoed in chat/context** (their hard rule).
   OpenWorker independently converged on the same 8765+token design.

☐ **Binary read whitelist + /peek + windowed reads** — `/read` on binary
   files today yields mojibake; `/read_b64` can push 8 MB into context.
   Four layers (windowing pattern borrowed from OpenWorker tools/files.py):
   1. extension whitelist for `/read`, **fail-closed** on unknown extensions
      (OpenWorker readonly.py confirms fail-closed as the right default)
   2. magic-byte sniffing (`%PDF-`, `PK\x03\x04`, `\x89PNG`…) → reject
      with routing hint ("this is a PDF → use /pdf_text")
   3. `/peek?bytes=512` — identify a file for ~5 lines of tokens
   4. **`/read` windowing**: cat -n numbered lines, `start_line`/`max_lines`
      (default 2000), 500-char line clip, response tells the model how to
      continue — large files become page-through instead of a hard cap.
   Enforcement lives in the BRIDGE (hard), skill rules are advisory only.

☐ **Write-before-overwrite snapshots + confirmation tokens** — before any
   write to an existing file, copy original to `.fb-versions/<name>.<ts>`;
   destructive ops get a two-step confirmation token (60 s validity — design
   borrowed from OWUI openapi-servers filesystem server). Makes model edits
   reversible and deliberate — trust foundation for office use.
☐ **"Production mode" hard-fail** — bridge refuses to serve with CORS `*`
   AND no token simultaneously (Open Terminal v0.11.30 refuses keyless
   start; adopt the stance).

☐ Skill rule: never dump whole large files into chat; summarize + cite.

## P0.5 — Standing strategic items (from ecosystem research)

☐ **Pyodide deprecation watch** — OWUI officially calls Pyodide CI "legacy,
may be deprecated". Pin OWUI version in production; re-verify the
two-switch preset (`capabilities` + `defaultFeatureIds`) on every upgrade;
keep the Jupyter/Open-Terminal fallback documented (see
RESEARCH-owui-ecosystem.md §1).

## P1 — Office reads move to the bridge (big UX win)

Principle: parsing cost & reliability differ by side; content entering the
model context is the same. READ belongs bridge-side (native libs, no session
install), WRITE stays in Pyodide for now (already works, content flows
through the model anyway).

☐ `/xlsx_read?path=&sheet=&range=` → JSON: row count, headers, data grid,
   merged cells. Uses full native openpyxl (Pyodide wheel is a subset).
☐ `/docx_read?path=` → markdown-ish text preserving headings/lists/tables.
☐ `/pptx_read?path=` → per-slide title + text boxes.
   Side effect: pure-read tasks need NO wheel install → first interaction
   drops from ~3 s to ~0 s.
☐ `/html_text?path=` — strip tags via stdlib html.parser (today /read
   returns raw HTML source = tag noise per token).
☐ `/csv_head?rows=20` + `/csv_stats` (row count, columns, type sampling,
   numeric ranges) — stdlib csv; prevents whole-CSV context dumps.
☐ `/search?q=&glob=&exclude=` — cross-file grep with context lines,
   file-pattern + exclusion patterns (param design adopted from OWUI
   openapi-servers /search_content + /search_files). "Which contract
   mentions termination clause" is THE top office query.
☐ `/edit?dry_run=1` — surgical text replacements with unified-diff preview;
   on confirm applies. (Borrowed from openapi-servers /edit_file.)

## P2 — Reliability & rollout

☐ **Windows + macOS real-machine testing** — everything so far verified on
   Linux only: drive letters/backslashes, port-conflict UX, first real Inno
   Setup compile, SmartScreen/Gatekeeper flows.
☐ Inno Setup compile run on Windows (script written, never executed).
☐ Audit log (sqlite or JSONL, from OpenWorker audit.py pattern): every call
   logs ts, endpoint, path, size, status + **secret-scrubbed args** and
   truncated result preview (copy their `_SECRET_KEYS` scrub list).
☐ Atomic writes (temp + rename); symlink-escape tests on Windows.
☐ Log rotation; optional service/LaunchAgent installers.
☐ `/ocr_pdf` — tesseract PDF output → searchable PDF (scan → archive).
☐ Content-hash cache for /pdf_text + /ocr results (OpenWorker pdf_support:
   history replays every turn — same for chat re-asks; sha256+params keyed).
☐ `/pptx_from_template` (.potx/pptx layout matching) + `/docx_merge`
   placeholder filling — from OpenWorker issue #454 (real office demand).
☐ `/pdf_text?mode=text|images` — images mode rasters pages (pypdfium2,
   144dpi, ≤100pg) for vision models; capability fallback pattern.
☐ Sensitive-name blacklist (.env, id_rsa, credentials) in bridge.
☐ Version endpoint + update nudge (keep skill & bridge in sync).
☐ `/zip`, `/unzip` (stdlib zipfile).
☐ `/directory_tree?format=tree` (from openapi-servers).
☐ Local preview tab in settings page (what the AI can see) — Open Terminal
   file-browser inspiration.

## P3 — Optional / bigger bets

☐ Signing decisions per feedback matrix:
   - internal AD: internal CA or GPO whitelist (free)
   - external: Windows OV ~$100-200/yr (EV ~$400 for zero friction);
     macOS Apple Dev ID $99/yr + notarize (`package_macos.sh --sign` ready)
   - Unsigned IS installable on both (SmartScreen "more info→run anyway";
     macOS right-click→open) — docs already cover it.
☐ LibreOffice headless conversion endpoints: legacy .doc/.xls/.ppt →
   modern formats; docx→pdf (heavy: hundreds of MB).
☐ Structured write endpoints: /xlsx_append, /docx_write (sections),
   /pdf_from_text (native fpdf2, no Pyodide shim needed).
☐ Mail-merge: docx template {{placeholders}} + xlsx rows → batch PDFs.
☐ .eml parsing (stdlib email); .msg via extract-msg.
☐ PDF split/merge/rotate (pymupdf, nearly free).
☐ Safe delete (move to .fb-trash).
☐ `/reveal` (Explorer/Finder locate — PROMOTED to P1, cheap + high perceived value).
☐ rclone recipe: bridge folder = cloud-drive mount (answers demand in
   OWUI #5872 data sources, 52+) — docs only.
☐ /image_info (dimensions/EXIF; PIL optional plugin).
☐ OWUI version-compat window documented (tested 0.11.1).
☐ Multi-model smoke tests (only GLM tested; weak models may need stronger
   skill rules).
☐ RiskClass per endpoint (READ/WRITE_LOCAL/…) declared in code — from
   OpenWorker risk.py; future-proofs confirmation/audit gating.
☐ Skill shipped as folder w/ version + changelog; setup script previews
   diff before updating an existing skill (their staging pattern).
☐ Support runbook (SmartScreen / port conflict / Safari).

## Format support matrix (current)

| Format | Read | Write | Notes |
|---|---|---|---|
| txt/md/code | ✅ /read | ✅ /write | |
| csv | ✅ /read (whole) | ✅ | P1: head/stats endpoints |
| html | ⚠ raw source | ✅ | P1: /html_text |
| xlsx/docx/pptx | ✅ via Pyodide wheels | ✅ via Pyodide | P1: bridge-side read |
| pdf (text layer) | ✅ /pdf_text | ✅ fpdf2 (Pyodide) | |
| pdf (scanned) | ✅ /ocr (tesseract) | — | swe+eng combo verified |
| images | ✅ /ocr, /read_b64 | ✅ /write_b64 | |
| doc/xls/ppt (legacy) | ❌ | ❌ | P3: LibreOffice convert |
| zip | ❌ | ❌ | P2: /zip /unzip |

## Measured performance (reference)

- Pyodide office-lib install: ~3 s once per chat session (shared worker),
  then instant. Local wheels ≈ PyPI CDN for speed; chosen for
  offline-safety + version pinning (user decision: local-only).
- tesseract OCR: ~0.5 s/page @200 dpi (RapidOCR was 2.1 s).
- Combo langs: swe+eng fixes å/ä/ö AND digits (each alone breaks one).
