# Open File Bridge — Browser Extension Plan

Status: PLAN (approved by Dandan 2026-09-05) — implementation to run in a fresh
session from branch `feat/browser-extension`.

Purpose: make OFB work with **stock, unpatched Open WebUI on any origin**
(public HTTPS included), by moving the localhost fetch from OWUI's sandboxed
Pyodide iframe into a browser extension that has legitimate, user-consented
loopback access.

---

## 1. The problem this solves (verified 2026-09-05)

- OWUI's Pyodide interpreter runs in a `sandbox="allow-scripts"` srcdoc iframe
  (`src/lib/pyodide/pyodideSandboxHost.ts`, byte-identical v0.10.2 → v0.11.3 →
  `main`). Opaque origin (`Origin: null`) on every fetch.
- Chrome's Local Network Access (LNA) permission
  (WICG `local-network-access` spec, Aug 2026 draft) gates **public → local/
  loopback** requests. The permission is policy-controlled
  (`local-network` / `loopback-network`, alias `local-network-access`) with
  default allowlist `'self'` — an opaque-origin iframe NEVER matches, so the
  embedder would have to delegate via an iframe `allow` attribute, which OWUI
  deliberately does not ship.
- Upstream position (issue open-webui#29671, PRs #29672/#29675/#29676, all
  closed 2026-09-04): the sandbox being cut off from localhost is **working as
  intended** (model-generated code must not reach the user's machine/LAN).
  Do NOT refile. Their alternative (server-side Open Terminal / Tools) defeats
  OFB's core promise (files never touch the server).
- Where the current bridge architecture stands:
  - Intranet/RFC1918-hosted OWUI (page served from 10.x/192.168.x): works
    forever — Chromium does not gate local→loopback (spec §2.2 note). The
    browser classifies by the RESPONSE IP stamped into the document's policy
    container, not by hostname.
  - Public-HTTPS-hosted OWUI (Cloud Run `.run.app` etc.): browser-Pyodide →
    `127.0.0.1:8765` is blocked. Workaround today = patched OWUI bundle
    (add iframe `allow` attribute), which must be re-applied on every image
    update. Patch preserved at `~/backups/owui-lna-patch/`.

The extension removes the need for any OWUI customization.

## 2. Why an extension is the right shape

- Extension service workers are **exempt from same-origin policy** for hosts in
  `host_permissions` (Chrome docs: "Cross-origin network requests"). A fetch to
  `http://127.0.0.1:8765` from the extension's service worker is a first-class
  request: no CORS, no opaque iframe, no permission delegation.
- Consent model upgrades from "site permission" to **installed capability**
  (same trust class as Docker Desktop / VS Code extensions) — defensible, and
  it makes the egress boundary deterministic (we enforce scope in code the
  model cannot influence).
- Works with stock OWUI on ANY origin — the maintainer's stance becomes
  irrelevant to our deployment story.

## 3. Architecture — Stage 1 (the spike target)

```
Pyodide sandbox iframe (opaque origin, model code)
   │  postMessage (allowed cross-origin)          ← THE critical risk, see §4
   ▼
OWUI page (content script injected by extension)
   │  chrome.runtime.sendMessage
   ▼
Extension service worker (MV3)
   │  fetch http://127.0.0.1:8765  (host_permissions)
   ▼
Open File Bridge app (UNCHANGED: token auth, path sandbox, write caps)
```

- Bridge app: **zero changes**. Extension attaches the tier-2 token itself.
- OWUI: zero changes. Skill recipe gets a transport swap (see §5).

### Manifest sketch (MV3)

```jsonc
{
  "manifest_version": 3,
  "name": "Open File Bridge Connector",
  "version": "0.1.0",
  "permissions": [],                          // no tabs/browsingData etc.
  "host_permissions": ["http://127.0.0.1:8765/"],
  "background": { "service_worker": "sw.js" },
  "content_scripts": [{
    "matches": ["https://*/*", "http://*/*"],  // narrow later (see §7 Q2)
    "js": ["relay.js"], "run_at": "document_idle"
  }],
  "externally_connectable": { "matches": ["https://*/*"] }
}
```

### Service-worker security invariants (non-negotiable)

1. **Narrow pipe, never a general fetch proxy.** SW accepts only messages of
   shape `{ofb: true, id, method, path, body}` and builds
   `fetch("http://127.0.0.1:8765" + path)` — scheme/host/port HARDCODED.
   Any other host, scheme, or message shape → reject.
2. Token lives in SW storage (`chrome.storage.local`, set once via options/
   first-run); attached as `X-Bridge-Token` by the SW. Model code never sees
   it. (This also retires the org-token-in-skill-body pattern for extension
   users.)
3. The sandbox iframe CAN postMessage to the page — assume hostile senders.
   The page-side relay must accept messages only for the OFB pipe, correlate
   by request id, and rate-limit (e.g. ≤30 in-flight, payload cap ~10 MB) so
   injected instructions cannot turn the relay into a scanner. The bridge's
   own gates (tier-2 401s, write caps) remain the inner defense.
4. No extension UI in a toolbar popup — see PWA rule (§6).

## 4. Critical technical risk (prove FIRST)

**Can model code in the sandbox iframe talk to the page relay?**

The iframe has no DOM access to the parent (no `allow-same-origin`), but
`postMessage` works cross-origin. OWUI's own sandbox script already uses
`parent.postMessage(...)`. Expected path for model code:

```python
# inside Pyodide (runPythonAsync) — to be proven in the spike
from js import parent
from pyodide.ffi import to_js
parent.postMessage(to_js({"ofb": True, "id": 1, "method": "GET",
                          "path": "/health"}), "*")
# response: page relay replies to iframe.contentWindow; a bootstrap listener
# (installed by the skill's first cell) resolves a Future by id
```

Open sub-questions the spike must answer:
- Does `from js import parent` resolve in Pyodide's sandbox context, and can
  WASM code register a `message` listener (via `create_proxy`) that coexists
  with OWUI's own listener?
- Async round-trip: promise/Future bridging from iframe JS event into
  `runPythonAsync` awaiting code (pyodide can await JS promises; a manual
  Future + listener should work — prove it).
- Fallback if `js.parent` is unavailable: skill bootstrap uses
  `pyodide.http.pyfetch` ONLY for same-host assets, and the page relay polls…
  (fallback design only if the primary fails — do not build speculatively).

## 5. Skill / model-recipe changes

Current recipe: `pyfetch("http://127.0.0.1:8765/...")` with BRIDGE_HEADERS.
Extension transport: a small bootstrap cell defines `ofb_fetch(method, path,
body=None)` that does the postMessage round-trip; skill variants get an
"Extension mode" preamble that swaps the transport and keeps everything else
(endpoints, JSON shapes, strict rules) identical. Ship as SKILL-EXT.md or a
conditional block — decide during implementation. No bridge-version coupling:
extension mode still speaks the same v2 HTTP API.

## 6. Browser support matrix (verified 2026-09-05)

- **Chrome / Edge (Chromium): full support.** Same MV3, same SW behavior, LNA
  rollout applies to both. Edge installs from Chrome Web Store.
- **Firefox: portable** (~90%): WebExtension APIs match (host permissions,
  native messaging, content scripts); MV3 background is an event page, minor
  shims only.
- **Safari: unsupported (platform-level).** WebKit blocks localhost fetches
  from HTTPS pages entirely; no LNA permission exists. Same exclusion as the
  current bridge docs — no regression.
- **Installed PWAs ("Create shortcut / Install" app windows): supported IF the
  extension is UI-less.** Content scripts still inject (URL-matched) and
  page↔extension messaging works, but there is NO toolbar/popup in an app
  window → all UX must live in the page (injected panel) or the bridge app.
  Add "installed-PWA window" as an explicit spike test case (historically
  buggy corner; verify, don't assume).

## 7. Open questions (to resolve during implementation)

1. Does Chrome's full LNA rollout eventually gate extension-origin loopback
   fetches too? (Today: no. Empirically re-verify in the spike via the public
   tunnel — this is exactly the environment where site-level LNA fires.)
2. `content_scripts.matches` scope: broad (`https://*/*`) vs requiring users
   to pin their OWUI origin. Broad match + zero page-visible behavior is
   common (password managers), but CWS review prefers narrow. Decide with the
   options page.
3. Response size cap + streaming for big files (bridge caps ~50 KB advice for
   reads stands; /image_b64 flows already chunked by design).
4. Native messaging host (Stage 2): registration per browser family
   (Chrome/Edge separate registry keys), install story alongside the
   bridge app installers.

## 8. Stage 2 / Stage 3 (outlines, do not build in the spike)

- **Stage 2 — native messaging host**: extension launches the bridge binary on
  demand (Chrome spawns registered host when connecting; kills it when the
  last port disconnects). No resident port, no autostart entry. Docs:
  Chrome "Native messaging" (host manifests, `allowed_origins` pinned to the
  extension id, 1 MB message framing).
- **Stage 3 — serverless mode**: extension page calls `showDirectoryPicker()`
  (File System Access API) for a persistent user-chosen folder; real
  read/write with no local server at all. Would shrink the product to the
  extension + a thin FS adapter implementing the same message protocol.

## 9. Spike verification plan (dpc, half a day)

Environment facts (2026-09-05): `owui-test` container (0.11.3) running at
127.0.0.1:8788; bridge master = v2.10.0; playwright headless shell at
`~/.cache/ms-playwright/chromium_headless_shell-*/` (use explicit
`executable_path`, `uv run --with playwright`).

1. Build the minimal extension (manifest + sw.js + relay.js, ~200 lines).
2. Expose owui-test through a **public https origin** (cloudflared quick
   tunnel → `*.trycloudflare.com`, no account) so the LNA gate actually fires
   — this reproduces the Cloud Run condition locally.
3. Run the real chat path: skill-preset model → Pyodide code → `js.parent`
   postMessage → relay → SW → bridge 127.0.0.1:8765 (source run, port free —
   check `ss -tln | grep 8765`, stray-kill rule with `file_bridg[e]` pattern).
4. Positive: /health, /list, /read, /write round-trip in-chat.
5. Negative: SW rejects non-OFB message shapes; hardcoded host refuses a
   second port even if the relay is asked; no token → 401 (tier-2 intact).
6. PWA window: install owui-test as app window in headed Chromium, rerun 4.
7. Record findings in this file (§4 answers, §7 decisions) + DEVNOTES.

## 10. Distribution notes

- Chrome Web Store for public users; unpacked/bundled load for corporate
  internal deployments (no store dependency). Firefox AMO later.
- Keep ALL public-repo hygiene rules (no employer names anywhere; safe
  phrasing "corporate-hosted").
