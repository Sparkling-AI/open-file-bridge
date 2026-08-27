# File Bridge for Open WebUI

**Let Open WebUI chats read & write files on the user's own computer —
without any file ever touching your server.**

```
User: "read notes.txt in my folder"
  └─ Open WebUI model (your server) ── generates Python code
       └─ Pyodide runs it IN THE USER'S BROWSER
            └─ fetch → http://127.0.0.1:8765 (File Bridge, user's machine)
                 └─ reads/writes ONE folder the user chose
```

- **Zero server-side file handling** — works for 10 or 10,000 users with no
  per-user infrastructure, no MCP servers, no tunnels.
- **One folder, explicitly chosen by the user** — sandboxed, path-traversal
  rejected, localhost-only.
- **Verified end-to-end** on Open WebUI **v0.11.1** with GLM-5.3:
  the model listed real files and quoted file contents verbatim
  ([screenshot](docs/screenshots/e2e-success.png)).

## How it works

Open WebUI's Code Interpreter (Pyodide engine) is WebAssembly that executes
**in the user's browser**. Python running there can make HTTP requests to the
user's own localhost — which is exactly where File Bridge listens. A public
**Skill** (markdown instructions) teaches the model the fetch pattern; a
**model preset** turns the Code Interpreter on by default so users just pick
a model and ask.

| Piece | Where it lives | This repo |
|---|---|---|
| Skill (instructions) | OWUI Workspace, public | `skill/local-file-bridge.skill.md` |
| Model preset (CI on + skill) | OWUI Workspace, public | `scripts/setup_owui.py` |
| File Bridge app | Each user's machine | `src/file_bridge.py` + `build/` |

## Repository layout

```
├── src/file_bridge.py            # the app — single file, stdlib-only (3.8+)
├── skill/local-file-bridge.skill.md   # importable OWUI skill (YAML frontmatter)
├── scripts/setup_owui.py         # one-shot admin setup via OWUI REST API
├── build/
│   ├── build_linux.sh            # Linux binary (native or docker/glibc-old)
│   ├── file_bridge_windows.spec  # PyInstaller spec (console-less exe)
│   ├── installer_windows.iss     # Inno Setup installer
│   ├── file_bridge_macos.spec    # PyInstaller spec
│   └── package_macos.sh          # .app bundle + optional sign/notarize
├── .github/workflows/build.yml   # CI: all 3 OSes on tag push
├── tests/e2e_test.sh             # endpoint + security test suite
└── docs/
    ├── user-guide.md             # give this to your users
    ├── admin-guide.md            # setup, architecture, hardening
    ├── TODO.md                   # open items: CORS lock rationale, signing, guardrails
    ├── BUILDING.md               # how to build each OS package
    └── screenshots/              # proof: the working end-to-end run
```

## Quick start

**Admin (once):** see [docs/admin-guide.md](docs/admin-guide.md) — scripted:

```bash
python3 scripts/setup_owui.py --url http://your-owui:8080 \
    --email admin@… --password '…' --base-model glm-5.3-flash
```

**User:** download the app for your OS, run it, pick a folder, then in
Open WebUI select the prepared model ("Local Files Assistant") and just ask.
Full walkthrough incl. permission prompts: [docs/user-guide.md](docs/user-guide.md).

## Compatibility

| | Status |
|---|---|
| Open WebUI | v0.11+ (Skills feature); verified on 0.11.1 |
| Browsers | ✅ Chrome, Edge, Firefox · ❌ **Safari** (blocks localhost fetches) |
| OS | Windows 10/11 · macOS 11+ · Linux |
| Python (if running from source) | 3.8+, **no pip dependencies** |

## Security model

- Bridge binds **127.0.0.1 only** — unreachable from the network/internet.
- Exposes exactly **one user-chosen folder**; `../` traversal is rejected
  (tested); absolute paths rejected.
- Only **list / read / write** — no delete, no move, no exec.
- Reads capped at 200 KB; text files.
- CORS: ships permissive (`*`) for out-of-the-box demos — **lock it to your
  OWUI origin before real rollout** (one line, see admin guide §Hardening).
- The user's browser shows a one-time **local network access** prompt
  (Chrome/Edge) — explicit user consent per site.

## What this is not

- Not a file-sync or RAG system — it's live read/write of the current folder
  contents into the chat.
- Not for binary formats yet (PDF/xlsx) — text only in v1; a base64 endpoint
  would extend it.
- Not Safari-compatible (fundamental browser limitation).

## License

MIT — do what you like, no warranty.
