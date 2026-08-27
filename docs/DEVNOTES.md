# DEVNOTES — environment quirks & pitfalls (dpc)

Living document for anyone (human or agent) implementing the roadmap.
Add every new gotcha here, not to memory.

## Test environment

- **One-shot rebuild**: `bash scripts/rebuild_testenv.sh` (OWUI container +
  fixtures + model connection + skill/preset). `--no-owui` skips the docker
  part. Idempotent.
- OWUI test instance: docker `owui-test` on `127.0.0.1:8788`,
  admin@test.local / test-admin-pass-123. Image `ghcr.io/open-webui/open-webui:main`
  (v0.11.x). Volume `owui-test-data` persists accounts/skill/preset across
  container restarts, NOT across `docker rm` + fresh volume.
- Model backend: Z.AI coding endpoint `https://api.z.ai/api/coding/paas/v4`
  (NOT the /api/paas/v4 one — that 429s with this key). Key from
  `~/.hermes/.env` `GLM_API_KEY=…` (line appears twice; head -1).
- **glm-5.3-flash is the test model** (fast/cheap tier); glm-5.3 for
  final E2E sanity.

## Bridge runtime quirks (learned the hard way)

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
- tessdata there has 10 langs incl swe/chi_sim (we added). Repo bundle:
  `src/tessdata/` = eng swe chi_sim osd only.
- No system tesseract, no sudo — NEVER `apt install`; use the persistent copy.

## Pyodide/browser testing

- Playwright chromium:
  `~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`
  (pip playwright lives in the ComfyUI venv — just `python3` works).
- Cross-origin test page server: `python3 -m http.server 8899 --bind
  192.168.68.62` from a dir containing `test_page.html` (page loads Pyodide
  0.26.4 from jsdelivr; `--allow-local-network-access` flag needed).
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

## Session handoff

- Repo: `~/workspace/owui-file-bridge` (git, 3 research docs + roadmap).
  Commits use `user.name="Dandan Wei" user.email="chopper.ddw@gmail.com"`.
- gh CLI token EXPIRED (push blocked; SSH key works once repo exists on
  github.com). Don't burn time on push; local commits accumulate.
- Roadmap: `docs/ROADMAP.md` — P0 security first, P0b scope/accident, then
  P1 reads. Reference index at top maps every item to exact source files.
