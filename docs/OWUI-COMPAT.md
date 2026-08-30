# Open WebUI version compatibility

**Verified against: Open WebUI v0.11.1** (`:main`, 2026-08) **and v0.10.2**
(pinned image, 2026-08-30: full setup + data-analysis chat smoke PASS).
This document defines what we support, what to re-test on upgrade, and the
known failure modes when the compatibility assumptions break.

## Compatibility window

| Component | Depends on OWUI version via | Status |
|---|---|---|
| Pyodide Code Interpreter | default feature, still shipping | works on 0.10.2 and 0.11.1; officially "legacy" per OWUI docs — watch release notes |
| Pyodide sandbox host | WHERE the interpreter runs → request `Origin` | `sandbox="allow-scripts"` srcdoc iframe on BOTH 0.10.2 and `:main` → `Origin: null` → tier-1 CORS-blocked; tier-2 token mode required (see next section) |
| Skills API (`/api/v1/skills/*`) | v1 REST surface | works on 0.10.2 and 0.11.1 (create, id access/update) |
| Model preset with code_interpreter | `meta.capabilities` + `meta.defaultFeatureIds` | works on 0.10.2 and 0.11.1 — THE regression risk |
| Browser fetch to `http://127.0.0.1:8765` | PNA behavior per browser | PNA itself is fine (bridge sends `Access-Control-Allow-Private-Network: true`); the CORS failure mode is the sandbox origin above, not PNA |
| Pyodide data stack (pandas/matplotlib) | OWUI's bundled pyodide-lock.json | BOTH lines ship it: 0.10.2 = Pyodide 0.28.3 (Python 3.13.2, pandas 2.3.1, matplotlib 3.8.4); `:main` = Python 3.14/abi 2026_0 (pandas 3.0.2, matplotlib 3.10.8) — micropip resolves per-line, nothing to configure |
| Images into MODEL input | does OWUI feed code/tool results back as images? | **NO on 0.11.1** — see "Vision input limitation" below |

**Support policy: current + one minor** — we treat the latest OWUI 0.11.x
and the 0.10.x line it descends from as supported; anything older or a
new 0.12+ needs the upgrade checklist below run once before rollout.

## THE two-switch preset (re-test on EVERY upgrade)

OWUI's frontend decides per-request whether the model may run code. Both
switches must be ON or the frontend silently sends
`features.code_interpreter: false` and the skill cannot reach the bridge:

```json
"meta": {
  "capabilities": { "code_interpreter": true },
  "defaultFeatureIds": ["code_interpreter"]
}
```

`setup_owui.py` sets both — but an OWUI upgrade can change the shape the
frontend reads (it has drifted before: `src/lib/components/chat/Chat.svelte`
~L1075 in 0.11.x). **Regression test after every upgrade:**

1. Log in, pick the "Local Files Assistant" preset, ask: *"list the files
   in my folder"*. The model must call `/list` and show real files.
2. If it answers without file access ("I don't have access to your
   files"), the preset lost a switch: open the model editor and verify
   BOTH `capabilities.code_interpreter` and `defaultFeatureIds` contain
   the interpreter; re-run `scripts/setup_owui.py` to recreate.
3. Check the OWUI changelog for "code interpreter" / "Pyodide" /
   "Jupyter" entries — Jupyter-mode interpreters do NOT run in the
   user's browser and break the localhost:8765 reachability assumption.
   If Pyodide mode is removed, the fallback path is Direct Tool
   connections (browser-direct calls, roadmap Plan B) — not Jupyter.

## Pyodide sandbox origin drift (the `Origin: null` CORS block)

**Discovered 2026-08-28 on the `:main` image (self-labeled 0.11.1).** OWUI
moved the Pyodide Code Interpreter into a `sandbox="allow-scripts"` srcdoc
iframe (`src/lib/pyodide/pyodideSandboxHost.ts` L210-215 in the owui-src
tree) — no `allow-same-origin`, so the iframe gets an **opaque origin**
and every bridge fetch arrives with `Origin: null`. The bridge's tier-1
origin lock emits CORS headers only on an exact origin match, so the
browser blocks the response: the bridge log shows 200s the page never
receives, and the browser console shows "No 'Access-Control-Allow-Origin'
header". A silent, confusing failure — the model-side code "works" while
the user gets nothing.

**Fixed in bridge 2.4+: token tier now covers opaque origins.** The
original escape hatch was token-ONLY mode (no `allowed_origin` configured
→ the bridge echoed `ACAO: *` for null origins). But the picker requires
an origin before file serving unlocks, so every real deployment runs
`token+origin` — where `Origin: null` requests got **no CORS headers at
all**: the preflight failed and the browser aborted the fetch before the
token was ever checked (`pyodide.http._exceptions.AbortError: Failed to
fetch` — found in real use 2026-08-29).

`_add_matching_cors` now grants opaque origins (`Origin: null`) CORS
whenever the token tier is active AND the request passed the auth gate
(public endpoints like `/health`, `/version`, `/wheels` and preflights
mark themselves authorized; token-check failures do not). The token still
gates every file request, so responses only become readable to callers
who know it; denials (bad/missing token) stay browser-unreadable.
Regression-tested in `tests/e2e_test.sh` (null-origin preflight granted,
null-origin GET readable, null-origin no-token denied + no CORS leak).
Token-only mode keeps working as before; the old token-only workaround is
no longer necessary.

(How the token reaches the model: the skill bootstrap block accepts a
`BRIDGE_HEADERS = {"X-Bridge-Token": "…"}` line — `setup_owui.py
--bridge-token` embeds it in the public skill; `mm_smoke_strict.py`
injects it per run.)

Note this changed WITHIN the 0.11.x line (the two-switch preset above
kept working) — exactly why the upgrade checklist now has an origin check.

## Vision input limitation (images into the model's context)

**Verified on 0.11.1 source (2026-08-29).** Code-interpreter output
reaches the model as **text only**. In `Chat.svelte`, `image_url`
content blocks are built exclusively from files the *user* attached to
their message; `message.code_executions` are display-only (rendered as
chips + modal via `CodeExecutions`/`CodeExecutionModal`, never copied
into `message.files` or the request messages). The pyodide sandbox's one
image convention is `print(f"data:image/png;base64,…")` (its matplotlib
patch) — for SHOWING the user via markdown echo, not for model input.

Consequences for the bridge:
- `/image_b64` (data URLs) and `/pdf_text?mode=images` can display
  images in chat, but a vision model cannot literally "see" local files
  through them. The skill teaches: ask the user to ATTACH the image to
  their message — that is the only input path vision models consume.
- A server-side OWUI function could attach bridge images mid-chat, but
  that routes file bytes through the server — rejected (violates the
  zero-server-file-handling architecture).

**Re-test on OWUI upgrade:** if a newer OWUI parses data URLs from code
output into multimodal input (some agent frameworks do), `/image_b64`
already emits the right format — one skill-text update would enable it.

## Skills API surface we rely on

| Call | Endpoint | Notes |
|---|---|---|
| Create/update skill | `POST /api/v1/skills/create` | id required; setup script is idempotent |
| Public grant | `POST /api/v1/skills/id/{id}/access/update` | body `[{"principal_type":"user","principal_id":"*","permission":"read"}]` — bare `{"type":"public"}` is silently dropped |
| Create preset | `POST /api/v1/models/create` | NOT `/model/new` |
| List presets (existence check) | `GET /api/v1/models/export` | `/api/v1/models/` returns the SPA's HTML catch-all |
| Update preset | `POST /api/v1/models/model/update` | — |
| OpenAI connection | `POST /openai/config/update` | NOT under `/api/v1/` |

Any of these moving in a release = `setup_owui.py` needs a patch before
that version is supported.

## Pyodide data-stack packages (numpy / pandas / matplotlib)

Since skill 2.8 the skill text instructs the model to
`micropip.install(["pandas", "matplotlib"])` for tabular analysis. These are
COMPILED packages: micropip resolves them against the pyodide-lock.json that
OWUI itself serves (`${origin}/pyodide/`), so they always match the running
interpreter's Python/ABI — verified on the 2026-08 `:main` image (Python
3.14.0 / emscripten 5.0.3 / abi 2026_0; numpy 2.4.3, pandas 3.0.2,
matplotlib 3.10.8, scipy, statsmodels, scikit-learn all present, CORS `*`).

**The bridge's `/wheels` deliberately does NOT carry these.** Rule of thumb:
`py3-none-any` (pure Python: openpyxl, python-docx, fpdf2, …) → bridge-served,
version-agnostic; `*-wasm32` (compiled) → Pyodide-lock-resolved, ABI-exact.
A wasm wheel from the wrong Pyodide generation fails at import with a
confusing `ModuleNotFoundError`, not a version error — don't ship them.

Upgrade check: after an OWUI bump, `curl <owui>/pyodide/pyodide-lock.json`
and confirm `pandas`/`matplotlib` are still in `packages` (one line of
python; also re-run one data-analysis chat smoke).

## Upgrade checklist (run once per new OWUI minor)

1. Snapshot the test stack: `docker exec owui-test ...` or just note the
   volume name (`owui-test-data`) — accounts, skill, preset persist
   across image bumps.
2. Pull new image, recreate `owui-test` container (see
   `scripts/rebuild_testenv.sh --help`; it pins nothing — uses `:main`).
3. **Two-switch check** (section above) — the one that actually breaks.
4. **Sandbox-origin check** (section above): run one chat that calls the
   bridge; watch the browser console for "No 'Access-Control-Allow-Origin'
   header" while the bridge log shows 200s — that signature means the
   interpreter moved again. Also grep the new OWUI source for the sandbox
   host (`src/lib/pyodide/pyodideSandboxHost.ts`): if the iframe regains
   `allow-same-origin`, tier-1 origin mode works again and is preferable
   to token mode; if a new sandbox shape appears, re-verify tier 2.
5. Full chat round-trip: $-mention the skill → model runs Python →
   `/list` + `/read` + one write with confirmation round-trip.
6. Data-stack check: `curl <owui>/pyodide/pyodide-lock.json` still lists
   pandas/matplotlib (see the section above); run one data-analysis chat
   (xlsx → pandas → chart via `/image_b64`).
7. If a Jupyter interpreter option appeared or Pyodide was demoted:
   STOP, document in DEVNOTES, decide Plan B timing (do not roll out).
