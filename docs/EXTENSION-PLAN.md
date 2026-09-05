# Open File Bridge — Browser Extension Plan

Status: **SPIKE COMPLETE** (sessions 1–3, 2026-09-05/06) — every verification
step GREEN; answers in §4, decisions in §5/§7, checklist in §9. Artifacts on
this branch: `extension/` (manifest + sw.js + relay.js + options),
`tests/extension_e2e.py` (real-extension e2e runner),
`skill/open-file-bridge/SKILL-EXT.md` (the transport-swap skill variant).
Stage 2 (native messaging host) not started.

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

### ANSWER (spike, 2026-09-05/06): PROVEN — fallback NOT needed

- `from js import parent` resolves in the sandbox, and WASM-registered
  `message` listeners (via `create_proxy`) coexist with OWUI's own.
- The async bridge works exactly as hoped: `loop.create_future()` resolved
  from the JS event listener; the awaited event's `.data.to_py()` is the
  correlated reply dict.
- Proven in three escalating layers: (1) harness sandboxed-iframe Pyodide
  using OWUI's own Python 3.14 build from owui-test `/pyodide/` — sender
  confirmed `Origin: null` (opaque) throughout; (2) the REAL extension
  end-to-end: /health, /list, /read, /write + readback, /state all 200
  through relay.js → sw.js with the token set via the real options page;
  token-leak sniff 0/10 page-visible messages; (3) from a PUBLIC https
  origin (trycloudflare tunnel) where direct pyfetch is LNA-blocked.
- Mechanics notes for posterity: OWUI's pyodide.js has no ESM named export
  (dynamic `import()` in a classic script, then `globalThis.loadPyodide`);
  `<script type="module">` inside a srcdoc sandbox never executes; set
  `iframe.srcdoc` BEFORE appendChild or inline scripts silently never run.
  Full detail: the project skill's extension-spike reference.

## 5. Skill / model-recipe changes

Current recipe: `pyfetch("http://127.0.0.1:8765/...")` with BRIDGE_HEADERS.
Extension transport: a small bootstrap cell defines `ofb_fetch(method, path,
body=None)` that does the postMessage round-trip; skill variants get an
"Extension mode" preamble that swaps the transport and keeps everything else
(endpoints, JSON shapes, strict rules) identical. Ship as SKILL-EXT.md or a
conditional block — decide during implementation. No bridge-version coupling:
extension mode still speaks the same v2 HTTP API.

### DECISION (spike): shipped as `skill/open-file-bridge/SKILL-EXT.md`

- Self-contained variant, versioned `2.10-EXT` (kept OUT of the main variant
  numbering until `setup_owui.py` learns to publish it — wiring it up is
  follow-up work; until then admins publish SKILL-EXT.md manually).
- Same `bridge_get`/`bridge_post` signatures as the standard skill — every
  recipe transfers unchanged. `BRIDGE_HEADERS` is RETIRED in this variant:
  the tier-2 token lives in `chrome.storage.local` and the service worker
  attaches it; model code never sees it (so the org-token-in-skill-body
  pattern is retired for extension users too).
- Binary path: requests may carry `b64: true` → SW returns `{bodyB64}`;
  `ofb_fetch_b64` decodes. Wheel installs: pure-Python wheels b64-fetched
  from the bridge and `zipfile.extractall(sysconfig purelib)` — micropip is
  NOT used for bridge-served wheels (it cannot fetch localhost in the
  sandbox); compiled data-stack wheels still via micropip from the OWUI
  origin (unaffected by the gate). Verified: 250,910-byte openpyxl wheel →
  `import openpyxl` 3.1.5 → real xlsx via /write_b64 → /stat 200.

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
  VERIFIED in the spike (2026-09-05, headed Chromium `--app=` window, Xvfb
  :99): all cells pass incl. write+readback — the assumption held.

## 7. Open questions — RESOLVED by the spike

1. **Does the full LNA rollout gate extension-SW loopback fetches?**
   **NO — verified empirically (2026-09-05, Chrome for Testing 151).** From a
   public https origin (trycloudflare quick tunnel in front of owui-test):
   the SAME page's direct `pyfetch("http://127.0.0.1:8765/health")` was
   blocked with console *"Permission was denied for this request to access
   the loopback address space"*, while the extension path round-tripped
   (401 without token → write+readback 200 with it). This is exactly the
   environment where site-level LNA fires — the spike's key result.
   Residual risk: Chrome could extend LNA to extension contexts in a future
   release; re-verify the tunnel cell on each Chromium major when the
   extension ships. Track via
   https://github.com/WICG/local-network-access — extension exemptions are
   not on any announced timeline.
2. **`content_scripts.matches` scope:** shipped BROAD (`https://*/*`) for the
   spike. The relay is UI-less and zero-page-visible, so broad match is
   defensible (password-manager pattern), but Chrome Web Store review prefers
   narrow. REVISIT before CWS submission — options: narrow to user-pinned
   origins via the options page, or keep broad + justify. Not a code change
   until CWS review feedback exists.
3. **Response size cap + streaming:** DONE via the `b64: true` flag — 64 MB
   response cap in the SW, 10 MB request cap; binary responses return as
   `bodyB64`. The ~50 KB read advice stands; /image_b64 flows already chunk.
4. **Native messaging host (Stage 2):** still open — see §8.

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

## 9. Spike verification plan — EXECUTED, ALL GREEN ✅

Environment (as it actually was): owui-test 0.11.3 @ 127.0.0.1:8788; bridge
from source, tier-2 token mode; full Chromium (Playwright build 1234,
`chrome-linux64/chrome`) — the headless shell cannot load extensions; public
origin via cloudflared quick tunnel; evidence in /tmp/ofb-ext/final-*.log +
bridge audit log (session history: 2026-09-05).

1. ✅ Minimal extension built (manifest + sw.js + relay.js + options, ~280
   lines) — manifest is NARROWER than the §3 sketch: `permissions:
   ["storage"]` only, NO `externally_connectable` (nothing uses it), relay
   on `https://*/*` (test copy in /tmp/ofb-ext/ext-test/ adds
   `http://127.0.0.1/*` for the local harness server).
2. ✅ owui-test exposed through public https (trycloudflare quick tunnel;
   tiny reverse proxy on :8899 to keep pyodide same-origin — an https page
   cannot load `http://127.0.0.1:8788/pyodide` (mixed content)).
3. ✅ Real chat path: OWUI's own Pyodide (Python 3.14, owui-test `/pyodide/`)
   → `js.parent` postMessage → relay → SW → bridge (§4).
4. ✅ Positives: /health, /list, /read, /write + readback, /state — all 200
   through the real extension pipe; token set via the REAL options page;
   token-leak sniff: 0/10 sniffed page-visible messages contain the token.
5. ✅ Negatives, all PASS:
   - non-OFB message shapes → ignored (no reply in 2 s);
   - path `//evil.com/x` → BRIDGE 404 — the destination stays hardcoded
     (`/evil.com/x` never leaves 127.0.0.1:8765);
   - port override `//evil.com:9/x` → SW pre-fetch refusal ("bad path" —
     no second port reachable even when the relay is asked);
   - foreign `url`/`port`/`host` fields in the message → dropped;
   - PUT → refused ("bad method": only GET/POST/DELETE pass the gate);
   - no token → 401 `missing or invalid bridge token` (tier-2 intact).
6. ✅ Rate limit: 200 rapid requests → exactly 120 ok / 80 rate-limited
   (relay cap 120/min; SW cap 30 in-flight).
7. ✅ Binary pipe: 250,910-byte openpyxl wheel via b64 → extracted to
   purelib → `import openpyxl` 3.1.5 → real xlsx via /write_b64 → /stat
   200 (unique filename — see gotcha below).
8. ✅ Public-tunnel key result: on the trycloudflare https origin, direct
   `pyfetch` to 127.0.0.1:8765 BLOCKED by Chrome LNA (console: "Permission
   was denied for this request to access the loopback address space");
   SAME page via the extension: 401-without-token → write+readback 200.
   §7 Q1 answered empirically: extension SW loopback fetches are NOT
   LNA-gated today.
9. ✅ PWA/app-window (headed :99, `--app=`): all cells pass incl.
   write+readback (§6 assumption verified).

Gotchas discovered while verifying (full list in the project skill's
extension-spike reference): Chromium caches the MV3 service worker in the
persistent profile — ALWAYS use a fresh profile dir per extension-test run
(edited sw.js + same profile = old code runs silently); reused test
filenames trip the bridge's /write 409 overwrite-confirmation gate (one
false FAIL in phase E — the fixed harness uses unique names per run, final
run green); page-side sniffing is blind to iframe-targeted replies —
instrument inside the iframe; content scripts skip file:// pages — serve
harnesses over http.

## 10. Distribution notes

- Chrome Web Store for public users; unpacked/bundled load for corporate
  internal deployments (no store dependency). Firefox AMO later.
- Keep ALL public-repo hygiene rules (no employer names anywhere; safe
  phrasing "corporate-hosted").

## 11. Stage 1 outcome — where things live (session 3, 2026-09-06)

- `extension/` — the verified extension (manifest.json, sw.js, relay.js,
  options.html/js). ~280 lines, zero dependencies.
- `tests/extension_e2e.py` — self-contained real-extension e2e runner
  (env-configurable: `OFB_EXT_E2E_DIR` scratch dir, `OFB_EXT_TOKEN`,
  `OFB_EXT_CHROME`; builds its own test manifest copy with the extra
  `http://127.0.0.1/*` match, serves harness pages over http, fresh
  profile per run). Phases a|c|d|e; tunnel/PWA cells were session-2
  one-offs (recipes in the project skill's extension-spike reference).
- `skill/open-file-bridge/SKILL-EXT.md` — extension-transport skill
  variant (2.10-EXT, manual publish; `setup_owui.py` wiring is follow-up
  work, see its header note).
- Harness builders and all spike evidence lived in `/tmp/ofb-ext/`
  (ephemeral, cleaned after session 3); the project skill's
  extension-spike reference carries the durable recipes.
- Stage 1 acceptance = every §9 cell green + docs/skill updated + both
  regression suites green. Stage 2 (native messaging) is a fresh plan.
