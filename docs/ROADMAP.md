# File Bridge — Roadmap

Status legend: ☐ not started · ◐ in progress · ✅ done
Priorities: P0 = production gate · P0b = scope/accident · P1 = high value · P2 = later · P3 = optional

**Implementation order (2026-08-27):** P0 → P0b → P0.5 (standing) → P1 → P2
(Linux-only; Win/mac is the user's final phase) → P3 opportunistic.
Start at P0 item 1. Read docs/DEVNOTES.md first — environment quirks and
test-infra rebuild live there (`bash scripts/rebuild_testenv.sh`).

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

✅ **CORS lock to OWUI origin** — today `Access-Control-Allow-Origin: *`
   lets ANY website's JS call the bridge. Fix: first-run picker asks for the
   OWUI URL, saved next to the folder choice in `~/.file-bridge.json`.
   (TODO.md #1 has the full rationale.)

✅ **Bearer token auth** — defense in depth against local pages/processes
   (Firefox does not enforce PNA). Token stored 0600 (OpenWorker secrets.py
   pattern), sent by the skill as a header; **never echoed in chat/context**.
   OpenWorker independently converged on the same 8765+token design.

   **TOKEN DISTRIBUTION DESIGN (resolved 2026-08-27):** per-user random
   tokens CANNOT work — the OWUI skill is org-public static markdown, it
   can't know each user's token. Resolution: two tiers.
   - Tier 1 (default, zero-config): CORS origin lock ONLY. Browser-enforced,
     no secret in the skill. Sufficient for internal rollout.
   - Tier 2 (opt-in enterprise hardening): org-wide token set by admin
     (installer config or setup script), embedded in the skill by
     setup_owui.py, checked by bridge. Acceptable leak surface: skill is
     org-internal; the token only guards each user's OWN localhost bridge.
   If Tier 2 active AND request has no/wrong token → 401. Bridge refuses
   "production mode" (see below) only when BOTH tiers are off.

✅ **Binary read whitelist + /peek + windowed reads** — `/read` on binary
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

✅ **Write-before-overwrite snapshots + confirmation tokens** — before any
   write to an existing file, copy original to `.fb-versions/<name>.<ts>`;
   destructive ops get a two-step confirmation token (60 s validity — design
   borrowed from OWUI openapi-servers filesystem server). Makes model edits
   reversible and deliberate — trust foundation for office use.
☐ **"Production mode" hard-fail** — bridge refuses to serve with CORS `*`
   AND no token simultaneously (Open Terminal v0.11.30 refuses keyless
   start; adopt the stance). ✅ done — see items 1/2 above.

✅ Skill rule: never dump whole large files into chat; summarize + cite. (skill/local-file-bridge.skill.md updated: API table, /peek, windowing, 409 confirm flow, token header plumbing)

## P0b — Scope configuration & accident protection (enterprise-critical)

### Multi-root + ignore lists (scope control)

✅ **Multi-folder roots** — settings page supports ONE OR MORE shared folders;
   every endpoint takes a root-relative path + root id (or search across
   roots by default). Each root stores: path, alias, enabled flag.
   Pattern: OpenWorker `_resolved_roots()` (permissions.py L314) +
   WorkspaceTrustStore (workspace_trust.py) — trust per canonical path,
   atomic 0600 state writes.
✅ **Ignore/exclude list per root (and global)** — gitignore-style patterns
   (e.g. `.git/`, `node_modules/`, `*.tmp`, `secrets/`): /list omits, /read
   + /pdf_text + /ocr + future /search return 404-with-hint ("excluded by
   settings"), /write into ignored paths is refused. Enforced in the BRIDGE,
   surfaced in skill ("if excluded, tell the user to adjust settings").
✅ **Bridge self-protection floor** (OpenWorker permissions.py L93-123):
   `~/.file-bridge.json`, token file, audit db, versions dir are NEVER
   writable via any endpoint, in any mode. Prevents "one approved write
   quietly widens future permissions".

### Mass-operation damage limiting

Design stance (validated by OpenWorker source): **no delete endpoint, ever.**
Deletion only as trash-move. Writes are the remaining blast surface — guards:

✅ **Snapshots (P0 item, restated here as part of the system)** — every write
   to an existing file copies original to the versions store first;
   /versions/list + /versions/restore endpoints.
✅ **Trash instead of delete** (PROMOTED from P3) — `/delete` moves to the
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
✅ **Write-rate circuit breaker** — bridge-side quota: max K writes per
   rolling 60 s window (default 20) + max total MB written per window;
   exceeding triggers 429 with "ask user to confirm mass edit" message the
   skill relays. A runaway model hits the brake, not the folder.
✅ **Mass-edit detection** — `/write_many` requires an explicit
   `confirmed: true` second call when batch size is over 5 files (token
   pattern from openapi-servers). Skill rule: for over 5 file changes, list
   the plan first, get user OK, then batch.
✅ **Read-only mode toggle** (settings page, per root or global): disables
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

✅ `/xlsx_read?path=&sheet=&range=` → JSON: row count, headers, data grid,
   merged cells. Uses full native openpyxl (Pyodide wheel is a subset).
✅ `/docx_read?path=` → markdown-ish text preserving headings/lists/tables.
✅ `/pptx_read?path=` → per-slide title + text boxes.
   Side effect: pure-read tasks need NO wheel install → first interaction
   drops from ~3 s to ~0 s.
✅ `/html_text?path=` — strip tags via stdlib html.parser (today /read
   returns raw HTML source = tag noise per token).
✅ `/csv_head?rows=20` + `/csv_stats` (row count, columns, type sampling,
   numeric ranges) — stdlib csv; prevents whole-CSV context dumps.
✅ `/search?q=&glob=&exclude=` — cross-file grep with context lines,
   file-pattern + exclusion patterns (param design adopted from OWUI
   openapi-servers /search_content + /search_files). "Which contract
   mentions termination clause" is THE top office query.
✅ `/edit?dry_run=1` — surgical text replacements with unified-diff preview;
   on confirm applies. (Borrowed from openapi-servers /edit_file.)

## P2 — Reliability & rollout

**Sequencing (user decision 2026-08-27):** ALL Linux-side items first;
Windows/macOS build+verify is a FINAL phase done by the user personally
after Linux is complete. Frozen-binary repackaging likewise deferred to one
final validation pass (not after every change). Do not block on either.

☐ **Windows + macOS real-machine testing** — everything so far verified on
   Linux only: drive letters/backslashes, port-conflict UX, first real Inno
   Setup compile, SmartScreen/Gatekeeper flows.
☐ Inno Setup compile run on Windows (script written, never executed).
✅ **Audit log** — JSONL at `state_dir/audit.log` (from OpenWorker audit.py
   pattern): every file-touching call logs ts, endpoint, method, path, size,
   status + **secret-scrubbed args** (`_SECRET_KEYS` scrub list adopted;
   file-content keys reduced to type+length — contents never logged).
   0600, best-effort append, 5 MB simple rotation to `.log.1`. No API —
   owner-facing only (state dir is structurally outside every root, so the
   model can never read it).
✅ **Atomic writes** — /write /write_b64 /edit /write_many and
   /versions/restore now land via same-dir temp file → fsync → chmod →
   `os.replace` (crash mid-write can never leave a torn file at a real
   path; chmod happens on the temp BEFORE the rename so the mode actually
   lands). Existing-file modes are preserved across overwrites.
   Symlink defense (Linux-verified): every path component is checked with
   `is_symlink()` in resolve_any (reads AND writes refuse symlinks —
   in-root ones too), and atomic_write refuses a symlink final hop.
   Windows symlink/junction tests deferred to the user's final phase.
✅ **Log rotation; optional service/LaunchAgent installers.** Console/
   request log → `state_dir/bridge.log` when non-interactive (tee to
   stderr, size rotation to `.log.1`, default 5 MB, env
   FILE_BRIDGE_LOG_MAX_BYTES; the systemd service sets
   FILE_BRIDGE_NO_LOGFILE=1 and relies on the journal instead).
   `scripts/install_service.py` (+`--status`/`--remove`/`--exec` for
   frozen binaries): systemd user unit on Linux (VERIFIED round-trip:
   install → active → /health → remove → port freed), LaunchAgent plist
   on macOS (written, not loaded — user's final phase), Startup-folder
   .bat on Windows (write-only). FILE_BRIDGE_PORT env override added.
✅ **`/ocr_pdf`** — tesseract PDF renderer → searchable PDF (page image +
   invisible text layer; pymupdf merges per-page parts). Image and PDF
   inputs, 50-page cap, dpi 72-400, lang like /ocr. Confirm-BEFORE-OCR
   (409 token — raster+tesseract never runs unconfirmed), atomic +
   snapshotted output, source untouched, output readable by /pdf_text.
   Requires the tessdata `configs/` dir — now bundled in
   src/tessdata/configs (tesseract's 25 config files; without `pdf`
   config the renderer dies with `read_params_file: Can't open pdf`).
✅ **Content-hash cache for /pdf_text + /ocr** (OpenWorker pdf_support
   `_cached` pattern): results keyed by (sha256(file bytes), op, params) —
   in-memory, 16-entry FIFO, `"cached": true` flag on hits. Re-asks and
   history replays skip raster+tesseract entirely; any file change
   (different digest) or param change (lang/dpi/pages/max_pages) computes
   fresh. In-memory only: restart clears it, no disk state.
✅ **`/pptx_from_template` + `/docx_merge`** (openworker #454).
   docx_merge: `{{placeholder}}` fill preserving per-run formatting
   (multi-run placeholders collapsed onto run 0), body + tables +
   headers/footers, missing keys reported, `strict: true` refuses to
   write when placeholders remain. pptx_from_template: .potx/.pptx
   input, global placeholder fill + per-slide append through the
   template's own layouts (corporate design survives; fresh add_slide
   placeholders carry PROMPT text, so per-slide specs set title/body
   directly), layout-index validated BEFORE the confirmation token.
   Both need native python-docx/python-pptx (501 otherwise) and run the
   standard confirm + snapshot + rate-breaker pipeline.
✅ **`/pdf_text?mode=text|images`** — images mode rasters pages via
   pypdfium2 (scale 2.0 ≈ 144 dpi, ≤100 pages, openworker RASTER_MAX_PAGES
   pattern) with a hand-rolled stdlib PNG encoder (no Pillow on the
   bridge); pages as `png_b64`, MAX_BINARY byte budget, result cached
   like text mode. Addon env gains `--with pypdfium2`.
✅ **Sensitive-name blacklist** — bridge-side floor in resolve_any (reads
   AND writes): basename match against SENSITIVE_NAMES (.env, id_rsa*,
   authorized_keys, credentials*, secrets*, .npmrc/.netrc/.pypirc,
   serviceaccount.json…), SENSITIVE_EXTS (.pem .key .p12 .pfx .keystore
   .kdbx .env) and a broad keyword pattern (secret/token/credentials).
   Deliberately over-broad: false positive = "ask the user", false
   negative = credentials in model context. Applies regardless of
   per-root ignore lists; error tells the model to ask the user.
✅ **Version endpoint + update nudge** — GET /version (token-free like
   /health): bridge + expected skill version. VERSION bumped 2.0→2.1;
   skill markdown now starts sessions with a /version check and tells
   the user to re-run the installer/setup_owui.py on mismatch.
✅ **/zip, /unzip** (stdlib zipfile). /zip: members resolved through
   resolve_guarded individually (ignore lists + traversal apply per
   member), output written atomically + snapshotted, 8 MB cap, 200-member
   cap, flat basenames (dirs recurse). /unzip: every member name
   REJECTED if absolute/drive-letter/`..` (zip-slip aborts the whole
   extraction), 1000-entry + 8 MB caps, symlink members refused, ignore
   rules apply to extracted paths, rate-breaker counted.
☐ `/directory_tree?format=tree` (from openapi-servers). ✅ done —
   GET /directory_tree: recursive name/type/size tree, ignore-list aware,
   symlinks never listed, entry cap (default 500, max 2000) + depth cap
   (default 6, max 12) with truncated flags.
✅ **Local preview tab in settings page** (what the AI can see) — picker
   gained a "What the AI can see" panel: live directory_tree render
   (ignore-aware, symlinks never shown, XSS-escaped names, sizes + entry
   count + truncation note). Open Terminal file-browser inspiration.
   Verified in headless chromium incl. ignore-list exclusion.

## P3 — Optional / bigger bets

☐ Signing decisions per feedback matrix — SKIPPED (user decision
   2026-08-28, business call; revisit when external distribution
   demands it):
   - internal AD: internal CA or GPO whitelist (free)
   - external: Windows OV ~$100-200/yr (EV ~$400 for zero friction);
     macOS Apple Dev ID $99/yr + notarize (`package_macos.sh --sign` ready)
   - Unsigned IS installable on both (SmartScreen "more info→run anyway";
     macOS right-click→open) — docs/SUPPORT.md now covers the flows.
✅ LibreOffice headless conversion — `/convert` (984426f): _CONV_MATRIX
   whitelist (legacy .doc/.xls/.ppt → OOXML, office → pdf, xlsx → csv,
   docx → png/html); model picks a FORMAT PAIR, never a command;
   _CONV_LOCK serialization (one soffice profile), magic-byte output
   verification (soffice rc lies), 120s timeout → 504, SOFFICE_CMD env
   > adjacent > /usr/bin > PATH, 501 + install hint when absent.
   Verified live: doc→docx roundtrip, docx→pdf (LO 24.2.7.2 on dpc).
✅ Structured write endpoints: /xlsx_append, /docx_write (sections),
   /pdf_from_text (native fpdf2, no Pyodide shim) — 7d59ae9.
✅ Mail-merge: /docx_mailmerge — docx template {{placeholders}} + xlsx/
   csv/inline rows → one DOCX per row (out-name pattern or .zip bundle);
   collision + unresolved-pattern checks pre-confirm (094dace). PDF
   output = mailmerge + /convert, two deliberate steps.
✅ .eml parsing (stdlib email) — /eml_read (a74ea64); .msg → 415 with
   extract-msg hint (not bundled).
✅ PDF split/merge/rotate — `/pdf_op` (pymupdf): split to per-page
   `<base>.pN.pdf` files (page-selectable), ordered merge (2-20 inputs),
   per-page rotate (angle mod 360); overwrite-confirm flow, atomic +
   snapshotted, rate-breaker counted; verified page selection/rotation
   empirically in the addon suite.
✅ `/reveal` — opens Explorer/Finder/xdg-open at the file. CONSENT-GATED:
   403 unless the local user sets allow_reveal in the picker (default
   off) — a remote model must never pop desktop windows unasked.
✅ rclone recipe: bridge folder = cloud-drive mount (answers demand in
   OWUI #5872 data sources, 52+) — docs/RCLONE.md (recipe; flagged
   not-lab-verified — dpc has no rclone/cloud remote).
✅ `/image_info` — stdlib-only header parser: png/jpeg/gif/webp/bmp
   dimensions + format + megapixels, JPEG EXIF Orientation tag with
   effective (post-rotation) size. Verified against pymupdf/PIL-generated
   real files incl. oriented JPEG (6 → w/h swap). PIL not required.
✅ OWUI version-compat window — docs/OWUI-COMPAT.md: verified 0.11.1,
   current+one-minor policy, the two-switch preset regression test,
   skills-API surface table, per-upgrade checklist.
☐ Multi-model smoke tests (only GLM tested; weak models may need stronger
   skill rules). — attempted opportunistically after the 2.3 sync.
✅ RiskClass per endpoint (READ/WRITE_LOCAL/…) declared in code — from
   OpenWorker risk.py; future-proofs confirmation/audit gating
   (f2eb7fd: ENDPOINT_RISK table, audit rows carry risk, /state map,
   e2e fails on gaps).
✅ Skill shipped as folder w/ version + changelog; setup script previews
   diff before updating an existing skill (f58e070:
   skill/local-file-bridge/{SKILL.md,CHANGELOG.md}, setup_owui.py
   [y/N] prompt + --yes; both paths verified on owui-test).
✅ Support runbook — docs/SUPPORT.md (SmartScreen vs Defender-policy,
   port-8765 conflict triage + FILE_BRIDGE_PORT override, Safari
   private-network hard limit, first-response checklist).

## Format support matrix (current)

| Format | Read | Write | Notes |
|---|---|---|---|
| txt/md/code | ✅ /read | ✅ /write | |
| csv | ✅ /read, /csv_head, /csv_stats | ✅ | |
| html | ✅ /html_text (tags stripped) | ✅ | |
| xlsx/docx/pptx | ✅ /xlsx_read /docx_read /pptx_read | ✅ via Pyodide | |
| pdf (text layer) | ✅ /pdf_text | ✅ fpdf2 (Pyodide) | |
| pdf (scanned) | ✅ /ocr (tesseract) | ✅ /ocr_pdf (searchable) | swe+eng combo verified |
| images | ✅ /ocr, /read_b64, /image_info | ✅ /write_b64 | /reveal consent-gated |
| doc/xls/ppt (legacy) | ✅ via /convert | ✅ /convert → OOXML/pdf | LibreOffice headless; 501 + hint if absent |
| zip | ✅ /zip (create), /unzip, /peek kind=zip | ✅ /zip | flat basenames; zip-slip rejected |

## Measured performance (reference)

- Pyodide office-lib install: ~3 s once per chat session (shared worker),
  then instant. Local wheels ≈ PyPI CDN for speed; chosen for
  offline-safety + version pinning (user decision: local-only).
- tesseract OCR: ~0.5 s/page @200 dpi (RapidOCR was 2.1 s).
- Combo langs: swe+eng fixes å/ä/ö AND digits (each alone breaks one).
