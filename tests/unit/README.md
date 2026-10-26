# Unit / behavioural checks (no Linux/Xvfb needed)

These cover the 2026-10-25 branch review findings F1–F5 and the
client/skill/injector consistency contract. They run on macOS and in CI.

| File | Covers | Run |
|---|---|---|
| `bridge_path_test.py` | F1 — `bridge_path` never re-anchors an explicit root; runs the REAL function from the client + both skill copies | `python3 tests/unit/bridge_path_test.py` |
| `skill_client_sync_test.py` | the shared helpers in `ofb-client.py` and both skill bootstraps must not drift | `python3 tests/unit/skill_client_sync_test.py` |
| `review_regressions.cjs` | F2/F5 (`/find` + `/list` root-qualified round-trip, truthful truncation), F3 (concurrent-move tab), F4 (no folders before approval) against the real modules with in-memory handles | `node tests/unit/review_regressions.cjs` |
| `fs_harness.cjs` | the in-memory FileSystemHandle doubles + VM loader used above | (library) |
| `browser_smoke.mjs` | same F2/F4/F5 assertions in a REAL Chromium extension SW with REAL `FileSystemDirectoryHandle`s (OPFS), plus `/find` → `/stat` → `/read` round-trips | `node tests/unit/browser_smoke.mjs <path-to-extension>` |
| `browser_smoke_moves.mjs` | approved batch/single moves create parents only after approval; `/edit`+`/stat` echo paths round-trip; options page renders without page errors | `node tests/unit/browser_smoke_moves.mjs <path-to-extension>` |
| `browser_status_smoke.mjs` | actual rendered status colors, folder-permission outcomes, token/OCR errors, confirmation settings after reload, and approval acknowledgment/failure states in the closed shadow root | `node tests/unit/browser_status_smoke.mjs <path-to-extension>` |

The `browser_*smoke*.mjs` scripts need `playwright` available (any
sibling `node_modules` works) and an extension-capable Chromium
(`channel: "chromium"`) — the headless shell cannot load extensions.
They exit non-zero only on a summary mismatch; read the printed JSON.

The merge checks also retain master's `/mkdir` contract: nested and
idempotent creation, canonical response fields, leaf/intermediate file
collisions (409), read-only mode, and traversal refusal. The browser moves
smoke verifies those collisions with real filesystem handles.
