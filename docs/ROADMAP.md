# File Bridge — Roadmap

Status legend: ☐ not started · ◐ in progress · ✅ done
Priorities: P0 = production gate · P1 = high value · P2 = later · P3 = optional

---

## Reference implementation index — build faster by copying

Three studied repos with per-feature pointers. Clone locally before implementing:

```bash
git clone --depth 1 https://github.com/andrewyng/openworker /tmp/openworker
git clone --depth 1 https://github.com/open-webui/open-webui   /tmp/owui-src
git clone --depth 1 https://github.com/open-webui/openapi-servers /tmp/owui-openapi-servers
```

Deep-dive notes: RESEARCH-openworker.md · RESEARCH-owui-ecosystem.md ·
(Open Terminal analysis in the latter, §1b.)

| Our item (below) | Copy from | Exact source | What to take |
|---|---|---|---|
| /read windowing (P0) | openworker | `coworker/tools/files.py` | cat -n formatting, start_line/max_lines params, 2000-line default, 500-char clip, "how to continue" trailer |
| Fail-closed whitelist (P0) | openworker | `coworker/readonly.py` | allowlist philosophy, pipeline handling, reject-by-default posture |
| Token store 0600 (P0) | openworker | `coworker/secrets.py` | state_dir() per-OS resolution, atomic tmp+chmod, never-in-context rule |
| Audit log (P2) | openworker | `coworker/audit.py` | sqlite schema incl. approval column, `_SECRET_KEYS` scrub list, result_preview truncation |
| RiskClass per endpoint (P3) | openworker | `coworker/risk.py` | enum + classify + override-floor mechanism |
| Hash cache for /pdf_text,/ocr (P2) | openworker | `coworker/pdf_support.py` | `_cached(key=(sha256,op))` LRU pattern, replay rationale |
| PDF mode=text\|images (P2) | openworker | `coworker/pdf_support.py` | pypdf extract vs pypdfium2 raster@2x, RASTER_MAX_PAGES=100 |
| Confirmation tokens (P0) | owui openapi-servers | `servers/filesystem/main.py` L147-197, L392-491 | 60s token, .pending_confirmations.json, params match check |
| /edit dry-run diff (P1) | owui openapi-servers | `servers/filesystem/main.py` L254-301 | multi-replacement, dry_run, unified diff output |
| /search params (P1) | owui openapi-servers | `servers/filesystem/main.py` L363-387, L563-596 | context lines, file pattern, exclusions, case-insensitive |
| Preset two-switch config | owui | `src/lib/components/chat/Chat.svelte` L1075-1089 | capabilities.code_interpreter AND defaultFeatureIds — regression-test on upgrades |
| Direct tool connections (Plan B) | owui | `src/routes/+layout.svelte` L630-646 + Open Terminal security docs | browser-direct call pattern if Pyodide CI dies |
| PPT template / docx merge (P2) | openworker #454 | issue thread (demand) | .potx layout matching, {{placeholder}} filling |
| Attachment caps | openworker | `coworker/attachments.py` L17-20 | 200k text / 12M image / 15M pdf / 8 per turn |
| Skill staging/preview (P3) | openworker | `coworker/skills/store.py` | parse→preview→confirm upload flow, disable-outside-folder rule |
| Multi-root resolution (P0b) | openworker | `coworker/permissions.py` L314+ | `_resolved_roots()`, write_paths root scoping, fail-closed unlocatable |
| Protected-paths floor (P0b) | openworker | `coworker/permissions.py` L93-135 | self-protection list + in-project markers (.git/hooks, CI files) |
| Trust store per root (P0b) | openworker | `coworker/workspace_trust.py` | canonical paths, 0600 atomic writes, per-root grants |

Licenses: openworker MIT · open-webui BSD-3 (check branding clause for code
vs docs) · openapi-servers MIT — all permissive, attribution in NOTICE
recommended when copying non-trivial blocks.

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

## P0b — Scope configuration & accident protection (enterprise-critical)

### Multi-root + ignore lists (scope control)

☐ **Multi-folder roots** — settings page supports ONE OR MORE shared folders;
   every endpoint takes a root-relative path + root id (or search across
   roots by default). Each root stores: path, alias, enabled flag.
   Pattern: OpenWorker `_resolved_roots()` (permissions.py L314) +
   WorkspaceTrustStore (workspace_trust.py) — trust per canonical path,
   atomic 0600 state writes.
☐ **Ignore/exclude list per root (and global)** — gitignore-style patterns
   (e.g. `.git/`, `node_modules/`, `*.tmp`, `secrets/`): /list omits, /read
   + /pdf_text + /ocr + future /search return 404-with-hint ("excluded by
   settings"), /write into ignored paths is refused. Enforced in the BRIDGE,
   surfaced in skill ("if excluded, tell the user to adjust settings").
☐ **Bridge self-protection floor** (OpenWorker permissions.py L93-123):
   `~/.file-bridge.json`, token file, audit db, versions dir are NEVER
   writable via any endpoint, in any mode. Prevents "one approved write
   quietly widens future permissions".

### Mass-operation damage limiting

Design stance (validated by OpenWorker source): **no delete endpoint, ever.**
Deletion only as trash-move. Writes are the remaining blast surface — guards:

☐ **Snapshots (P0 item, restated here as part of the system)** — every write
   to an existing file copies original to the versions store first;
   /versions/list + /versions/restore endpoints.
☐ **Trash instead of delete** (PROMOTED from P3) — `/delete` moves to the
   trash store preserving tree; /trash/list + /trash/restore; auto-purge
   after N days (default 30). "Delete" is never a real unlink via the API.

**STORAGE PLACEMENT DECISION (resolved 2026-08-27, from user review):**
trash and versions live OUTSIDE all shared roots, in
`state_dir()/trash/<root-hash>/<ts>/` and `state_dir()/versions/<root-hash>/…`
— NOT as `.fb-trash/` inside the root. Rationale:
  a) **Structural unreachability beats ignore-listing**: the path resolver
     only resolves inside roots, so the model can never address these files
     — no whitelist/ignore interplay exists at all. Ignore entries are
     policy (configurable, missable); placement is architecture.
  b) **Old/deleted content must not re-enter model reach**: versions hold
     data the user just edited OUT (e.g. removed credentials); trash holds
     files they removed entirely. Neither may be readable via the file API.
  c) No pollution of user folders (sync services, backups, user globs).
Cost: cross-filesystem moves become verified-copy-then-unlink (only when
root and state dir are on different devices; same-device stays a rename).

**Visibility rules**: /trash/list + /versions/list return METADATA only
(path, ts, size) — never contents. Restore counts as a write (rate-limit +
audit + snapshot-first if target exists now). Manual purge = settings page
only. Model MAY offer "restore the previous version" (anti-accident UX) but
must never read old contents. If any bridge-owned file ever must live
inside a root (none planned): hard structural ignore, not user-configurable.
☐ **Write-rate circuit breaker** — bridge-side quota: max K writes per
   rolling 60 s window (default 20) + max total MB written per window;
   exceeding triggers 429 with "ask user to confirm mass edit" message the
   skill relays. A runaway model hits the brake, not the folder.
☐ **Mass-edit detection** — `/write_many` requires an explicit
   `confirmed: true` second call when batch size is over 5 files (token
   pattern from openapi-servers). Skill rule: for over 5 file changes, list
   the plan first, get user OK, then batch.
☐ **Read-only mode toggle** (settings page, per root or global): disables
   /write, /edit, /delete entirely — for demo/paranoid mode. Env override
   too (FILE_BRIDGE_READONLY=1).
☐ **Git-tracked folders: optional safety** — detect .git in root, settings
   offer "auto-commit before AI writes" (user.name="File Bridge"); opt-in,
   off by default (noise for office folders); gives `git diff` review after
   long sessions. Not a substitute for snapshots — big binary files make
   git fat; snapshots cover those.

Reference index additions: permissions.py L93-213 (protected paths,
write_paths root scoping), workspace_trust.py (trust store), readonly.py
(mode classification). NOTE file when copying.

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
☐ `/reveal` (Explorer/Finder locate).
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
