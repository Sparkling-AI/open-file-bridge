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
   (Firefox does not enforce Private-Network-Access). Token generated on
   first run, shown in the settings page, sent by the skill as a header.

☐ **Binary read whitelist + /peek** — `/read` on binary files today yields
   mojibake; `/read_b64` can push 8 MB into chat context = token bonfire.
   Three layers:
   1. extension whitelist for `/read` (txt/md/csv/json/xml/yaml/log/code…)
   2. magic-byte sniffing (`%PDF-`, `PK\x03\x04`, `\x89PNG`, `\xff\xd8`…)
      → reject with routing hint ("this is a PDF → use /pdf_text")
   3. `/peek?bytes=512` endpoint so the model can identify a file for
      ~5 lines of tokens before choosing the right reader.
   Enforcement lives in the BRIDGE (hard), skill rules are advisory only.

☐ **Write-before-overwrite snapshots** — before any write to an existing
   file, copy original to `.fb-versions/<name>.<timestamp>`. Makes model
   edits reversible — trust foundation for office use.

☐ Skill rule: never dump whole large files into chat; summarize + cite.

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
☐ `/search?q=&glob=` — cross-file grep with context lines. "Which contract
   mentions termination clause" is THE top office query.

## P2 — Reliability & rollout

☐ **Windows + macOS real-machine testing** — everything so far verified on
   Linux only: drive letters/backslashes, port-conflict UX, first real Inno
   Setup compile, SmartScreen/Gatekeeper flows.
☐ Inno Setup compile run on Windows (script written, never executed).
☐ Audit log `~/.file-bridge.log` (metadata only: ts, action, path, size).
☐ Atomic writes (temp + rename); symlink-escape tests on Windows.
☐ Log rotation; optional service/LaunchAgent installers.
☐ `/ocr_pdf` — tesseract PDF output → searchable PDF (scan → archive).
☐ Sensitive-name blacklist (.env, id_rsa, credentials) in bridge.
☐ Version endpoint + update nudge (keep skill & bridge in sync).
☐ `/zip`, `/unzip` (stdlib zipfile); `/reveal` (Explorer/Finder locate).

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
☐ /image_info (dimensions/EXIF; PIL optional plugin).
☐ OWUI version-compat window documented (tested 0.11.1).
☐ Multi-model smoke tests (only GLM tested; weak models may need stronger
   skill rules).
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
