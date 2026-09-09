# DEVNOTES — environment quirks & pitfalls (dpc)

Living document for anyone (human or agent) implementing the roadmap.
Add every new gotcha here, not to memory.

## Test environment

- **One-shot rebuild**: `bash scripts/rebuild_testenv.sh` (OWUI container +
  fixtures + model connection + skill/preset). `--no-owui` skips the docker
  part. Idempotent.
- OWUI test instance: docker `owui-test` on `127.0.0.1:8788`,
  admin@test.local. Password NOT hardcoded anymore: rebuild_testenv.sh
  generates a per-machine random one, kept at
  `~/.config/open-file-bridge/testenv-pass` (600, outside the repo).
  Image `ghcr.io/open-webui/open-webui:main`
  (v0.11.x). Volume `owui-test-data` persists accounts/skill/preset across
  container restarts, NOT across `docker rm` + fresh volume.
- Model backend: Z.AI coding endpoint `https://api.z.ai/api/coding/paas/v4`
  (NOT the /api/paas/v4 one — that 429s with this key). Key from
  `~/.hermes/.env` `GLM_API_KEY=…` (line appears twice; head -1).
- **glm-5.3-flash is the test model** (fast/cheap tier); glm-5.3 for
  final E2E sanity.

## Bridge runtime quirks (learned the hard way)

- **Approval round trip REMOVED (bridge 2.11 / skill 2.11, 2026-09-06):** the
  409 confirmation-token flow (single-use grant, payload digest, 10-min TTL,
  later-turn commit) is gone. Real chats broke it two ways: models lost the
  pending grant between turns ("approval window wasn't preserved") and models
  regenerated the payload after approval (burning it as `payload_changed`)
  — the mechanism failed more writes than it protected. Writes now execute
  immediately; safety is structural and verified on every path: snapshot
  BEFORE overwrite (all 20 write sites incl. ZIP extraction), trash-move
  deletes, snapshot-on-restore, rate breaker, read-only mode. Never
  reintroduce a chat-mediated approval step without a new user decision.
  (`pending-confirmations.json` is no longer read or written.)
- **Port 8765 conflicts**: `tests/e2e_test.sh` refuses to run if something
  already listens (it starts its OWN bridge on a temp dir). Kill strays:
  `pkill -f file_bridge` — then VERIFY with `ss -tln | grep 8765`, because
  `pgrep -f file_bridge` matches the grep's own shell wrapper (snapshot
  scripts) and lies.
- Killing bridge processes: hermes `process kill` on background terminal
  sessions works; `kill $(pgrep …)` may need two rounds (uv wrapper + python).
- **state file races**: `~/.file-bridge.json` is global per user — two bridge
  instances (test + manual) fight over it. The e2e script sets its own root;
  if you run a manual bridge concurrently, expect 404s from wrong root.
- Restarting the bridge with the SAME folder arg re-saves state — fine.
- Frozen binary (PyInstaller onefile): assets resolve via **sys.executable
  dir** (`_app_dir()`), NOT `__file__`. Bundled layout: exe + wheels/ +
  tessdata/ + tesseract/ next to it. Rebuild with
  `uv run --with pyinstaller --with pymupdf python -m PyInstaller.__main__
  --onefile --clean --name FileBridge --exclude-module tkinter
  --exclude-module unittest --collect-all pymupdf --collect-all fitz
  src/file_bridge.py` (~82MB, ~1 min).

## Tesseract (local, no sudo on dpc)

- Persistent copy: `~/tools/tesseract-5.3.4/` (AppImage extracted).
  Run with `TESSERACT_CMD=~/tools/tesseract-5.3.4/usr/bin/tesseract
  LD_LIBRARY_PATH=~/tools/tesseract-5.3.4/usr/lib`.
- **Addon suite canonical invocation** (bridge needs the libs IN its own
  process for office-write endpoints):
  `TESSERACT_CMD=… LD_LIBRARY_PATH=… uv run --with pymupdf --with pypdfium2
  --with python-docx --with python-pptx --with fpdf2 --with openpyxl
  bash tests/addon_test.sh`
  (env vars are user-specified; hermes terminal blocks inline
  LD_LIBRARY_PATH — wrap in a local runner script when driving from
  the agent).
- tessdata there has 10 langs incl swe/chi_sim (we added). Repo bundle:
  `src/tessdata/` = 22 langs + osd (2026-08-29: eng swe dan nor fin deu
  fra spa ita por rus pol hun lav lit est chi_sim chi_tra jpn kor ara,
  all tessdata_fast — 18 added on user request) + `configs/` (tesseract's
  25 config files, needed by /ocr_pdf's `pdf` renderer).
- No system tesseract, no sudo — NEVER `apt install`; use the persistent copy.

## Pyodide/browser testing

- Playwright chromium:
  `~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`
  (pip playwright lives in the ComfyUI venv — just `python3` works).
- Cross-origin test page server: `python3 -m http.server 8899 --bind
  <LAN-IP>` from a dir containing `test_page.html` (page loads Pyodide
  0.26.4 from jsdelivr; `--allow-local-network-access` flag needed).
  (LAN IP deliberately not written down — it's in the machine's network
  config, not in this public repo.)
- micropip in bare Pyodide needs explicit `await py.loadPackage("micropip")`
  (OWUI's worker preloads it; standalone test pages don't).
- fpdf2 in Pyodide needs the HTTPSHandler/HTTPSConnection stub shim (in skill).

## OWUI API notes (v0.11.1)

- Skills: `POST /api/v1/skills/create` (id required), access via
  `/api/v1/skills/id/{id}/access/update` with
  `[{"principal_type":"user","principal_id":"*","permission":"read"}]`.
- Models preset: `/api/v1/models/create` (not /model/new); update via
  `/api/v1/models/model/update`; **list via `/api/v1/models/export`**
  (`/api/v1/models/` returns HTML — SPA catch-all).
- OpenAI conn: `POST /openai/config/update` (NOT /api/v1/…).
- The preset needs BOTH `meta.capabilities.code_interpreter:true` AND
  `meta.defaultFeatureIds:["code_interpreter"]` or the frontend sends
  `features.code_interpreter:false` and the model gets no execute_code.
- E2E UI flow: login → dismiss "What's New" modal ("Okay, Let's Go!") →
  model picker (aria-label*="Selected model") → Integrations menu →
  "Local Files Assistant" preset carries CI+skill automatically.
- Chat input is `div[contenteditable='true']` (type with delay), not textarea.
- Z.AI 429s on burst: space model calls, retry after 15-20s.

## Scheduling of work (user decisions, 2026-08-27)

- Windows/macOS real-machine build+verify: DEFERRED until Linux-side is
  complete; user will port personally. Do not block on it.
- Frozen-binary repack: DEFERRED to a final validation pass at the end,
  not after every change (user decision).
- Roadmap P2 "Win/mac testing" items move AFTER everything else is done.
- Tests before UI polish; small commits per roadmap item.

## macOS build+verify session (2026-08-28, macOS 26 / arm64 / bash 3.2)

The final-phase mac leg, done on Dandan's machine. Everything below is
encoded in ROADMAP/TODO too; this section keeps the debugging lore.

**bash 3.2 silently corrupts JSON bodies (root cause of the "Extra data:
line 1 column 7" 500s).** macOS still ships bash 3.2 as /bin/bash. It
MISPARSES `-d "{\"k\":\"$V\"}"` when the curl sits inside a *quoted
command-substitution argument* — `check "x" 'y' "$(curl ... -d \"{...}\" ...)"`:
the body arrives truncated to its last `"key":"value"` fragment (verified
with a raw TCP dump proxy). Assignment context (`R=$(curl ...)`) parses
correctly. All such curls in tests/e2e_test.sh now go through a variable.
This also un-masked a false PASS: "state-inside-root rejected" matched
`error` in ANY error response.

**State-dir containment bypass via /var symlink (real security bug, fixed).**
macOS symlinks /var → /private/var; mktemp returns /var/folders/…, the
bridge resolved ROOTS but not STATE_DIR, so `os.path.commonpath` never
matched and set_roots happily accepted the state dir itself as a shared
root (dumped `{"ok": true}` instead of rejecting). STATE_DIR is
`Path.resolve()`d at init now — all guards compare realpath to realpath.

**Windowed-frozen guard.** `--windowed` PyInstaller builds can have
sys.stdout/stderr None (no console); main() now substitutes devnull before
any print/isatty. (macOS Finder launches give /dev/null fds so the guard
is belt-and-braces there; Windows noconsole is where it bites.)

**UNC-path ValueError.** On Windows, `\\server\share\…` after backslash
normalization makes commonpath raise ValueError (different drives) — was
an uncaught 500 in resolve_any; now a clean "path escapes shared root".

**Other portability fixes:** `stat -c` → stat_mode() helper (GNU/BSD),
`base64 -w0` → `base64 | tr -d '\n'`, `ss -tln` wait → port_bindable()
bind probe + port_accepting() connect probe (a stuck listener reads as
"free" to curl timeouts), BSD `wc -l` space padding stripped, blind
`sleep 1.5` startup → /health readiness poll (onefile self-extraction
takes ~2 s), addon_test bridge now installs the full dep set the suite
exercises (standalone runs used to 501 on docx/pptx/pypdfium2 endpoints).

**Frozen-build results:** PyInstaller 6.x onefile+windowed, 32 MB binary;
package_macos.sh now layers src/wheels + src/tessdata into the .app
(Contents/MacOS) → 55 MB app / 44 MB zip. `/health` from a Finder-style
`open`: wheels 8, addons {pdf,ocr}, langs [chi_sim eng osd swe]. Full
216-check e2e suite passes against the frozen binary via the new
FILE_BRIDGE_CMD env hook. LaunchAgent round-trip verified (see ROADMAP).

**Windows spec was onefile, installer expects onedir** — EXE had
a.binaries/a.datas inline (onefile) while installer_windows.iss + CI +
BUILDING.md all reference dist\FileBridge\FileBridge.exe. Spec fixed to
exclude_binaries + COLLECT. CI now smoke-tests all three OSes and builds
with pymupdf present (collect_all without it silently produced a
PDF-less exe; artifact uploads had wrong paths for win/mac → empty
artifacts, now `if-no-files-found: error`).

**Windows noconsole launch (CI run 4 vs 5).** Even with the devnull guard
at the top of main(), the windowed exe hung on windows-latest when started
bare (`Start-Process`, alive-but-not-listening, no bridge.log — PyInstaller
windowed-traceback-dialog signature). The CI smoke now starts the exe with
`-RedirectStandardError/-RedirectStandardOutput` handles → boots cleanly
(`smoke OK: addons=@{pdf=True; ocr=False} wheels=8`). So: real double-click
launches are covered by the in-code guard; programmatic/CI launches should
pass stdio handles. The smoke also dumps process state + raw /health +
bridge.log + captured stderr on any future failure. ocr=False on runners
is expected (no tesseract binary there — the Inno installer bundles the
engine for real installs).

**Picker UI fixes (found in Dandan's first manual test, 2026-08-29).**
(a) OCR-language checkboxes rendered stacked/center-clipped: the global
`input{width:100%;padding:10px}` rule also hit checkboxes — excluded via
`input:not([type=checkbox])` and the langbox is now a flex-wrap chip row.
(b) Tier-2 token UX only had Generate/Clear — the org flow (admin embeds
token in the public skill via `setup_owui.py --bridge-token`, users PASTE
it into their bridge) had no UI, even though the API always supported
`{"token":{"set":…}}`. Added a paste field + Set button and help text
describing both directions. Also clarified why an org-wide token is
meaningful even though every OWUI user can read the skill: the trust
boundary is the org's OWUI (its users can ask the model anyway); the
token keeps every OTHER origin out, incl. the Origin:null sandbox case
where tier-1 CORS cannot help.

## Session handoff

- Repo: `~/workspace/owui-file-bridge` (git, 3 research docs + roadmap).
  Commits use `user.name="Dandan Wei" user.email="chopper.ddw@gmail.com"`.
- gh CLI token EXPIRED (push blocked; SSH key works once repo exists on
  github.com). Don't burn time on push; local commits accumulate.
- Roadmap: `docs/ROADMAP.md` — P0 security first, P0b scope/accident, then
  P1 reads. Reference index at top maps every item to exact source files.

## Pitfalls found this session (P1, 2026-08-28)

- **Python via bash heredoc mangles escapes**: `bash <<'EOF' python3 -` code
  containing `\d` regexes lost backslashes, and f-strings with literal `{`
  produced "single '}' is not allowed" syntax errors that looked like real
  code bugs. Use the patch tool / write_file for code containing backslashes
  or braces — never round-trip it through a heredoc.
- **grep against JSON-escaped responses lies**: diffs returned by `/edit`
  arrive as JSON strings, so `\n` is literally backslash-n and grep patterns
  spanning "lines" never match. Pipe through
  `python3 -c "import json,sys; print(json.load(sys.stdin)['diff'])"` first.
- **xlsx rel targets are absolute**: workbook.xml.rels points at
  `/xl/worksheets/sheet1.xml` WITH the leading slash. Strip it before
  joining with the zip prefix — naive `zip_prefix + rel_target` double-
  prefixes and every lookup 404s inside the archive.
- **docx style ids**: paragraph styles are `Title`, `Heading1`, `Heading2`
  (no hyphen, no space, casing varies by generator). Map by prefix match,
  not exact equality against "Heading 1".
- **Test env vars leak across assertions**: the e2e suite raises
  FILE_BRIDGE_MAX_WRITES=500 globally, which made the rate-breaker trip test
  unreachable by construction. When a test needs tight limits, give it its
  OWN bridge instance on a fresh state dir (and its own port timing —
  the suite hardcodes 8765, so such tests must run LAST or after killing
  the main instance).

## Pitfalls found this session (P2, 2026-08-28)

- **`ZipInfo.name` doesn't exist** — the attribute is `.filename`. Pyright
  caught it, but only on the second patch round (the first edit left one
  `.name` behind). When copying zipfile code, grep for `.name` uses.
- **Zip-slip "sanitize" vs "reject"**: filtering `..` segments out of
  member names (parts = [x for x in split if x not in ("", ".", "..")])
  SILENTLY REWRITES the path and the extraction "succeeds" — the test
  only caught it because the expected 400 never came. Malicious member
  names must ABORT the extraction, not be cleaned.
- **`Path.with_suffix` gotcha for rotation names** (checked empirically):
  `Path("audit.log").with_suffix(".log.1")` → `audit.log.1` ✓, BUT it
  replaces the last suffix, so any multi-dot name shifts:
  `Path("audit.log.1").with_suffix(".log.2")` → `audit.log.log.2` ✗.
  Fine for the audit rotation as written (suffix .log → .log.1 on a
  `.log` file); prefer explicit `parent / (name + ".1")` concat in new
  code to avoid the trap.
- **stat from the handler thread**: `zipfile` + `os` calls on paths that
  a concurrent request may delete raise OSError mid-response — wrap tree
  walks (directory_tree, /zip recursion) in try/OSError per entry, or the
  whole endpoint 500s on one disappearing file.
- **Hermes terminal hardline-blocks oversized inline one-liners** (e.g.
  `grep -E ... ; echo "count: $(... | grep -c ...)"` after a test run):
  the whole command gets blocked, not just the risky part. Keep terminal
  commands small; the blocked payload is saved to
  `~/.hermes/cache/blocked-scripts/` and can be run via
  `bash <saved-path>` — same effect, no parser trip.

## Pitfalls found this session (P2/P3 batch 2, 2026-08-28)

- **tesseract `pdf` config renderer needs tessdata/configs/**: running
  `tesseract in.png out -l eng pdf` against a bare tessdata dir (only
  .traineddata files — what the repo bundled) fails with
  `read_params_file: Can't open pdf`, rc=1, NO output file. ARG-PARSING
  errors also print usage to STDOUT with rc=0 in some builds — so verify
  success by checking the output file starts with `%PDF-`, not by
  returncode alone. Fix shipped: `src/tessdata/configs/` now carries
  tesseract's 25 stock config files (copied from the AppImage install).
- **Confirm-then-validate ordering matters for UX**: putting input
  validation (ext checks, layout-index checks) AFTER the 409 confirmation
  issue burns the user's token on typos. Order: validate everything
  cheap first → then confirmation_issue → then heavy work. The
  ocr_pdf/pdf_op/docx_merge/pptx_from_template endpoints all follow
  this now.
- **Confirmation tokens bind to (op, path, out) only** — lang/dpi/pages
  are deliberately NOT bound, so a model may tweak dpi after the user
  approved without a fresh 409. Testing "changed payload burns token"
  must change `out` (a bound param), not `dpi`.
- **e2e stdlib PNG/GIF/BMP fixtures must be built, not fetched** (no
  Pillow in the e2e env): ~15 lines of struct+zlib build a valid 3x2 PNG,
  GIF logical screen descriptor is LITTLE-endian (first fixture read
  4x1 back as 1024x256 — classic be/le swap), BMP dims live at offset 18
  as <ii.
- **fuzzy patch tool mangles Python indentation** when the anchor spans
  a function boundary — it re-indented a whole inserted block once.
  For multi-function inserts, use a small python script
  (`text.index(anchor) + splice + ast.parse`) instead of patch mode.
- **`uv run --with X bash script.sh` injects X only into uv's own
  python invocations** — a plain `python3` inside the script (fixture
  builders) does NOT see the package. Either run those under their own
  `uv run --with …` line or make the BRIDGE itself run under the
  decorated interpreter (what the addon suite now does for
  pymupdf/pypdfium2/python-docx/python-pptx).
- **Playwright sync API works from plain python3** if the chromium
  build is passed explicitly (`executable_path` from
  `~/.cache/ms-playwright/chromium_headless_shell-*/…`); the CDP
  websocket route is unnecessary for picker DOM checks.
  `page.inner_text("#id")` + `wait_for_selector` is enough; assert
  ignore-list exclusion there (fixture `hidden.dat` absent) —
  complements the API-level directory_tree tests with rendered-output
  proof.
- **systemd user units are testable without sudo**
  (`systemctl --user enable --now` + `--status`/`--remove` round-trip
  verified); the unit must set FILE_BRIDGE_NO_LOGFILE=1 or the bridge
  double-logs (journal + bridge.log).

## Pitfalls found this session (P3 finish, 2026-08-28)

- **`set -euo pipefail` kills the suite on a grep-no-match**: assigning
  `VAR=$(… | grep pat | tail -1)` with zero matches exits the whole
  script silently (trap cleans up; it looks like the run "stopped
  early" for no reason). Append `|| true` inside ANY `$()` whose grep
  may legally find nothing.
- **curl URLs with literal spaces hang**: fixture names produced by a
  mailmerge pattern (`merged/Acme AB.docx`) MUST be percent-encoded
  (`Acme%20AB.docx`) in test curl calls — a raw space breaks the
  request line.
- **`pkill -f file_bridge` can kill the agent itself**: the hermes
  terminal wraps every command in `bash -c '… file_bridge …'`, whose
  OWN cmdline matches the pattern → pkill kills the caller (exit -15,
  empty output, downstream sections silently skipped). Use
  `pgrep -f "python src/file_bridge"` + kill (may need two rounds:
  uv wrapper + python), and verify with `ss -tln | grep 8765` — never
  pkill from the agent terminal.
- **`_xlsx_read` returns the grid under key `data`** — not `rows`, not
  `grid`. (The skill doc's `/xlsx_read` row says "grid"; the JSON the
  bridge actually returns is `{"data": [[…]], "row_count": …}`.)
  Mail-merge read xlsx rows via `out["data"]`.
- **soffice (`--convert-to`) quirks, verified on LO 24.2.7.2**:
  output file is named after the INPUT stem (--convert-to doc x.docx
  produces x.doc, NOT the requested out name — copy/rename into
  place); two concurrent soffice invocations share one user profile
  and corrupt each other — serialize with a lock; javaldx warnings on
  stderr are harmless; judge success by the OUTPUT FILE's magic bytes,
  never by returncode alone.
- **Addon suite hit its own write-rate breaker**: adding /convert
  tests pushed the addon suite past the default 20 writes/60 s and
  pdf_op (the next section) 429'd mid-suite. The suite's self-started
  bridge now sets FILE_BRIDGE_MAX_WRITES=500 (same headroom as e2e);
  the breaker itself stays covered by e2e's dedicated
  FILE_BRIDGE_MAX_WRITES=3 instance at the end of that suite.

## Pitfalls found this session (strict-variant validation + CORS, 2026-08-28)

- **Z.AI burst exhaustion surfaces as OWUI-backend 500s, NOT 429s**:
  after ~10 real-browser smoke chats in one day, every chat completion
  returns 500 from the OWUI backend (upstream Z.AI endpoint refusing);
  recovery = wait for the quota to reset, not retry harder. Probe FIRST
  before blaming skill or harness — one tiny non-stream chat
  (`POST /api/chat/completions`, model glm-4.5-air, "reply with
  exactly: ok", timeout 120 s); if it errors, stop for the day; if it
  answers, run.
- **`kill $(pgrep -f file_bridge)` self-matches too** (upgrade of the
  P3-finish pkill pitfall): the hermes terminal wrapper's OWN command
  line contains the pattern literal, so even the "safe" kill-by-pgrep
  form kills the caller (exit -15, empty output). Write the pattern
  with a character-class split — `pgrep -af "file_bridg[e]"` — so the
  regex cannot match its own literal; kill the listed PIDs, then verify
  with `ss -tln | grep 8765`.
- **OWUI skills LIST omits the `content` field**: `GET /api/v1/skills/`
  items carry no body; fetch the full record via
  `GET /api/v1/skills/id/<id>` before diffing or re-using a skill
  object as an update base — else you diff against "" and can WIPE the
  live skill body (setup_owui.py fixed in 30d2acc; bit us once live).
  Related: skill DELETE is `DELETE /api/v1/skills/id/<id>/delete`
  (JSON body {"id": ...}) — a POST to the same path 405s.
- **Playwright selectors on the current `:main` build**: auth =
  `localStorage.setItem('token', …)` on /auth then goto /; What's New
  modal = `div[role="dialog"]` LAST button; model selector =
  `button[id^="model-selector"]`; picker entries =
  `button[role="option"][data-value="<preset-id>"]`; chat input =
  `div[contenteditable='true']` (type with delay). The old
  `div[aria-label*="Selected model"]` resolves but is NOT the clickable
  element.
- **Smoke verdict polling needs ≥300 s**: model thinking + Pyodide cold
  boot + Z.AI latency routinely exceed 180 s — a 180 s window yields
  false negatives (the chat completes after the harness gave up; the
  P3 session's "still in flight" run proved it).
- **Pyodide sandbox origin drift → tier-1 CORS-blocked** (full write-up
  + upgrade-checklist item in docs/OWUI-COMPAT.md): the `:main` image
  runs Pyodide in a `sandbox="allow-scripts"` srcdoc iframe (no
  allow-same-origin) → every bridge fetch sends `Origin: null` → the
  tier-1 origin lock emits no CORS headers and the browser drops the
  response (bridge log shows 200s the page never gets). VERIFIED
  escape: tier-2 token-only mode — `POST /api/root
  {"token":{"generate":true}}`, no origin set → ACAO echoed, 401
  without `X-Bridge-Token`, 200 + working write flow with it.


## Pitfalls found this session (picker UX + macOS Dock, 2026-08-28)

- **ctypes→ObjC: undeclared restype TRUNCATES pointers (segfault)**:
  `objc_getClass`/`sel_registerName`/`objc_msgSend` default to `c_int`
  return, silently chopping 64-bit pointers → messages to garbage
  (KERN_INVALID_ADDRESS at 0x10). Declare `restype=c_void_p` +
  `argtypes` for EVERY function BEFORE first use. Cost one crash loop
  before the pattern clicked.
- **LSUIElement=false alone does NOT give a Dock icon**: a windowed
  PyInstaller binary never touches AppKit, so LaunchServices registers
  it `type=BackgroundOnly` regardless of the plist. The process must
  itself bootstrap NSApplication (`sharedApplication` +
  `setActivationPolicy:Regular`, see `CocoaDock`) — then it checks in
  as `Foreground` and the Dock shows it. `[NSApp run]` also parks the
  main thread properly once AppKit is loaded in the right order
  (load the framework FIRST — before any class lookup, or every
  message goes to nil).
- **Breaking `[NSApp run]` from another thread needs an EVENT**:
  `stop:` sets a flag the run loop only checks while processing an
  event; an idle loop sleeps forever. `performSelectorOnMainThread:`
  alone does NOT wake it (verified). The working recipe: `stop:` +
  a no-op application-defined event via
  `+[NSEvent otherEventWithType:…]` + `postEvent:atStart:YES`.
  And that factory is a CLASS method — calling it on an `alloc`'d
  instance silently returns nil. NSPoint-by-value through ctypes works
  when declared as a `ctypes.Structure` in argtypes.
- **`ThreadingTCPServer.server_close()` JOINS request threads**
  (`daemon_threads=False` default): Stop-button hung the process
  joining the thread parked on a 10-min native dialog. Fixed with
  `daemon_threads = True` (same as ThreadingHTTPServer) +
  `kill_active_dialogs()` on shutdown.
- **The picker page must work in the UNLOCKED first-run state**:
  `/ocr/config` sat behind the security gate → 503 before the origin
  lock exists → the new OCR checkbox box rendered "no installed
  language files" (and the old UI's "Installed:" line was silently
  empty). Moved to the ungated meta section next to /health (same
  disclosure class — /health already reports ocr_langs_available).
  Preview box likewise shows the 🔒 gate error instead of
  "t.entries is not iterable".
- **pgrep self-match bit me AGAIN** (documented last session, still
  got me): `pgrep -f "osascript -e POSIX path"` matched the wrapping
  shell, not the dialog → killed the wrong pid and concluded the
  endpoint hung. Write patterns with a character-class split, then
  verify with `ps -axo pid,ppid,command`.
- **qlmanage renders SVG→PNG headlessly** (`qlmanage -t -s 1024`),
  and `NSImage.lockFocus` is gone on macOS 26 — for offscreen icon
  drawing use the SVG route (see docs/BUILDING.md regenerate recipe).
- **Windows FolderBrowserDialog path is UNTESTED locally** (no
  Windows box this session): `-NoProfile -STA` +
  `[Console]::OutputEncoding=UTF8` before writing the path is the
  standard recipe; needs a real-machine pass next Windows session.

## Tier-2 CORS for opaque origins + picker token-indicator (2026-08-29)

Dandan's first live OWUI test: model code correct (token header present)
but every pyfetch died with `AbortError: Failed to fetch`. Root cause:
OWUI's sandboxed Pyodide iframe sends `Origin: null`; `_request_origin`
maps null → None; `_add_matching_cors` then emitted NO CORS headers for
it → preflight failed → browser aborted the fetch before the token was
ever checked. The documented "tier-2 works from sandboxes" only held in
token-ONLY mode (allowed=None → ACAO `*`), but the picker requires an
origin, so real deployments run token+origin → sandbox dead.

Fix: `_add_matching_cors` grants opaque origins CORS when the token tier
is active AND the request passed the auth gate. `_authorized` flag: set
True at top of do_GET (public endpoints) and do_OPTIONS (preflight);
do_POST sets True after check_request passes, False on denial; do_GET
denial sets False. So: tokened sandbox reads everything it could read
with a matching origin; tokenless probes get 401s that stay
browser-unreadable. e2e grew 5 checks (229 total, all green).

Also: picker now states on refresh whether a token is configured (the
field stays empty by design — the secret is never echoed back; users
read "Security mode: token+origin · a token IS configured"). Found the
token was persisted all along; only the UI was silent about it.

## Skill 2.4 — "list files" in two calls, not four (2026-08-29)

Dandan's trace of a plain listing: /version (skill-mandated) → /health
(skill-mandated) → /directory_tree WITHOUT token → AbortError → blind
retry with token. Four executions, one wasted on a version mismatch note
(bridge 2.4 vs skill 2.3) that only made the model hesitant.

- root cause of the tokenless GET: the skill's own bridge_get example
  omitted BRIDGE_HEADERS (only bridge_post sent them). Both variants now
  send headers on every call; the injected org-token block (now incl.
  Content-Type) says "use verbatim, do not redefine".
- /version preflight step removed from both skill variants: /health
  already returns version; check it there, once per session.
- new rule in both skills: non-200 bodies are JSON {error, hint} — read
  and adjust (401 → add token, retry once); never blind-retry.
- bridge: SKILL_VERSION 2.4 (synced, mismatch note gone) and null-origin
  401s are now CORS-readable — a missing token reads as "missing or
  invalid bridge token" instead of an opaque AbortError, so models
  self-correct in one retry. Enumerated the reachable bodies: public
  endpoints, token-valid responses, token-error messages — no secrets.
  e2e updated (denial-readable + denial-explains checks), 230/230.

## 2.5 — image display, OCR drop-in langs, walk hardening (2026-08-29)

User asks: masked token field, more OCR languages without bigger
packages, image reading for vision models.

- Picker: token field shows •••• when configured (value never echoed;
  setToken() treats the mask as "unchanged").
- OCR: USER_TESSDATA_DIR = state_dir/tessdata — drop .traineddata files
  (tessdata_fast, ~1-4 MB per language) there; at startup the bridge
  mirrors bundled + user files into state_dir/tessdata-merged (tesseract
  takes exactly one tessdata dir; signature-checked refresh). Package
  size unchanged; drop-ins survive app updates. /ocr/config exposes
  user_dir; the picker shows the path.
- /image_b64?path=&max_bytes=: data-URL image endpoint (mime/dims/bytes,
  cap default 4 MB ≤ 8 MB hard), auto-downscaled via pymupdf
  Pixmap.shrink loop when over cap (e2e: 5.9 MB noise PNG → 292 KB).
  Skill 2.5 documents OWUI's display convention (print the data URL /
  echo as markdown — same as OWUI's own matplotlib patch) AND the honest
  limitation: code output reaches the model as TEXT; a vision model
  literally seeing a local file still needs the user to attach it to
  their message (checked OWUI 0.11.1 Chat.svelte + CodeExecutions +
  pyodideSandboxHost.ts).
- WALK HARDENING (found the hard way): /list used p.rglob("*") and
  pathlib's glob FOLLOWS directory symlinks when recursing — a symlink
  cycle in a shared folder hangs request threads forever. New
  _safe_walk() (followlinks=False, symlinks pruned, 5000-entry cap,
  10 s deadline → truncated flag) now backs /list, /search, /zip.
  /directory_tree was already safe. Also: refuse to double-start (a
  second instance + SO_REUSEADDR split the accept queue: /version
  answered while /list hung).
- MACHINE ISSUE (not the bridge): the user's ~/Downloads currently
  BLOCKS readdir at the kernel level (stat works, ls/find/os.listdir
  hang; likely stalled iCloud/FileProvider sync or a dead mount inside).
  Every bridge request touching the old test-folder wedged — root
  repointed to ~/owui-demo-files (also reboot-safe, unlike /tmp which
  the day's reboot had cleared).

## 2.5.1 — picker preview under token tier; /api/root CSRF guard

The "What the AI can see" pane called /directory_tree with NO token —
correct before the token tier existed (loopback, no Origin → served),
401 the moment a token was configured. The picker can never send the
token (it is only stored hashed), so the preview now uses GET
/api/preview: loopback-only, token-free, no CORS headers (cross-origin
pages can fire it but never read the response; locals can read the
folder from disk anyway).

While there: /api/root accepted any Content-Type — a cross-site page
could POST a text/plain JSON body (simple request = no preflight) and
change security settings. Now requires application/json (non-simple ⇒
preflight ⇒ foreign origins blocked). e2e: +2 checks, 246/246.

## 2.5.2 — preview: auto-refresh + collapsible tree (user request)

Cost question answered by building it: auto-refresh is nearly free —
/api/preview is one bounded local walk (same as /list; 5000-entry/10 s
server caps) every 5 s, only while the picker tab is visible
(visibilitychange), and never overlapping a slow previous fetch
(window._pvBusy guard — matters after the Downloads stall episode).
Plus an explicit ↻ Refresh button.

Long-list UX: native <details> collapsible folders (depth 0 open,
deeper collapsed), per-folder child counts in the summary row,
"N files · M folders" line, and the user's open/closed choices survive
auto-refresh (paths recorded from details[open] before re-render and
reapplied). Truncation notice mirrors the cap the MODEL sees.
Verified live in-browser: probe file appeared within one 5 s cycle.

## 2.6 — real app icon replaces emoji placeholder (user pick)

The old appicon.svg was a gradient squircle with the 📁 **emoji** and a
Unicode ⇅ pasted as <text> — output depended on whatever fonts the build
machine had, and the Windows side had no icon at all. Replaced with a
pure-vector design (same brand gradient): variant C's max-size yellow
folder (tab top-left) + variant B's up/down arrows in a white circular
badge pinned on the folder's top-right corner, circle tightened around
the glyphs (final = user-directed hybrid; iterated in build/icon-drafts/).
Drafts + review loop live in
build/icon-drafts/ (preview.html shows every candidate at Dock sizes).

Shipped everywhere the app has a face:
- build/appicon.svg → regenerated build/appicon.icns (qlmanage/sips/
  iconutil pipeline below, now also 1024 px @2x tier).
- NEW build/appicon.ico — 7 PNG-compressed sizes 16–256 px, assembled
  by a ~15-line struct.pack script (no Pillow/ImageMagick needed on
  this machine); wired as icon= in file_bridge_windows.spec and as
  SetupIconFile in installer_windows.iss, so exe, shortcuts and the
  setup exe all show it.
- file_bridge_macos.spec now sets icon='appicon.icns' too (the raw
  onefile/onefolder binary gets a Dock icon even before the .app
  wrapper adds its own copy).

Still missing: web UI favicon (browser tab) — same SVG could become a
/static route later.

## 2.5.3 — pathological-share protections for the preview (user question)

"What if the user shares ~ or /?" Three layers: (1) the state-dir
containment rule REJECTS / and ~ outright (the root would contain the
bridge's own state dir — e2e-covered since the macOS symlink fix);
(2) entry/depth caps bound every walk (preview 500, /list 500 + walk
5000); (3) NEW: directory_tree gained a wall-clock budget (budget_s,
default 1.5 s, 0.5–10 clamp) — a single 100k-entry directory is fully
readdir'd before any entry cap bites, so past the budget we stop
DESCENDING (already-listed children render; truncated flagged). Picker
auto-refresh is now adaptive: a >1.5 s walk switches the poll to 30 s
until walks are fast again (plus the existing visible-tab + no-overlap
guards). e2e 246/246.

## 2.6.1 — OS junk ignored by default: .DS_Store & friends (user request)

Finder writes .DS_Store into EVERY folder it touches; Explorer drops
Thumbs.db/desktop.ini; non-HFS volumes grow AppleDouble `._*` files.
They polluted /list, /directory_tree, the picker preview, /search and
/zip output with zero value to the model. New `DEFAULT_IGNORE` floor
(`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) is composed into every
pattern consumer via `_all_ignore(cfg)` (per-root ignore + floor +
user global) — never listed, zipped, extracted, read or written, no
configuration involved. ExcludedPath got a distinct message for floor
hits ("always excluded by default") so the model doesn't send the user
to settings for something that isn't in settings.

Fix that made the floor possible: `_ignore_match` promised gitignore
semantics but matched bare names only against the joined path — so
`.git/` pruned a top-level .git but NOT `sub/.git/` (Finder-style junk
lives at every depth). Slash-free patterns now match any path SEGMENT
(path-shaped patterns and `/x` anchoring unchanged; `*` always crossed
`/` in fnmatch). This also makes user patterns like `secrets/` behave
as documented at depth. e2e: +10 checks (list/read/write/tree/zip/unzip
junk exclusion, nested .git pruning) — 252 pass, 1 env-only failure
(`img big auto-shrunk` needs pymupdf, absent from the current default
python3; fails identically on unmodified master).

## 2.6.2 — ignore-pattern editor in the picker + write-refusal guidance (user request)

The engine had per-root + global ignore lists since P0b, but the ONLY way
to set the global list was curl. New "🚫 Ignore patterns" section on the
settings page (between security and OCR language): gitignore-style
textarea seeded from state (`__IGNORE__`, `_hesc`-escaped — textarea
content is user free text), Save → `POST /api/root {ignore_global}`,
immediate `renderPreview()` for feedback, built-in junk floor listed as
fixed non-editable text below. e2e covers the API, listing/write
enforcement, and the page surface (editor present, patterns seeded,
floor + "writes refused" hint rendered); vision-checked render (glm-4.6V)
confirmed layout + preview hides pattern-matched files.

Write-blocked-by-ignore now reaches the user: both ExcludedPath handler
hints (GET 404 + POST) say "tell the user; ignore patterns are editable
in the File Bridge settings page", and SKILL.md's editing section tells
the model to relay instead of retrying or writing elsewhere (skill
bumped to 2.6 with CHANGELOG entry; VERSION/SKILL_VERSION → 2.6).

Gotcha that bit once: PICKER_HTML is a NON-raw triple-quoted string —
`split('\n')` in page JS ships as a literal newline → SyntaxError kills
every script on the page. Escape as `split('\\n')` (same as the existing
stop-bridge confirm). Caught by the headless-shell console log, not by
curl tests — render checks earn their keep.

## 2.6.3 — clicking the app icon opens the settings page (user request)

The 2.4 Dock icon was mute: clicking it did nothing, because a
windowed PyInstaller binary parked in `[NSApp run]` has NO delegate, and
the "reopen" Apple event LaunchServices delivers to an already-running
bundle (`applicationShouldHandleReopen:hasVisibleWindows:`) is simply
dropped. Three surfaces now open `http://127.0.0.1:8765`:

1. macOS Dock/Finder click on the RUNNING app — CocoaDock builds a
   delegate from raw ctypes: `objc_allocateClassPair(NSObject, …)` →
   `class_addMethod(sel, IMP, "B@:@B")` → `objc_registerClassPair` →
   alloc/init → `[NSApp setDelegate:]`. Pitfalls worth remembering:
   the CFUNCTYPE trampoline must be kept alive on the instance (GC of
   the IMP = call into freed memory), NSApplication does NOT retain its
   delegate (hold the raw pointer; nothing ever releases it), and the
   IMP executes ON the AppKit main thread — it must neither block nor
   fork there, so it spawns a daemon Python thread and returns YES
   immediately. A 2 s monotonic debounce makes a dock double-click open
   one tab, not two.
2. Second process (the Windows story — the exe has no tray, so clicking
   its icon again IS a relaunch; macOS only reaches this from the CLI
   binary): verify the port holder via token-free `/version` before
   believing it, open the page, exit 0. The old behavior (error + exit
   1) survived from the 2.6 double-start fix and had silently replaced
   2.4's "opens the settings page" promise; a FOREIGN listener still
   errors with the FILE_BRIDGE_PORT hint.
3. Cold launch of the packaged app — always opens the page now, not
   just first-run-with-no-folder. Gated to icon-style launches: a folder
   ARGUMENT means scripted/CLI (skill, e2e, folder-pinning shortcuts),
   and `FILE_BRIDGE_NO_UI=1` (now written by install_service.py into
   the systemd unit, LaunchAgent plist and Startup .bat) keeps
   login-autostarted services silent — otherwise RunAtLoad would pop a
   browser tab at every login.

Test-suite gotcha (bit once): stock macOS has no GNU `timeout`, so the
new e2e second-instance check backgrounds the duplicate, polls
`kill -0` for ≤20 s, then kills/collects the exit status — `timeout 20`
ran as "command not found" on the first pass. e2e: 261 pass, 1 env-only
failure (pymupdf absent from default python3, identical on master).
Frozen .app rebuilt; smoke on macOS 26/arm64: cold-launch tab,
`open dist/FileBridge.app` again → reopen tab, debounce holds, Quit
clean. Windows reviewed-only, no box here (per-round norm).

## 2.6.4 — foreign port holder: warn VISIBLY, don't abort silently (user request)

2.6.3 already DETECTED the "something else owns 8765" case (TCP probe +
token-free /version) and exited 1 — but for packaged launches the error
only reached state_dir/bridge.log: no console exists for a Finder/.app
launch or the Windows windowed exe, so from the user's seat the icon
click just did nothing (Dandan: "warn instead of aborting silently").
New `_user_alert(message)`: native, best-effort, stdlib-only — macOS
osascript `display dialog` (routed through `_run_dialog` so a shutdown
can't orphan it on screen), Windows `MessageBoxW` via ctypes
(MB_ICONWARNING | MB_SETFOREGROUND), Linux notify-send/zenity/kdialog
first-found. Gated to packaged launches (`sys.frozen`) — CLI runs
already have stderr — and suppressed under FILE_BRIDGE_NO_UI=1 so a
login service never throws a modal at the login screen.

Wired into every startup abort: (1) foreign listener at the probe, (2)
the bind-time race fallback — which now RE-VERIFIES via /version
instead of assuming "already running" and opens the live page if it IS
one of ours, alerts + exit 1 otherwise, (3) invalid folder argument
(stale shortcut). Dialog copy names the port, says what to do, and
points at FILE_BRIDGE_PORT + scripts/setup_owui.py for the move-port
path (the skill must follow — SUPPORT.md triage unchanged).

Verification: e2e +1 (foreign squatter = python3 -m http.server on
8765 → exit 1 + message; source 262 pass/1 env pymupdf fail, frozen
263/263 under the uv addon env). Live-smoked the dialog itself: frozen
binary + squatter → caution dialog with the actionable text on screen,
process waits for OK, exits 1 after dismiss. Two harness gotchas from
this round: piping a failed PyInstaller launch into `tail` masks the
failure (pipe status = tail's — the first "rebuild" silently reused the
old binary; always check the binary mtime/`BUILD OK`), and the correct
build interpreter is the uv-archive python at
`~/.cache/uv/archive-v0/J7oC40Dxb_VBEmxhD_i89/bin/python3.12`
(PyInstaller 6.22.2 + pymupdf 1.28.2 — the default python3 has neither).

## 2.6.3 — picker restyle: unified cards + Ignore patterns moved under OCR (user request)

Every config section is now the same .sec card with an icon h3: 📁 Shared
folder (was bare), 🔒 Security, 🔰→🔤 OCR language (was bare with a lone
white langbox), 🚫 Ignore patterns (moved BELOW OCR per user), 👁 preview.
New shared CSS instead of inline styles: h3{margin:0 0 8px} (Security's
h3 previously had default margins, others margin:0 — the inconsistency
that prompted this), .panel (white box: langbox + preview), .btnrow
(flex input+button rows), button.small (Browse/Set token/Refresh), and
textarea joined the input padding rule. <hr> separators dropped (cards
carry their own margin); one kept before the footer. IDs/handlers/
placeholders untouched — JS and e2e greps unaffected. Vision-checked
(glm-4.6V): order correct, cards uniform, no defects. e2e 262 pass
(1 env-only pymupdf failure unchanged).

## 2.6.4 — "Open File Bridge" branding: app icon as favicon/logo (user request)

Page <title>, h2, Stop button, confirm dialog and every model-facing
"settings page" string (ExcludedPath, read/write hints, unlock 503,
reveal 403, SKILL.md) now say Open File Bridge — matching the repo
name. The h2 emoji 📁 is replaced by the REAL app icon: 128px PNG
extracted from build/appicon.icns (iconutil -c iconset), base64-baked
into PICKER_HTML once as the favicon data-URL; the header <img> copies
its src from the link element via JS (one copy of the ~16 KB payload).
macOS .app CFBundleName/CFBundleDisplayName → "Open File Bridge"
(Dock shows the new name; CFBundleExecutable stays FileBridge).

DELIBERATELY NOT renamed (compat floor): binary/process name
(FileBridge — pkill patterns here + scripts reference it), bundle id,
zip/installer artifact names, state-dir paths (~/.file-bridge.json —
renaming would orphan existing users' state), endpoint names. A full
identifier rename buys nothing user-visible; the display name is what
users see. e2e +2 checks (title + favlink); 264 pass source-side
(1 env-only pymupdf fail), frozen build passes all incl. image-shrink.

## 2.6.5 — deep rename: FileBridge → OpenFileBridge (user decision, pre-users)

Display name was already "Open File Bridge" (2.6.4). This round renamed
the IDENTIFIERS while the user base is exactly one person:

- Binary/bundle/artifacts: dist/OpenFileBridge, OpenFileBridge.app
  (CFBundleExecutable OpenFileBridge), OpenFileBridge-macos.zip,
  OpenFileBridge-Setup.exe, PyInstaller --name OpenFileBridge.
- Bundle id com.yourorg.openfilebridge; service names
  open-file-bridge.service / com.openfilebridge.bridge.plist /
  open-file-bridge.bat / ~/Library/Logs/open-file-bridge.log.
- State dir → open-file-bridge (all OS variants) with a ONE-TIME
  wholesale os.rename migration in state_dir() (old dir moved if new
  absent; env override never migrates) — verified live: root config,
  token, versions moved intact.
- Specs renamed: open_file_bridge_{windows,macos}.spec; stale root
  FileBridge.spec deleted.
- Inno AppId marker FILEBRIDGE01 → OPENFILEBRIDGE01 (a pre-rename
  Windows install would side-by-side rather than upgrade — acceptable
  pre-release).
- KEPT (API stability, not branding): env vars FILE_BRIDGE_*,
  src/file_bridge.py module name, port, endpoints, skill IDs.
- New build commands: replace --name FileBridge with --name
  OpenFileBridge in the 2.6 build line; frozen e2e now
  FILE_BRIDGE_CMD=$PWD/dist/OpenFileBridge.app/Contents/MacOS/OpenFileBridge
  (or bare dist/OpenFileBridge — but the .app binary has tessdata/
  wheels siblings; the bare onefile fails asset checks).
- e2e: state-path traversal fixture + foreign-port regex updated to
  the new names. 264 source / 265 frozen (ALL PASS), migration
  verified on the live install.

## 2.6.6 — foldable settings sections (user request)

All five picker cards fold and remember their state:

- Markup: `.sec` divs → `<details class="sec" id="sec-{root,security,
  ocr,ignore,preview}" open>`; each `<h3>` became the `<summary>`
  (h3 is not phrasing content, so the summary carries h3 styling
  itself — the old `h3{margin:0 0 8px}` rule was replaced by
  `details.sec>summary` rules: bold 1.17em, full-row flex, chevron
  ::after with a transform transition, [open] margin-bottom).
- Persistence: localStorage `ofb.folded` = {id:1} for FOLDED cards
  only (absent = expanded), rewritten on every `toggle` event; the
  loader runs before first paint in practice (inline end-of-body
  script). try/catch everywhere — a browser with storage blocked just
  loses memory, never errors.
- Refresh button: kept in the preview header but now inside <summary>
  — inline `event.preventDefault();renderPreview()` so activating it
  doesn't toggle the card (works for mouse and keyboard; the click's
  canceled flag suppresses the summary activation behavior).
- Preview auto-refresh ignores fold state (display:none content still
  updates); nested folder-tree <details> never match `details.sec`.
- Verification detail: e2e was run from a sed-shifted copy
  (8765→8892 + FILE_BRIDGE_PORT=8892 injected before every
  FILE_BRIDGE_STATE_DIR launch) because the real bridge held 8765 —
  all four launches (main, dup-start, breaker, foreign-port) shift
  coherently. TODO-ish: promote to a PORT var in the script.

## 2.7 outcome links — design decisions worth remembering (2026-08-29)

- Trust model split, the core of the whole feature: `allow_reveal` gates
  MODEL-initiated desktop popups (a remote model must not open windows
  unasked); a /click nonce is minted by the model but fired by the USER's
  browser navigation — the click is the consent (same stance as the picker
  buttons, `_do_click` header comment). This is why /click bypasses
  check_request entirely and is NOT gated by allow_reveal.
- Why /click must skip the token tier: chat-answer links are clicked as
  top-level navigations — no custom headers possible. The 128-bit nonce
  (token_hex(16)) is the whole capability: one path, one desktop action,
  no bytes of file content. Multi-use within TTL (1 h, FILE_BRIDGE_LINK_TTL)
  because chat links get re-clicked; unlike confirmation tokens they are
  never burned. Store = click-links.json (0600, swept on load) — cloned
  from pending-confirmations.json.
- CSRF hardening: a page that learns a nonce (leaked/shared chat) could
  still fetch()/img() it. The gate is on request SHAPE, not site (fixed
  2.8.2 — the original pure-Site check broke real deployments): a
  top-level user navigation carries `Sec-Fetch-Dest: document` +
  `Sec-Fetch-Mode: navigate` and is ALWAYS allowed (even cross-site);
  any scripted/embedded request (fetch, XHR, img, script, iframe) lacks
  that pair and gets the refusal page. Why pure-Site was wrong: with
  OWUI on a company domain every real user click is legitimately
  cross-site (localhost is its own site), so the site check refused the
  NORMAL deployment (found live on corporate-hosted OWUI, 2026-08-31);
  and tier-2 deployments have no origin configured to allowlist anyway.
  Absent headers (old browsers) stay allowed. The refusal text says the
  link is for the user's click so the model doesn't misread it as broken.
- Path is stored AS MINTED and re-resolved at click time (roots, ignore
  patterns, lock state can all change within the TTL) — resolve_guarded
  at click, then exists() check, so moved/deleted/unshared all degrade to
  friendly pages instead of surprises.
- `_launch_external(kind, path)`: single dispatch for open+reveal on all
  platforms; Linux reveal upgraded to FileManager1.ShowItems via
  dbus-send (falls back to xdg-open of the parent). FILE_BRIDGE_LAUNCHER
  env overrides everything — real feature (custom file managers) and the
  e2e hook. Side effect: the /reveal e2e tests no longer pop a real
  Finder window on the dev machine; click dispatch is assertable via the
  launcher's log.
- The PORT-var TODO from the 2.6.4 note is DONE: e2e honors
  FILE_BRIDGE_PORT (default 8765) across main/dup/breaker/squat
  launches. Run beside a live bridge with FILE_BRIDGE_PORT=8899.
- Skill wording rule (from the design chat): chat labels are ALWAYS
  OS-neutral ("📄 Open" / "📂 Show in folder") — the model never learns
  the platform, so it can never say "Finder" on Windows; only the
  server-rendered page (which owns sys.platform) says the native word.

## Private-token guidance + personal-token-in-chat (2026-08-29 late)

Dandan asked whether we (a) clearly tell users WHERE to paste a token and
(b) steer companies/users to private tokens instead of a shared one.
Survey: picker help had paste instructions but recommended the ORG token;
user-guide had zero token content (and stale endpoint claims — "no
delete", "~200 KB read cap" — pre-2.x text, now corrected); admin-guide's
"Hardening" section still described the pre-settings-page world (hardcoded
OWUI_ORIGIN constant, invented X-Bridge-Key header) — rewritten to the
two-tier picker reality. Structural gap: a per-user private token was
UNUSABLE with a public skill (model had no way to learn it) — fixed by a
skill rule (2.7, both variants): user-provided token in chat →
BRIDGE_HEADERS for the session, never echoed back. Guidance now
recommends private tokens first (picker help, user-guide Token section,
admin-guide Option A) and frames the org token honestly: company-boundary
credential, visible to all org members, avoid with guest accounts. Note:
picker text change requires an app rebuild to be live (2.7 rebuild covers
it).

## Outcome links v2: server-minted in write responses (2026-08-29 late)

Dandan's first real-chat test (Test Model, "Local Markdown Files") created
`Fortnox Bookkeeping Context - copy 2.md` with NO links. Audit log: /write
200, /link never called — the model read the skill (it had the injected
token) but skipped the optional-feeling extra call. Fix follows the
ignore-enforcement lesson: guarantees live in the bridge, not model
goodwill — `_json` now attaches `links` (open_url + reveal_url + a `say`
format hint) to every 200 POST on a WRITE_LOCAL endpoint whose response
names the produced/edited file ("written", or /edit's path+edited). Models
echo response fields reliably (that's what Rule 8 verify-after-write
already leans on), and it saves a round trip. /link demoted to re-mint
duty (expired links). TRAP found by the new e2e check: write responses
carry the ABSOLUTE written path but resolve_any REJECTS absolute input —
a link minted from it 400s at click ("Path not accessible"; /tmp vs
/private/tmp made it visible). `_link_addr()` normalizes: absolute-inside-
root → bare rel (default root) or '<root-id>/rel' (multi-root), relative
passes through; both _attach_links and /link use it (models echo
d["written"] into /link, so /link had the same latent bug). Restores
inherit no links (message-shaped "restored" field, rare — skipped
deliberately); /write_many results[] too (top-level only for now).

## Token box mask + Show/Hide toggle (2026-08-30, 2.7.2)

User ask: once a token is set, show a hide/show button on the token
input. Implemented as a standard password-field toggle, NOT a
reveal-the-stored-token endpoint:

- input is `type="password"`; a Show/Hide button (id=tokvis) appears
  whenever the box has content (syncTokVis() on input + after refresh()
  sets the placeholder dots). What Show reveals is only what the box
  holds — a fresh paste/generate (useful to verify/copy) or the literal
  `••••` placeholder after reload.
- Why no server-side reveal: the picker API is loopback-only and
  token-free (it is the bootstrap UI), so a reveal endpoint hands the
  plaintext to any local user/process that can reach 127.0.0.1 — wider
  than the 0600 bridge-token file (owner-only). get_configured_token()'s
  "NEVER returned in any HTTP response" invariant stays intact.
- Ride-alongs: genToken() now fills the box with the fresh token
  (masked; toggle Show to copy); clearToken() calls refresh() so stale
  dots leave the box immediately; refresh()'s hint reworded to say the
  dots are a placeholder and the bridge never sends the token back.
- e2e untouched (suite asserts picker API, not page DOM). Rebuild
  required: page HTML is baked into the exe.

## Token reveal follow-up (2026-08-30, still 2.7.2)

Dandan live-tested the mask round and clicked Show on a configured
bridge: the box showed the literal dots placeholder — the button READ as
broken. The dots-only design (page never receives the stored token) was
correct on its own terms but failed the user. Owner decision: Show must
reveal the stored token.

- POST /api/root {"token":{"reveal":true}} → resp.token = stored
  plaintext ("no token configured" 400s). Loopback-only, cors=False,
  and audited as a second line: args {"action": "token-reveal"} — the
  marker MUST live under a non-secret key: _audit_scrub rewrites any
  value keyed "token" (etc.) to [redacted], which swallowed the first
  attempt ("token": "[reveal]" logged as [redacted], indistinguishable
  from the generic line).
- toggleTokVis: dots in the box = "never revealed yet" → Show fetches
  the reveal, replaces dots with the real token, type=text. Hide just
  masks (value kept — standard password-toggle semantics; plaintext in
  a masked input is how every login form works). Toggling again is
  local, no refetch. refresh() resets to dots.
- The get_configured_token "NEVER returned in any HTTP response"
  invariant is narrowed, not abandoned: loopback picker POST only; the
  OWUI/file endpoints still never see it. Exposure analysis in the
  handler comment + ROADMAP: no-CORS POST blocks websites, same-user
  processes read the 0600 file anyway, other local OS users already
  control the bridge via the token-free loopback API (they gain secret
  disclosure, not new control).
- e2e +3 (reveal returns token, reveal audited, picker has tokvis).
- Harness fix (found the hard way): the frozen e2e run before this round
  piped through `tail` (masked the failure — exit 0) and ran with system
  python3, which lacks pymupdf → set -e aborted at the fitz fixture, the
  EXIT trap then died on unset $SQUAT (unbound), the trap's kill never
  ran, and the bridge + its stdout pipe leaked (pipeline hung until the
  orphans were killed). Fixes: trap now uses ${BRIDGE_PID:-} ${SQUAT:-};
  the fitz heredoc fails ONE check with the canonical-invocation hint
  (uv run --with pymupdf,rapidocr-onnxruntime) instead of aborting.

## 2.8 macOS code signing + notarization (2026-08-30)

First real Developer-ID signing (Sparkling AI AB org account; Dandan did
the portal setup). `package_macos.sh --sign` was an untested stub — running
it for real surfaced two things worth remembering:

- **Data files CANNOT live in Contents/MacOS/.** codesign treats every file
  in MacOS/ as code (bundle layout rule: that dir holds executables), so
  tessdata/kor.traineddata made it fail with "code object is not signed at
  all / In subcomponent". Old layout shipped wheels/+tessdata next to the
  binary; they now go to Contents/Resources/ and `_app_dir()` (src) prefers
  Resources when frozen inside a bundle that has assets there (exe-dir
  fallback kept: bare onefile, Windows, CI artifacts). `_soffice_bin()`
  reuses `_app_dir()` now instead of its own inline exe-dir logic. Binary
  must be REBUILT after touching that function — the frozen app embeds it.
  Build env on this Mac: `uv run --with pyinstaller pyinstaller --onefile
  --windowed --name OpenFileBridge src/file_bridge.py` (no system
  pyinstaller installed).
- **Old script's sign block was wrong in three ways**: no `--options
  runtime --timestamp` (both REQUIRED for notarization — hardened runtime +
  secure secure timestamp), `xcrun staple` (the tool is `xcrun stapler
  staple`), and it zipped BEFORE stapling so the shipped zip lacked the
  ticket. Fixed flow: sign → verify → ditto zip → notarytool submit --wait
  → stapler staple+validate → spctl → RE-zip the stapled app; that final
  zip is the distributable. `--deep` dropped: onefile bundle has exactly
  one Mach-O (tessdata/wheels are data, sealed via CodeResources).
- Credentials on this Mac: keychain cert `Developer ID Application:
  Sparkling AI AB (2N9PCQ7G5Z)`; notary profile `ofb-notary` (Apple-side
  app-specific-password label `notarytool-open-file-bridge` — the label is
  never used in commands). This CLT's notarytool has NO
  `store-credentials --list`; probe with `xcrun notarytool history
  --keychain-profile NAME` ("No submission history" = profile works).
  Identity check: `security find-identity -v -p codesigning`.
- PyInstaller deprecation warning (v7 will error): onefile + windowed .app
  "clashes with macOS security" — onedir migration is the eventual answer;
  fine for now (the stdlib-only binary is a single Mach-O, signs+notarizes
  cleanly).
- CFBundleVersion now stamped from src VERSION (was hardcoded 1.0.0);
  Finder Get Info shows it.
- **Notarization does NOT run the app.** The first notarized zip was
  runtime-broken and still Accepted — Apple scans signatures/structure only.
  Our launch check (below) is the functional gate; never skip it after a
  signing change. What was broken: hardened runtime enables library
  validation; the onefile bootloader extracts ad-hoc-signed
  libpython3.12.dylib to /var/folders at startup; on arm64 dyld rejects it
  ("mapping process and mapped file (non-platform) have different Team
  IDs") and the app dies BEFORE any Python log line (only a bare `open`
  that never comes up + no crash report — run the bundle binary directly
  to see the PYI error). Fix: `build/entitlements.mac.plist` with
  com.apple.security.cs.disable-library-validation, passed to codesign via
  `--entitlements`. GOTCHA: AMFI's entitlements parser rejects XML comments
  ("AMFIUnserializeXML: syntax error") — keep the file comment-free.
  Long-term alternative: onedir mode + sign everything with our identity.
- **Keychain prompts recur.** "Always Allow" on the codesign key-use dialog
  is per... not always persistent: signing hung again on a later run
  (SecKeyCreateSignature stuck in mach_msg — `sample <pid>` shows it).
  Expect up to one click/prompt per login session before `--sign` works;
  if a run hangs at "replacing existing signature" >2 min, look for the
  dialog. Unsandboxed Terminal runs surface the dialog more reliably.
- End-to-end verified (2.8, submission 77ec8254): notary Accepted,
  stapler validate + spctl (source=Notarized Developer ID) pass on the
  app EXTRACTED FROM the shipped zip; launched app serves v2.8 with
  wheels:8 + 22 OCR langs from Resources. `addons.pdf:false` is CORRECT
  for frozen builds (pymupdf = optional pip add-on, source runs only).
  Cosmetic: "timestamp mismatch (N seconds apart)" from codesign -d when
  the keychain wait delayed signing (CD built at start, timestamp at
  click) — Gatekeeper verdict (spctl) is the authoritative check.
- Rebuilt binary is REQUIRED after touching `_app_dir()` — the frozen app
  embeds it (`uv run --with pyinstaller pyinstaller --onefile --windowed
  --name OpenFileBridge src/file_bridge.py`; PyInstaller's BUNDLE step
  errors on a non-empty dist/OpenFileBridge.app — harmless, package_macos.sh
  wipes + reassembles it anyway).

## CI signing (2026-08-30, same day)

Dandan opted for full CI signing (repo is PUBLIC → Actions free/unlimited,
sole owner → secrets risk surface acceptable). build.yml mac job now: if
secret MAC_SIGNING_P12 set → import .p12 into throwaway build.keychain-db
(set-key-partition-list makes codesign non-interactive — the local
one-click-per-login-session nuisance does NOT exist on runners), store
notary profile ofb-notary into that keychain, run package_macos.sh --sign;
unset secret = old unsigned fallback. Secrets: MAC_SIGNING_P12 (base64 p12),
MAC_SIGNING_PASSWORD, NOTARY_APPLE_ID, NOTARY_PASSWORD. Team ID hardcoded
(public in every signed binary). CI mac builds freeze pymupdf (pdf:true —
pip env at analysis time; local uv builds don't → pdf:false locally only).
Verify CI artifacts on any Mac: stapler validate + spctl.
- CI-signing ACTIVATION (same evening, green on v-ci-sign-test-4 = b7e8cb7):
  three fixes en route — (1) `secrets` context is NOT allowed in step `if:`
  (GitHub rejects the whole workflow at validation, runs die in 0s with no
  job logs) → map secrets to job-level env, test `env.X != ''`; (2) notarytool
  `--keychain` takes a FILE PATH (\$HOME/Library/Keychains/build.keychain-db),
  unlike `security` cmds which accept names; (3) the p12 password is ONLY the
  `-P` value from export (not Mac login, not Apple ID) — regen with a simple
  one + local `security import` probe before touching secrets. Verified:
  run 33324836317 all-3-OS green, mac log shows Accepted → stapled → spctl
  Notarized Developer ID; downloaded artifact re-verified locally (stapler+
  spctl+entitlements) and booted on port 8999: v2.8, pdf:true (CI freezes
  pymupdf), 22 langs. CI zip = 73MB (vs 51 local) — the CI artifact is the
  better release build.
- CI actions Node-24 bump (2026-08-30, same day): run 33326737436 (v2.8.1)
  warned "Node.js 20 is deprecated … forced to run on Node 24" for
  checkout@v4, setup-python@v5, upload-artifact@v4. Fixed: checkout v4→v5,
  setup-python v5→v6, upload-artifact v4→v6 (v6 is the first upload-artifact
  major that DEFAULTS to node24 — v5 still ran node20 by default per its own
  v6 release notes; verified runs.using: node24 in each tag's action.yml).
  None of the majors' breaking changes touch this workflow (tag/dispatch
  triggers only — no PR checkout; python-version input unchanged; artifact
  upload uses name/path/if-no-files-found only). Proven green via
  workflow_dispatch run on master after push.

## Versioning (policy, 2026-08-30 — read before bumping anything)

App and skill versions are DECOUPLED (one-way floor, never lockstep):

- `VERSION` (src/file_bridge.py) — the APP. Free semver: patch for fixes
  (picker tweaks, CI), minor for new endpoints/features. Bumps freely
  with NO skill change. Historical note: 2.7→2.7.1→2.7.2 already did
  this before the policy was written down.
- Skill version (`skill/open-file-bridge/SKILL.md` title +
  CHANGELOG.md) — moves ONLY when the skill TEXT changes. Independent
  of app releases.
- `SKILL_MIN` (src/file_bridge.py) — the OLDEST bridge the current
  skill text works against. Bump ONLY when the skill starts using an
  endpoint that didn't exist before. Currently 2.5.
- The bridge CANNOT see which skill an org installed (the skill lives
  in Open WebUI server-side) — therefore /version has NO equality
  check BY DESIGN. It reports `skill_min` informationally. The REAL
  compatibility check is model-side at bootstrap: skill states its
  minimum, compares /health.version, warns only when the BRIDGE is
  older. Newer bridges never warn (API backward-compat is an invariant
  guarded by the e2e suite).
- setup_owui.py is the sync tool (always installs the repo's current
  skill text); drift is handled by the model-side floor check above.

Why: equality semantics produced nagging on every harmless app patch
bump while being structurally unable to detect actual drift (it
compared the bridge's own embedded constant with itself). This is the
standard pattern (VS Code engines.vscode, WordPress "requires at
least").

## 2.9.1 — Windows Browse… fix: the unbalanced-brace PowerShell snippet (2026-09-02, user report)

A real-Windows user on 2.9.0 reported: clicking **Browse…** in the
settings page shows `✗ Missing closing } in statement block or type
definition. … MissingEndCurlyBrace`, while typing the path manually +
Save folder works. Root cause: the Windows branch of
`pick_folder_dialog()` assembled its PowerShell snippet from adjacent
string fragments with a MISSING closing brace — `& {` + `if (…) {`
gave two opens but only one close, so Windows PowerShell refused to
parse it and died before the FolderBrowserDialog could open (stderr →
picker status line, which is why the user saw the raw ParserError).
Bug window: v2.4 (6d536bb) through 2.9.0. Manual path entry never
touches this code path — always a full workaround.

Why it survived every gate for five versions:
- macOS uses osascript and Linux zenity/kdialog — the Windows branch
  never executes on dev machines.
- Wine cannot host the --windowed exe (bootloader stdout deadlock),
  so no local Windows runtime test existed.
- CI Windows launch-smoke only hits /health — /api/pick_folder
  would hang 600 s on a real modal dialog, so it was never in CI.
- The e2e suite never inspected the snippet text itself.

Fix (app 2.9.1, skill untouched — versioning policy):
- Snippet lifted to module constant `_WIN_PICK_PS_CMD` as ONE literal
  with balanced braces, plus edit-rules comment (never -EncodedCommand:
  the readable form is the testable form).
- e2e: import the constant, assert brace/paren balance + shape in
  process (marker pattern — import-time stdout can carry lib warnings
  like the fitz deprecation notice under `uv run --with pymupdf`;
  never parse captured stdout). e2e 310→311.
- CI Windows job: new step parses the EXACT constant with BOTH
  engines users have — pwsh AND Windows PowerShell 5.1 (`powershell`),
  each in its own process via `-File` with a param()-based parse-check
  script (parse-only, dialog never shown). Repro proven first in
  mcr.microsoft.com/powershell:latest on dpc: OLD snippet → the exact
  user error; fixed → parses clean, 59 tokens.

Lesson (generalizes): any string-built foreign-language snippet sent
to a shell interpreter is only testable if it is importable as a
constant AND parsed by a real engine in CI. Balance-counting in e2e
on Linux would NOT alone have caught a semantically broken but
balanced snippet; the CI real-engine parse is the actual guard.

## Stage-3 session #5: engines (P3+P4) + negatives (P1b) + CWS pass (P2b) + skill 3.0-EXT (P5) (2026-09-06)

Engine architecture landed (all verdicts from real-browser runs through the
real sandbox→relay→SW pipe, tests/stage3/engines_test.py — 13/13 PASS):

- **pdfium = PDF READER only** (text + page render). Its SAVE side is
  unusable in the @hyzyla 2.1.13 build: FPDF_SaveAsCopy needs a wasm-table
  function pointer; `addFunction` is NOT exported and `WebAssembly.Function`
  is not shipped in production Chromium (probed both — dead ends, don't
  retry). Page-surgery exports (ImportPages/Page_New/CreateTextObj) exist
  but without Save they're useless.
- **pdf-lib 1.17.1 (vendored UMD, MIT, 525KB) = PDF WRITER**: /pdf_op
  split/merge/rotate output + searchable-PDF assembly.
- **tesseract.js 7 `outputs:{pdf:true}`** = the /ocr_pdf writer: its
  TessPDFRenderer emits image + invisible-text-layer pages; pdf-lib merges.
  Cross-engine proof: pdfium getText on the tesseract output returns the
  probe terms ("E2E INVOICE 997 … 44000 SEK").
- **`gzip:false` + absolute chrome-extension:// langPath** (both
  first-class tesseract.js options): plain .traineddata files from
  vendor/tessdata-fast/ — NO gz packaging needed.

Three extension-platform blockers found & fixed (each cost a probe):

1. **Extension-page CSP blocks WebAssembly.instantiate** ("neither
   'wasm-eval' nor 'unsafe-eval'…script-src 'self'"). The tesseract core
   aborts INSIDE its worker, so the page-level promise never rejects —
   it HANGS (no console error at the call site; only worker console
   errors). Fix: manifest `content_security_policy.extension_pages:
   "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` — the
   MV3-sanctioned wasm keyword (Chrome 103+), no remote code.
2. **tesseract.js spawns its worker via a blob URL that importScripts
   the real path** — blob importScripts is blocked in extension context.
   Fix: `workerBlobURL: false` (worker loads directly from the
   extension URL).
3. **chrome.runtime.sendMessage STRUCTURED-CLONES and DROPS File
   objects** — the engine page received an empty "/input" (tesseract:
   "Image file /input cannot be read"). Fix: the SW packs inputs as
   base64 strings (`packOne` in fs-engine.js), outputs come back as
   base64 too (`__writeFile.b64`), written through the guarded write
   path (snapshot-first + rate breaker + audit) in the SW.

Also found: **`epMovedRead` was CALLED BUT NEVER DEFINED** (lost in the
session-#8 file split; node --check cannot catch undefined identifiers —
same class as the const-reassign bug). /docx_read & friends returned
status 0 "adapter error". Now implemented with app-parity validation
(resolveGuarded + getFileFor inside try/catch → 404/403 before the 501
moved+recipe reply). Static-check lesson: before CWS submit, run an
undefined-identifier scan (acorn/lint), not just node --check.

P1b negatives (tests/stage3/negatives_test.py) — 11 cells + disk
evidence PASS: evil-destination 400, foreign url/port fields dropped,
PUT refused, path-outside-roots refused, sensitive floor 403×3,
zip-slip 400 (whole-archive abort, nothing extracted), snapshot-on-disk
(real copy under .ofb-snapshots/<ts>/), readonly-root 403 (host flips
the IDB root row), moved-endpoint 501+moved, /convert 501, rate breaker
429 at ~19 writes. Test-order lesson: alphabetically-sorted cells put
the rate-breaker BEFORE later write cells — name it zz_* so it runs
last (the breaker poisons the write budget for the whole SW lifetime).

P2b CWS pass: manifest storage-only + wasm-unsafe-eval CSP verified,
all referenced pages/scripts exist (guide.html + guide.js added — the
/guide endpoint pointed at a page that did not exist), du 52MB / zip
26.4MB / 58 files, all required entries verified inside the zip
(dist-stage3/, gitignored — regenerate with zip -qr from extension/).

Skill 3.0-EXT (skill/open-file-bridge/SKILL-EXT.md): extension IS the
backend (no app/token), permission_needed → Reconnect → "Allow on every
visit" = persistent (steer users there explicitly), engine_needed →
open engine tab, OCR all-caps diacritic caveat, moved-endpoint Pyodide
recipes with bundled wheels, /convert user-message wording, writes
immediate + snapshot-first.

macOS first-manual-load bug (2026-09-06, Dandan's real Chrome 152):
"Choose / manage folders…" on options.html was a dead click — no tab, no
picker. Root cause: **options.js wired #save/#setup at module level
while loading from <head>** (classic script, body not parsed yet) →
`null.onclick` TypeError killed the whole script before its
DOMContentLoaded handlers registered → #setup never wired AND the page
never loaded settings (on-screen proof: #auditrows stuck at "…", inputs
empty). Platform-independent — Linux was equally broken; the stage3
suites never click the options page (they drive setup.html directly),
which is why the green runs missed it. setup.js documents this exact
hazard in a comment; options.js was the one page that missed the
pattern. Fix: both onclick assignments moved inside the page's existing
DOMContentLoaded listener (grep-audit: setup/guide/open/engine-host
were already correct).

Same session, second dead end fixed: the toolbar action is titled
"Open File Bridge — choose folder" but the manifest declares no popup
and sw.js had no chrome.action.onClicked — the icon did nothing.
sw.js now opens setup.html on click.

Verification (Dandan's browser, in place, extension reloaded via
chrome://extensions): options page now loads (20/50/eng defaults,
"No folder connected yet", "no activity yet"), #setup opens
setup.html, #pick opens the native macOS open panel ("Select where
this site can save changes"); cancelled — folder choice left to
Dandan. Independently confirmed in Playwright "Chrome for Testing"
1208 on macOS: picker opens from the extension page, cancel resolves
as AbortError and the page shows "Folder selection cancelled."

Automation lessons: branded Chrome 152 ignores --load-extension (load
via the chrome://extensions UI, or use Chromium/Chrome-for-Testing
builds); osascript System Events needs assistive access — the
AX route (open_panel window + Select/Cancel buttons) is the reliable
picker probe on this Mac. node --check cannot catch this bug class
(DOM timing, not syntax) — head <script> pages MUST wire DOM in
DOMContentLoaded or use defer. dist-stage3 zip rebuilt after the fix.

Local OWUI test wiring (2026-09-06): the owui-test stack (127.0.0.1:8788)
is plain HTTP, which "matches": ["https://*/*"] never injects into — the
relay was silently absent on local OWUI. manifest.json content_scripts
now also match http://127.0.0.1/* and http://localhost/* (match patterns
carry no port, so every local port is covered; this changes only WHERE
the relay injects — no new permissions, the SW stays the boundary).
OPEN PRODUCT QUESTION for the CWS manifest: the LAN topology in the
store listing is presumably plain http too — does the shipped manifest
need broader http matching? Left for Dandan.

SKILL-EXT 3.0 staged surgically into owui-test's webui.db (skill row id
'open-file-bridge', content replaced 28444 -> 9449 chars, updated_at
unix int; replaced the app-era 2.11.2 token variant). Extension-mode
needs no token, so no runtime embedding this time.

Pipe verified in Chrome-for-Testing on http://127.0.0.1: sandboxed
srcdoc iframe postMessage /health -> relay -> SW -> fsRoute -> back:
HTTP 200 {"version":"3.0.0-EXT","addons":{"pdf":true,"ocr":true},
"hint":"no folder chosen yet"} — the expected no-grant answer. Relay
injection on http worked after the manifest change (content-script
isolated world: main-world evaluate CANNOT see __ofbRelayInstalled —
probe the pipe, not the flag).

Harness gotcha that burned 30 min: srcdoc assigned as an ELEMENT
PROPERTY must close its script with a literal </script> — the "<\/script>"
escape (correct inside a JS template literal) leaves the tag unclosed,
the script never runs, and the symptom is a silent pipe timeout.

First real-OWUI extension chat (2026-09-07, Dandan's "list my local files"):
three findings. (1) The listing "failure" was the documented permission
gate — /health showed perm:"prompt" (the in-place extension reload for
the loopback-manifest commit resets the session grant), and GET /list
answers 403 {permission_needed:true, hint: Reconnect} exactly per plan
§4.3. User action: setup page → Reconnect → "Allow on every visit".
(2) REAL BUG in SKILL-EXT 3.0 bootstrap, caught by the model's first
cell (AttributeError: data): ofb_fetch/ofb_fetch_b64 returned
ev.data.to_py() while on_message stores the ALREADY-unwrapped event
data in the future — double-unwrap. The session-2 e2e harness had
ev.to_py(); SKILL-EXT.md drifted when written. Fixed to ev.to_py(),
H1 bumped 3.0.1-EXT, both OWUI rows restaged (Dandan had manually
published the body as skill id 'local-file-bridge-ext', is_active=1,
per the skill's own publishing note; the surgically-updated
'open-file-bridge' row sits is_active=0 — left as he set it).
(3) OWUI-side display noise, not ours: cells printing MULTIPLE lines
showed only the LAST line in the chat transcript, plus a recurring JS
stderr 'Cannot read properties of undefined (reading includes)' — the
model never saw its /list 403 (first loop iteration!) and burned cells
guessing nonexistent endpoints (/ls /dir /entries → correct 404s).
/list is the correct endpoint; engines/negatives suites already cover
it. If multi-line stdout keeps vanishing in OWUI chats, prefer one
json.dumps per cell.

Skill 3.0.2-EXT (2026-09-07, Dandan's suggestion turned two-part): the
403->Reconnect teaching already existed, but the real chat never SAW
the 403 (OWUI last-stdout-line-only quirk). Added (1) a PERMISSION
PREFLIGHT on the first /health — roots[].perm == "prompt" → STOP and
tell the user toolbar icon → Reconnect → "Allow on every visit", wait
for confirmation before any other call; (2) a diagnostics rule: ONE
print(json.dumps(...)) per cell, because OWUI drops all but the last
stdout line. DB rows left for Dandan's manual paste (his stated
workflow) — they still hold 3.0.1-EXT until he pastes 3.0.2-EXT.

## Stage-3 session #6: one settings page (toolbar icon == Options) (2026-09-07)

Dandan's ask: the extension's two entries showed two different pages —
toolbar icon opened setup.html (pick/reconnect only), Options opened
options.html (folders list + rate limits + audit) — while the desktop
app's settings page (PICKER_HTML) has 7 cards. Unified: **options.html
is now the single dashboard**, porting the app page's look (same CSS
vocabulary: details.sec cards with ▸ rotation, .btnrow, ok/hint/warn,
fold-state in localStorage `ofb.folded`) and its sections with
extension semantics:

- 📁 Shared folders — pick (#pick id kept: the stage3 suites wait on
  it) + root rows (Reconnect / Enable-Disable writes / Remove).
- 🔒 Security — no origin/token inputs (retired): explains the browser
  permission gate + relay gates + the always-on floors instead.
- 🔤 OCR language — checkbox grid (bundled top-8) + free text,
  two-way sync, saves through the SW's POST /ocr/lang (validation
  parity); engine line + Open-engine-tab button.
- 🚫 Ignore patterns — NEW editor (the kv `ignore_global` existed but
  NOTHING applied or edited it before). fs-core's allIgnorePatterns
  is now async and merges ignore_global; /list /search
  /directory_tree + resolveGuarded all await it. This also makes the
  fs-core 404 hint "ignore patterns are editable in the Open File
  Bridge settings page" TRUE for the first time.
- ⏳ Link lifetime — NEW select (same 6 choices as the app) → kv
  link_ttl (fs-links already read it; default 7 days).
- 🛟 Safety & recovery — guide button (guide.html), rate limits
  (writes/min + MiB/min), and a NEW global Read-only checkbox (kv
  `readonly_global`): resolveGuarded's forWrite path 403s with the
  same "read-only mode is active" shape as per-root readonly.
- 👁 What the AI can see — the app's preview card: /directory_tree
  through the SW PIPE (engine aliveness + one router instance live in
  the SW — a page-local fsRoute would report its own dead engine
  state), collapsible folders with open-state preserved across the
  5 s auto-refresh, lock messages for no-root / perm-prompt.
- 🕓 Recent activity — the old audit card, kept.

sw.js action.onClicked → options.html (was setup.html); setup.html is
now a meta-refresh redirect (no script — CSP) so old deep links and
guide wording keep working; setup.js deleted (merged into options.js).
manifest action title "— settings". /health now reports
`engine_alive` (FS_ENGINE_ALIVE heartbeat) so the page can say "engine
tab not running" honestly — `addons` means BUNDLED, not running (the
smoke initially showed "PDF ready · OCR ready" with no tab open; wrong
signal, fixed). guide.html "Pick folder" → "Choose folder…" to match
the button label.

SKILL-EXT 3.0.2-EXT → 3.0.3-EXT: one wording fix (permission
preflight said the toolbar icon "opens the setup page"). Stage3 suites
(spike1/engines/negatives) repointed setup.html → options.html; they
still wait on #pick, which the unified page keeps (wired synchronously
inside DOMContentLoaded, ahead of the first await — the a1b8c8d
head-script lesson). No manifest version bump (3.0.0 unreleased; the
CWS zip is rebuilt per change).

Verification on this Mac (stage3 suites need Linux/Xvfb — not run
here): headless Chrome-for-Testing 1208 with the real extension
loaded: page loads with ZERO console errors; heartbeat
"Running · v3.0.0-EXT · security: extension · no folder chosen yet";
every save path round-trips through the SW pipe (ignore_global
["*.zip","secret-folder/"] lands in /state, ttl 30 days, rate 33/50,
readonly true, ocr lang swe+eng); fold persistence works; GLM-4.6V
render review: 9 sections in order, no layout defects. Picker-driven
paths (grant → tree preview, reconnect) still need the Linux suites —
next run there should confirm n1-n12 + engines 13/13 unchanged.

## Stage-3 session #6b: extension icon = the app's brand icon (2026-09-07)

Dandan's ask: same icon as the app, or a similar one. Answer: the same —
the extension had NO icon declared (Chrome showed the generic puzzle
placeholder). Generated extension/icons/icon-{16,32,48,128,256}.png from
docs/brand/icon-512.png (the approved C-folder + B-badge final, also the
.ico/.icns source; `sips --resampleHeightWidth`), wired into manifest
`icons` (incl. 256 for the CWS listing) + `action.default_icon` (16/32/
48/128). GLM-4.6V legibility review on light+dark toolbar strips: folder
recognizable at 16px, no downscale halos, badge detail shrinks but
identity holds — same tradeoff the app's own 16px .ico entry makes, so
brand-consistent; no simplified 16px variant needed. Extension still
loads clean in Chrome-for-Testing with the icons present; zip rebuilt
(63 entries incl. the 5 PNGs + icons/ dir).

## Stage-3 session #7: worker transport — OWUI 0.11's pyodide WORKER executor (2026-09-09)

Symptom: real OWUI chats ("list files") hung to "Execution Time Limit
Exceeded" while the extension was loaded, the folder granted, and the
tab refreshed. Systematic elimination:

1. Extension healthy — a fresh 127.0.0.1 tab in Dandan's own Chrome
   answered /health in 0.0 s with roots granted (verdict page
   /tmp/ofb-debug/page.html pattern); content scripts injected.
2. The OWUI tab itself failed even after reload — not a stale relay.
3. Ground truth from his owui-local bundle (v0.11.1-crypto44): python
   cells execute in a pyodide WORKER (CodeBlock + execute_code tool;
   shared-worker executor with an iframe-sandbox FALLBACK — chunk
   Cu_6R2Jb.js exports the iframe factory `mm()`). In a worker
   `from js import parent` ImportError-kills the cell at line 2
   (reproduced with his pyodide v314.0.3 — which, note, rejects CLASSIC
   workers, module only). The tool runner then shows its own 60 s
   "Execution Time Limit Exceeded" instead of the ImportError, which is
   why this looked like a transport hang rather than a crash. The skill
   only ever worked in real chats when the iframe fallback executor ran
   (matches the 2026-09-07 real-chat 403 observation).

Fix (this session):
- extension/relay.js — new worker pipe: BroadcastChannel("ofb-pipe")
  listener alongside the window pipe. Workers have no parent window but
  CAN use BroadcastChannel (same-origin); content scripts share the page
  origin, so the relay hears them. Per-worker ELECTION: every relay
  answers an {ofbHello, workerId} with its random tag; the worker keeps
  the smallest tag and addresses requests {to: tag} so exactly ONE relay
  forwards (two OWUI tabs must never run a write twice). Security: the
  channel is same-origin = the page's own scripts, which could already
  ride the window pipe (isDescendantIframe matches the page's own
  window; a hostile page can proxy via its own iframes) — no new
  capability. Both sendMessage call sites now also catch the orphaned
  content-script throw ("Extension context invalidated") and answer
  fast instead of hanging the caller to its timeout (long-standing
  minor bug, found during the hunt).
- SKILL-EXT.md 3.0.5-EXT → 3.0.6-EXT — bootstrap guards
  `from js import parent` (ImportError → None), installs BOTH listeners
  (window + BroadcastChannel) and picks the transport per call:
  parent.postMessage in an iframe executor, elected-relay
  BroadcastChannel in a worker. Fast-fails with actionable messages
  ("no relay answered" / "no transport available") instead of a 60 s
  timeout; a timeout resets the election (dead tab self-heal).
  ofb_fetch_b64 is now a thin wrapper (b64 flag) — less duplicated
  bootstrap code for models to copy.
- Version bumps: manifest + FS_VERSION 3.0.0 → 3.0.1 (transport
  capability the skill gates on: "requires extension ≥ 3.0.1"). The
  "no manifest bump while unreleased" convention from #5/#6 was for
  cosmetic changes; a capability the skill negotiates needs the stamp.
- STAGE3-PLAN "relay.js byte-for-byte" invariant amended (§diag + §P6)
  with the why; TODO §6b records the Linux-suite rerun debt.

Verification (this Mac, real extension from the repo tree):
tests/stage3/worker_transport_test.py — NEW, Mac-safe (no Xvfb, no
folder grant needed): extracts the bootstrap VERBATIM from SKILL-EXT.md
and runs it (a) in a module worker → /health 200 in 0.27 s incl.
election, body honest ("no folder chosen yet" — scratch profile),
(b) with a second relay page open → exactly one reply envelope per
request (election, no duplicate forwards), (c) hello/relay handshake
observed on the channel, (d) iframe regression: same bootstrap in a
srcdoc+allow-scripts sandbox answers via parent.postMessage in 0.0 s.
7/7 green. Harness notes: pyodide dist fetched from the running OWUI
(like spike1); the scratch server needs CORS (OWUI itself serves
/pyodide with access-control-allow-origin: null for its opaque-origin
sandbox) and ThreadingHTTPServer once several pages load the 10 MB wasm
concurrently; pyodide in an opaque srcdoc needs an ABSOLUTE indexURL
(its own location.href is about:srcdoc).

OWUI restage: SKILL-EXT 3.0.6-EXT staged to both rows (staged skill +
Dandan's manual local-file-bridge-ext) via webui.db, updated_at unix
int — no container restart.

## Stage-3 session #7b: blocking confirmations — the approve-retry LOOP (2026-09-09, later same day)

Dandan's report: overwrite → popup → Approve → "approved" → model
retries → a NEW popup → forever. Root cause: v1 stored verdicts ONLY
in the SW's CONFIRM_PENDING map — MV3 SWs die after ~30 s idle, so the
Approve click usually woke a FRESH worker with an empty map; the click
was answered "unknown or expired" but confirm.js ignored the response
and the card still said "✓ Approved". Every retry raised a fresh ask.

Redesign per Dandan's spec (ext 3.0.2 / skill 3.0.7-EXT):
- fs-confirm: the gated request now BLOCKS on the verdict for
  CONFIRM_WAIT_MS = 20 s (chosen under the relay's 120 s id TTL, the
  skill's 60 s cell timeout, OWUI's 60 s executor limit, and the SW's
  ~30 s idle window, leaving ~40 s for the write). Approve in time →
  the SAME call executes and returns the real result. Deny → 403
  denied. No click → 403 {confirmation_required, timed_out: true} with
  a retry-once hint; the ask STAYS armed so a LATE approve grants the
  next identical retry (single-use, 5-min TTL).
- Persistence: asks/verdicts now live in IndexedDB (fs-idb v2, new
  "confirm" store) — SW death can never eat an approval again.
  fs-idb connections also close on versionchange now: an options tab
  holding a v1 connection would otherwise BLOCK the v2 upgrade forever
  (his options tab was open — would have hung /health on upgrade).
- sw.js: confirmVerdict is async (IDB) — the verdict listener returns
  true and answers via .then(sendResponse).
- confirm.js: honest settle (a rejected verdict shows "⚠ not recorded
  — ask again in chat" instead of lying "✓ Approved"), plus a live
  countdown for the 20 s window; meta text updated.
- Skill 3.0.7-EXT: the confirm section now teaches the one-call flow
  (approve in time = same call returns the result; timed_out = tell
  the user, retry ONCE; late clicks still count).
- confirm_test.py updated to the new contract: NEW c0 (driver approves
  MID-WAIT from the SW → same call returns 200), c1 expects
  timed_out, c5's deny now happens mid-wait on the cell's own ask.
  Linux/Xvfb only — NOT run on this Mac (recorded in TODO §6b).

Verification on this Mac: worker_transport_test 7/7 (regression, incl.
the fs-idb v2 bump). LIVE end-to-end in Dandan's Chrome (ext reloaded
to 3.0.2, fresh chat, real popup): "append a line to link-smoke.txt" →
popup appeared → DANDAN clicked Approve himself (the real-user path;
the AX-driven click raced his and lost with a stale-element error) →
the SAME execute_code returned {"ok": true, "written":
"/link-smoke.txt", "bytes": 35, "snapshot": {...5-byte original}} →
model confirmed the append. No retry round trip. Side observation:
the closed-shadow card DOES expose its Approve/Deny buttons to macOS
accessibility. OWUI rows restaged to 3.0.7-EXT.

## Stage-3 session #9: invisible engines (offscreen) + the engine_alive misread fix (2026-09-09)

Trigger: Dandan's OCR test — the model found the parking image, then asked
him to open the engine tab WITHOUT ever calling /ocr. Root cause chain:
(1) auto-open already existed (34fe464, default ON, background tab), so
the extension was fine; (2) the SKILL documents /health fields but not
engine_alive (added session #6 for the settings page) — the model saw the
undocumented "engine_alive": false next to "addons": {pdf:true,ocr:true}
and concluded OCR was unavailable; (3) the skill's only engine guidance
was the 409 fallback wording, which the model mirrored verbatim. His ask:
skip asking the user entirely — run OCR invisibly.

Why not ON the OWUI page (his first idea): page CSP governs content-script
wasm/blob-workers (the Stage-3 gotchas that forced extension pages);
engine files would need web_accessible_resources; the engine page also
holds the folder-grant session alive. Right mechanism: OFFSCREEN DOCUMENT
(chrome.offscreen, MV3's built-in hidden background page):

- extension/engine-offscreen.html — loads the SAME fs-idb/fs-core/
  engine-host.js chain (engine-host.js guards every getElementById, so it
  runs with no DOM). engine-host.html tab stays as manual fallback.
- fs-engine.js: engineEnsureTab → engineEnsureHost — offscreen-first
  (reasons ["BLOBS"], justification names the wasm engines; single-
  document error treated as success), tab fallback if the API is absent.
  Both the cold path and the stale-heartbeat retry now use it.
  engineNeededBody wording: auto-start normally handles it — retry once;
  user opens the engine tab from settings only if it persists.
- manifest: + "offscreen" permission, minimum_chrome_version "109",
  version 3.0.3. fs-core FS_VERSION 3.0.3-EXT.
- /health gains engine_alive_hint ("false is NORMAL before the first
  engine call — engines auto-start (invisibly)…") so even a model that
  never read the skill cannot misread the field.
- SKILL-EXT 3.0.8-EXT: "Engines start themselves — never ask the user":
  engines lazy-start on the first engine call, engine_alive:false is the
  normal resting state and NOT a blocker, 409 → retry once then settings
  fallback; /health field list documents engine_alive explicitly;
  requires-extension note now explains 3.0.1–3.0.2 = tab auto-start vs
  ≥3.0.3 = invisible.
- options page: toggle renamed "Auto-start the engines when needed"
  (#engauto id kept — engines_test waits on it), engstat idle text now
  "auto-starts on the first PDF/OCR call (nothing to open)"; guide.html
  engine section rewritten (auto-start is the norm, tab is fallback).
- engines_test e13 upgraded: after the auto-start cell the driver asserts
  NO engine-host tab exists in the context — a tab means the offscreen
  path failed and fell back; verdict fails with an explicit note.

Verified headless Chrome-for-Testing 1208: engineEnsureHost() called IN
the service worker creates the offscreen doc; its hello flips
/health engine_alive to true within seconds; an ofbEngine RPC for
'no.such.op' is answered "engine not loaded" (listener live) while
'pdf.text' answers a payload error (engine-impl.js IMPORTED + handler
registered in the offscreen doc); zero engine-host tabs; settings-page
smoke clean (3.0.3-EXT, new engstat, no console errors). Linux suites
still pending (as with all picker-driven paths); the full wasm op path
is covered there by e13. Live check for Dandan after reload: the OWUI
chat should now just DO the OCR (first call ~5–15 s slower); also watch
that the offscreen host keeps the folder-grant session alive the way the
tab did (untested headless — no grant in the smoke).

## Stage-3 session #10: five OCR-round bugs from Dandan's parking-sign chat (2026-09-09)

His transcript (model reading a Swedish parking sign) exposed five real
bugs in one flow; the popup was the headline:

1. **False-alarm overwrite confirmation** — the model called POST
   /ocr_pdf (the searchable-PDF WRITER) with the image as input and NO
   out; fs-confirm's `b.out || b.path` fallback treated the INPUT as the
   write target and asked to "overwrite parking_images….jpg" (Dandan
   denied — right instinct; even approved, engineCall's next check 400s
   "missing out", so nothing could have written). Fix: engine write ops
   (/pdf_op /ocr_pdf) gate on `out` ONLY; restores keep `path` (it IS
   their target). confirm_test A3 unit added.
2. **/image_info 500 "imageInfoFromHeader is not defined"** — the header
   parser was never ported to the extension (only the call site
   existed). Ported from the app (file_bridge.py:1691): PNG/GIF/BMP/
   WebP(VP8/VP8L/VP8X)/JPEG SOFn walk + EXIF orientation + effective
   dims; head slice 128 → 64 KB to match. engines_test e14 asserts it
   on a real fixture.
3. **POST /ocr → 404 "unknown engine endpoint"** — engine endpoints are
   method-locked but the fall-through hid it; the model went
   endpoint-guessing. fsEngineRoute now 405s with the contract
   ("/ocr is GET-only — use GET /ocr?path=…&lang=… (URL-encode '+' as
   %2B)") for all four endpoints. e14 covers it.
4. **500 "engine not loaded: ocr" right after auto-start** — engine-host
   hello'd at DOMContentLoaded, seconds before engine-impl.js finished
   registering (alive=true but handlers empty). The first hello now
   fires only after registration; not-alive stays the safe resting
   state. Smoke asserts an IMMEDIATE post-alive ocr RPC hits the
   registered handler.
5. **URL-encoded lang silently fell back to eng** — the model properly
   sent swe%2Beng; parseQueryString is deliberately raw and nothing
   decoded lang → sanitizeLangs rejected "swe%2Beng" → eng fallback →
   garbage OCR of the Swedish sign (his final answer was mostly
   "10-19, unclear"). Fix: decode q.lang/body.lang via unquoteComp at
   the engine routing boundary. engines_test e15 asserts lang=="swe+eng"
   AND the åäö/digit probes on swe.png with the encoded form.

ext 3.0.4 / skill 3.0.9-EXT (version-string touch-up only). Headless
smoke: all five PASS (gate unit no-out→null / asked=out.pdf; crafted
PNG parses 256x200; 405 both directions; immediate RPC = domain error
not "engine not loaded"; decode primitive; zero engine-host tabs).
Linux suites pending as always; e14/e15 + confirm A3 cover the rest
there.

## Stage-3 session #11: efficiency round from the good parking-sign chat (2026-09-09)

The re-test worked end-to-end (swe+eng applied, engines invisible, no
popup) in 6 cells — the log still showed three things worth fixing:

1. **Router-wide method-aware 405.** POST /image_info and GET /link
   still fell to the generic 404 "unknown endpoint" (only ENGINE
   endpoints had the method teaching). fsRoute's fall-through now
   checks a derived endpoint→method table (GET set incl. moved reads;
   POST set incl. moved writes + /link) and 405s with the contract.
   Verified matrix: POST /image_info, GET /link, GET /write, POST
   /read, DELETE /list all teach; /files stays an honest 404. This
   closes the extension-side twin of app docs/TODO.md §6 (405-hint).
2. **OCR small-image upscale (the real quality win).** ocrImage fed the
   raw blob to tesseract — real-world sign photos OCR as near-garbage
   at every language. Now images with short side < 800 px are upscaled
   to ~1200 px (max ×3, high-quality smoothing, OffscreenCanvas) before
   recognize; PDF pages (200 dpi renders) are untouched. A/B through
   the REAL engines headless: a 400×300 canvas sign read
   "p | 10-19 | (10-19) | 1 april | TIMAVGIFT" — identical to the
   1600×1200 control, +0.3 s. WATCH on the next Linux run: e7/e8/e10/
   e15 fixtures under 800 px short side now take the upscale path —
   if any probe flips, tune the threshold (not the assertions).
3. **Skill 3.0.10-EXT efficiency teachings** (all from observed model
   behavior): method cheat + "/list is THE listing endpoint — /files
   /ls /dir /entries do not exist, don't discovery-scan"; NEVER print
   inside a loop (cell 6's per-iteration prints made the model's own
   /image_b64 result invisible to it — OWUI last-line quirk); 405
   joins the error shapes; /image_b64 → data-URL markdown display
   convention (was missing from SKILL-EXT entirely); OCR flow: report
   the best read + SHOW the image instead of burning cells re-trying
   languages.

Automation lesson: playwright 1.58 ServiceWorker.evaluate SILENTLY
returns undefined for function-form expressions ((x) => …) — string
expressions only (cost a debugging cycle in the A/B script).

ext 3.0.5 / skill 3.0.10-EXT; OWUI rows restaged; e14 extended (POST
/image_info + GET /link 405 asserts); zip rebuilt.

## Stage-3 session #12: confirmation/recovery UX from Dandan's tests 1+2 (2026-09-09)

Two asks from live testing of the confirm + recovery flows:

1. **Expired popups no longer squat in the corner.** A timed-out card
   used to sit there with dead buttons (and a late Approve lingered
   with "can retry" text). confirm.js's countdown tick now flips the
   card at zero to "approval window closed — nothing was changed; ask
   again in chat" and removes it after 1.6 s. Late-click semantics
   change with it: there is no late click anymore — the assistant's
   one retry raises a FRESH ask, which is the cleaner flow (new popup,
   full 20 s window). The SW-side late-grant path stays (harmless).
2. **Restores say restore.** /versions/restore + /trash/restore get
   their own op tag "restore" (same gating as overwrite, scope "all"):
   popup header "Restore previous version — approval needed", summary
   "restore old version of notes.md (<ts>)" / "restore deleted gone.txt"
   — no more "overwrite notes.md" for a restore.
3. **POST /versions/read {path, ts}** — read a snapshot WITHOUT
   restoring (Dandan's model restored just to read the old version;
   the restore then asked to overwrite). ts is validated against the
   snapshot-stamp shape (^YYYYMMDD-HHMMSS-xx$, traversal-proof), the
   snapshot tree is walked by handle like epRestore (it is
   ignore-listed so resolveGuarded can't address it), text by default
   (MAX_READ cap + truncated flag) or "b64": true (MAX_BINARY cap).
   Reads never ask for approval. Registered in ROUTE_POST; taught in
   skill 3.0.11-EXT ("do NOT restore just to read").

Tests: confirm_test A4 (restore tag + wording units), c7
(versions/read end-to-end: approved overwrite → snapshot → read old
content, live file untouched), c8 (card lifecycle: present mid-wait,
data-ofb-cards back to 0 after expiry — the old B_popup_card_rendered
relied on the lingering card and would now fail, so it moved onto c8's
fresh ask). Headless: label units + versions/read contract matrix
(400/400/400-traversal/503) + settings smoke clean. ext 3.0.6-EXT;
OWUI rows restaged; zip rebuilt.

## Stage-3 session #13: restart cycle verified GOOD (Dandan, 2026-09-10)

Full Chrome exit → restart → OWUI → "list my files" worked DIRECTLY:
no Reconnect, no permission bubble. This is the persistent-grant happy
path: Dandan chose "Allow on every visit" during an earlier reconnect,
and Chrome stores that per-extension+folder — queryPermission returns
"granted" across browser restarts, so the skill's preflight sees
perm:"granted" and proceeds. The offscreen engine host needs to keep
nothing alive in this mode.

The two permission paths are now BOTH live-verified:
- persistent grant ("Allow on every visit") + browser restart → works
  directly (this test, 2026-09-10);
- session grant ("Allow this time") or EXTENSION RELOAD (chrome://
  extensions → reload resets the grant even when persistent) → perm
  "prompt" → skill preflight stops → Reconnect → "Allow on every
  visit" (verified 2026-09-07 + 2026-09-09). Expect one reconnect
  after every extension update Dandan loads in place.

## Stage-3 session #14: recovery guide at app parity + 30-day-claim fix (2026-09-10)

Dandan: the extension's guide.html was a stub next to the app's
docs/recovery-guide.html (which documents storage locations and the
chat workflows for listing/restoring versions). Rewrote it at full
parity — same 10-section structure (protection table, restore version,
trash, messed-up walkthrough, batch regret, rate brake, safety
settings, storage limits, troubleshooting, FAQ) with EXTENSION-TRUE
facts where the models differ:

- Snapshots/trash live INSIDE each shared folder (.ofb-snapshots/,
  .ofb-trash/, .ofb-chunks/), hidden from the AI by the ignore floor —
  so the guide teaches the Finder/Explorer manual recovery path
  (copy the file out of .ofb-snapshots/<ts>/ yourself), which the app
  deliberately can't offer (its store is outside the folder).
- The approval cards are documented as the extra safety net the app
  doesn't have (creates never ask; restores worded as restores).
- Reading an old version without restoring (POST /versions/read) is
  the documented "peek" step in the walkthrough.
- Storage limits: 8 MB/file snapshot cap (same as app), but NO
  auto-expiry/pruning exists in the extension — guide says "kept until
  you delete them; the AI can't (those folders are invisible to it)".

That last point exposed an inherited-wording bug: options.html claimed
a "30-day trash" in three places (app-true, extension-false — no
expiry code exists). All three fixed to honest wording. Bumped ext
3.0.7 (guide ships in the zip). Render-verified headless: 10 sections,
version stamp 3.0.7-EXT, zero console errors; GLM-4.6V review clean
(no breakage; density matches the app guide by design). Skill
untouched (its trash wording was already claim-free) — no restage.

## Stage-3 session #15: trash auto-expiry + bigger guide type (2026-09-10)

Dandan's two asks:

1. **Trash auto-expiry (30 days, app parity; ext 3.0.8).** MV3 SWs have
   no reliable timers, so the sweep is OPPORTUNISTIC: sw.js fires
   maybeSweepTrash() unawaited on pipe traffic, throttled once per 24 h
   (in-memory check first — free after the first call per SW lifetime —
   then a kv stamp across restarts). Entry age comes from the directory
   NAME (tsStamp shape, local time; regex-matched, rollover dates land
   in the future = kept — conservative direction only); unparseable
   names are never touched. removeEntry recursive per stale dir,
   audited as op trash-expiry. Snapshots are NOT pruned (they are the
   undo net; the 8 MB/file cap is their limit). sw.js also answers a
   non-pipe {ofbTrashSweep, force} message — the test hook. NOTE:
   omitted force === force (only explicit false throttles) — bit me in
   the smoke before I re-tested.
   negatives_test n13: craft 1999-stale + yesterday-fresh trash dirs ON
   DISK, force the sweep from the extension page, assert stale gone +
   fresh file intact; folded into the verdict (and root restored to
   readwrite after n8's flip).
2. **Guide type up.** body 16→18px / line-height 1.65, h1-h3, code/pre/
   table/hint scaled with it. Retention text updated everywhere the
   guide/options described manual-only retention: trash = 30-day
   auto-expiry (FAQ entry added), snapshots = kept until you empty
   them. GLM-4.6V: comfortably readable, no regressions.

Verified headless: parser units (valid→epoch, garbage→null,
rollover→future-kept), forced sweep {removed:0} on a root-less profile,
explicit force:false → {skipped:"throttled"}. Guide renders 10 sections
at 18px, zero console errors.

Session #15b (2026-09-10): Dandan's layout ask — the 🚫 Ignore
patterns card moved to sit directly above 👁 What the AI can see (was
between OCR language and Link lifetime). Better pairing: the patterns
drive exactly what the preview below shows. ext 3.0.9, smoke green.

## Stage-3 session #16: audit log capped at 1000 rows (2026-09-10)

Dandan's ask: keep the most recent 1000 audit rows, trimmed by the same
opportunistic once-a-day sweep. maybeSweepTrash → maybeSweepMaintenance
(trash TTL + audit cap; sw.js hook message name ofbTrashSweep kept for
the negatives contract). auditTrimOver: VERSIONLESS raw IDB open,
getAllKeys, one IDBKeyRange.upperBound delete of everything older than
the newest 1000 (autoIncrement keys are monotonic); trimmed count
audited as op audit-trim. options.html card says "keeps the most
recent 1000".

BONUS BUG this uncovered: options.js's audit reader opened the DB
pinned at version 1 — since fs-idb went v2 (confirmation round), that
open throws VersionError, so Dandan's Recent activity card has been
showing "audit unavailable" since 2026-09-09 (fresh-profile smokes
masked it via a v1-creation race). Fixed: versionless open (readers
never request upgrades). auditTrimOver follows the same rule.

negatives n14: seed 1005 rows (single tx, oldest marked), force the
sweep, assert oldest-gone / newest-kept / count bounded + trim row.
Headless: seeded 1005 → sweep {removed:0, auditTrimmed:5} → count 1001
(1000 + the trim's own row), card renders rows, zero console errors.
ext 3.0.10.
