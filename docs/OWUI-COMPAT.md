# Open WebUI version compatibility

**Verified against: Open WebUI v0.11.1** (docker image
`ghcr.io/open-webui/open-webui:main`, 2026-08). This document defines
what we support, what to re-test on upgrade, and the known failure
modes when the compatibility assumptions break.

## Compatibility window

| Component | Depends on OWUI version via | Status |
|---|---|---|
| Pyodide Code Interpreter | default feature, still shipping | works on 0.11.1; officially "legacy" per OWUI docs — watch release notes |
| Pyodide sandbox host | WHERE the interpreter runs → request `Origin` | DRIFTED WITHIN 0.11.x: `:main` now uses a `sandbox="allow-scripts"` srcdoc iframe → `Origin: null` → tier-1 CORS-blocked (see next section) |
| Skills API (`/api/v1/skills/*`) | v1 REST surface | works on 0.11.1 (create, id access/update) |
| Model preset with code_interpreter | `meta.capabilities` + `meta.defaultFeatureIds` | works on 0.11.1 — THE regression risk |
| Browser fetch to `http://127.0.0.1:8765` | PNA behavior per browser | PNA itself is fine (bridge sends `Access-Control-Allow-Private-Network: true`); the CORS failure mode is the sandbox origin above, not PNA |

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

**Verified escape hatch: tier-2 pure token mode.** Configure ONLY the org
token, no allowed_origin:

```
POST /api/root {"token": {"generate": true}}     # loopback-only endpoint
```

With no origin set, the bridge echoes ACAO (`*` for null origins) and the
token carries auth. Probe-verified on the current build: **401** without
the header, **200 + working write flow** with `X-Bridge-Token`. The token
must then reach the model — the skill bootstrap block accepts a
`BRIDGE_HEADERS = {"X-Bridge-Token": "…"}` line (that is exactly what
`mm_smoke_strict.py` injects per run; `setup_owui.py` does NOT inject it —
see the note in its help/admin guide about distributing the token
yourself).

Note this changed WITHIN the 0.11.x line (the two-switch preset above
kept working) — exactly why the upgrade checklist now has an origin check.

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
6. If a Jupyter interpreter option appeared or Pyodide was demoted:
   STOP, document in DEVNOTES, decide Plan B timing (do not roll out).
