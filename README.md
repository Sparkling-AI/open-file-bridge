<p align="center">
  <img src="docs/brand/readme-banner.png" width="800"
       alt="Open File Bridge — turn Open WebUI into a coworker: share team knowledge, access private files, create files locally" />
</p>

# Open File Bridge

**Turn [Open WebUI](https://github.com/open-webui/open-webui) into a
coworker — with your team's shared knowledge, your private files, and all
the document work done on your own machine.**

What that means:

- **Share team knowledge** — your org's workspace knowledge stays in Open
  WebUI, server-side, exactly as it is today
- **Access private files** — each user opens one folder of their own
  machine to the chat; files never touch the server
- **Create files locally** — Word/Excel/PowerPoint/PDF creation, format
  conversion and OCR all run on the user's machine, so file work scales
  with users, not your server

Built for and verified against Open WebUI (0.10.x and 0.11.x). Under the
hood it's a generic, localhost file API: any AI system whose generated
code runs **in the user's browser** (or on the user's machine) can use
it too.

```
User: "read notes.txt in my folder"
  └─ Open WebUI model (your server) ── generates Python code
       └─ Pyodide runs it IN THE USER'S BROWSER
            └─ pyfetch → http://127.0.0.1:8765 (Open File Bridge, user's machine)
                 └─ reads/writes ONE folder the user chose
```

![Architecture](docs/diagrams/architecture.png)

## Why you'd want this

- **Zero server-side file handling** — works for 10 or 10,000 users with no
  per-user infrastructure, no MCP servers, no tunnels, no cloud drives.
- **Privacy by architecture** — there is no route for file bytes to reach
  the server; the server only ever hosts chat and the skill text.
- **Real office work, not toys** — 35+ versioned endpoints: Word/Excel/
  PowerPoint/PDF creation & editing, OCR of scanned documents, LibreOffice
  format conversion, mail merge, zip/unzip, versioned writes with a trash
  bin and a full audit log.
- **Model-agnostic** — ships a standard skill for strong models and a
  strict variant (fixed recipes + verify-after-write) validated on weak
  models; see [Verified results](#verified-results).

## How it works

Open WebUI's Code Interpreter (Pyodide engine) is WebAssembly Python that
executes **in the user's browser**. Python running there can reach the
user's own localhost — which is exactly where Open File Bridge listens.
A public **Skill** (markdown instructions) teaches the model the fetch
pattern; a **model preset** turns the Code Interpreter on by default so
users just pick a model and ask.

| Piece | Where it lives | This repo |
|---|---|---|
| Skill (instructions, 2 variants) | OWUI Workspace, public | `skill/open-file-bridge/` |
| Model preset (CI on + skill) | OWUI Workspace, public | `scripts/setup_owui.py` |
| Open File Bridge app | Each user's machine | `src/file_bridge.py` + `build/` |

Other agent systems: if your runtime executes model-generated code
browser-side (WebAssembly sandbox, user scripts) it can talk to the same
HTTP API; if it runs on the user's machine, even simpler — the bridge is
just a localhost JSON API with token auth.

## Security model

Model-generated code is treated as **untrusted**. A request must pass
every layer below before touching a file:

![Security model](docs/diagrams/security.png)

- **L0 Network** — loopback-only listener; other machines can't connect.
- **L1 Auth** — two tiers: origin lock (CORS exact-match) or org token
  (`X-Bridge-Token`, constant-time compare). A fresh bridge **fails
  closed**: every file endpoint returns 503 until an admin configures one.
- **L2 Transport policy** — CORS/PNA headers only for the matching origin,
  write-rate breaker, payload caps.
- **L3 Filesystem gate** — exactly ONE user-chosen folder; `../` traversal
  rejected, symlink components refused, credential-looking filenames
  (`id_rsa`, `.env`, `*.pem`…) blocked outright.
- **L4 Operation semantics** — overwrites & deletes require a 409
  confirmation token (60 s, bound to op+path+out); every overwrite
  snapshots the prior version; deletes are trash-moves (purge is 403 by
  design); JSONL audit log with secret scrubbing; optional read-only mode.

Current Open WebUI `:main` builds run Pyodide in a sandboxed iframe
(`Origin: null`) — use tier-2 token mode there. Details, upgrade
checklist and the full analysis: [docs/OWUI-COMPAT.md](docs/OWUI-COMPAT.md).

## Setup

### Admin (once) — manual setup

What the setup script automates, spelled out so you can do it (and audit it)
by hand in the Open WebUI UI:

1. **Publish the skill** — *Workspace → Skills → Create*: set id
   `open-file-bridge`, paste the contents of
   [`skill/open-file-bridge/SKILL.md`](skill/open-file-bridge/SKILL.md),
   save — then set the skill's visibility to **public** (users need read
   access or their models can't load it).
2. **Create the assistant model (custom model)** — *Workspace → Models →
   Create*: base it on a strong chat model, then under
   **Capabilities** enable **Code Interpreter** *and* mark it as a
   **default** feature — **both switches matter**: with only the capability
   checked, new chats start with the interpreter toggle OFF and the model
   can never run code. Under **Skills**, attach `open-file-bridge`.
   (Weak models that wander into the sandbox? Publish the stricter
   `SKILL-STRICT.md` as a second skill + second model.)
3. **Distribute the app** — point users at the
   [GitHub Releases](https://github.com/Sparkling-AI/open-file-bridge/releases/latest)
   (per-OS zips + `SHA256SUMS`; macOS build is signed & notarized since
   2.8.1) or mirror the zips internally — or users run from source with
   `python3 src/file_bridge.py <folder>` (zero pip dependencies).
4. **Set up the access token (required on current Open WebUI builds)** —
   the sandboxed interpreter sends `Origin: null`, so tier-1 origin lock
   alone can't work; users need a token. Recommended org pattern:
   - Generate one org token (any strong random string), then **edit the
     skill you published in step 1** and set it in the bootstrap block:
     `BRIDGE_HEADERS = {"Content-Type": "application/json", "X-Bridge-Token": "<org-token>"}`
     (the setup script does this for you with `--bridge-token <secret>`)
   - **Distribute the token to users** over a channel appropriate for an
     org-wide credential (not a public wiki) — each user pastes it once
     into their bridge's settings page (🔒 Security → token)
   - Everyone in the org can read the token from the public skill body —
     that's by design: it's a company-boundary credential (stops local
     malware and other websites from using the bridge), not a secret
     from colleagues. Avoid this pattern if your OWUI has guest/external
     accounts; prefer per-user tokens then (each user generates their
     own — see [admin-guide](docs/admin-guide.md#one-time-setup)).
   - **Rotating**: paste a new token into the skill (or re-run the script
     with a new `--bridge-token`) and tell users to re-paste.
5. Sanity-check the result as a user (checklist below).

Scripted shortcut for steps 1–2 and the token embedding in 4 (idempotent,
same REST calls, no code changes to Open WebUI):

```bash
python3 scripts/setup_owui.py --url http://your-owui:8080 \
    --email admin@… --password '…' --base-model glm-5.3-flash \
    --bridge-token '<org-token>'
# weaker models (they wander into the sandbox instead of the bridge)?
# add a strict-variant preset with fixed recipes + verify-after-write:
python3 scripts/setup_owui.py … --variant-strict-model glm-4.5-air
# or make strict the ONLY skill (org standardizes on small models):
python3 scripts/setup_owui.py … --variant strict
```

### User checklist

Preconditions — confirm these before anything else:

- [ ] **Allowed by your admin**: a local-files assistant model appears in
      your model list (usually "Local Files Assistant") — that means the
      skill is published and Code Interpreter pre-enabled for you
- [ ] **The org token from your admin** (if your org uses one): you'll
      paste it into the app once — request it if you weren't given it
- [ ] **The app**: download Open File Bridge for your OS from
      [Releases](https://github.com/Sparkling-AI/open-file-bridge/releases/latest)
      (or whatever internal mirror your admin points you to — run from
      source works too: `python3 src/file_bridge.py <folder>`)
- [ ] **Browser**: Chrome, Edge or Firefox — *not* Safari (it blocks the
      localhost fetches this needs)

Then:

1. **Install & launch the app**, pick the folder you want to share — the
   settings page opens in your browser.
2. **Paste the org token** your admin gave you into the settings page
   (🔒 Security → token) — the chat then uses it automatically (it's
   embedded in the org skill). Until this is done the bridge stays
   locked and every file request fails — that's by design. (No org
   token? Generate your own with *Generate random token* instead.)
3. **New chat → select the assistant model** → ask something like
   *"list the files in my folder"*. If the browser asks about
   **local network access**, click **Allow**.
4. **Using your own model instead of the preset?** Two extra switches:
   enable the **Code Interpreter** toggle in the chat's feature bar, and
   enable/[$-mention](docs/user-guide.md) the `open-file-bridge` skill.
   Everything else is identical.

Full walkthrough incl. permission prompts and troubleshooting:
[docs/user-guide.md](docs/user-guide.md).

### Solo setup (no admin staging — private skill + your own app)

If your org hasn't staged a public skill and presets — or you're on a
server where you're just a regular user — you can run the whole thing
yourself. Your skill stays **private to you** (colleagues can't even see
it, let alone read a token embedded in it — verified on current builds:
a private skill is invisible to other users in the skill list).

**One-time ask to your OWUI admin** (regular users can't create skills
by default — the *Workspace → Skills* permission is off unless granted):
"please enable **Skills** (and ideally **Models**) creation for users"
— Admin Panel → Settings → Users & Permissions → Workspace. It's two
checkboxes, no staging on their side.

Then:

1. **Get the app** yourself: download your OS bundle from
   [Releases](https://github.com/Sparkling-AI/open-file-bridge/releases/latest)
   (per-OS install steps: [user guide](docs/user-guide.md#install--first-run))
   or run from source (`python3 src/file_bridge.py <folder>`).
2. **Create a private skill** — your OWUI *Workspace → Skills → Create*:
   paste `SKILL.md` (keep it private — visibility stays "only me").
   In the bootstrap block, set **your personal token**:
   `BRIDGE_HEADERS = {"Content-Type": "application/json", "X-Bridge-Token": "<your-token>"}`
   — with a private skill this token is visible to you alone, which is
   strictly better security than the shared org-token pattern.
3. **Bridge side**: launch the app, pick your folder, paste the same
   token in settings (🔒 Security → *Generate random token* gives you
   one; or use its value in the skill).
4. **Chat with any code-capable model**: enable the **Code Interpreter**
   toggle in the chat feature bar and `$`-mention your private skill
   (e.g. `$my-open-file-bridge`) — or if user model creation is enabled,
   build your own preset with the interpreter + skill attached and skip
   the per-chat toggling.

Why this works: the bridge runs on *your* machine and only ever checks
the token — it doesn't care who published the skill. Solo mode trades
the org preset's convenience for zero admin staging and a token nobody
else can read.

## Verified results

Real-browser chat runs, asserting the file **actually lands on disk**
(not claimed in prose) — harness and evidence in
[docs/ROADMAP.md](docs/ROADMAP.md) §multi-model smoke:

| Model | Skill | Result |
|---|---|---|
| glm-5.3 | standard | ✅ full flow: /list → /read → /write, file on disk |
| glm-5.3 | standard, unified description | ✅ no regression |
| glm-5.2 | standard | ✅ honest failure when bridge unreachable (stops, no fabrication) |
| glm-4.5-air | strict, old description | ❌ fabricated success (wrote to Pyodide virtual FS, zero bridge calls) |
| glm-4.5-air | strict, failure-mode description | ✅ full bridge flow, file on disk |

Key lesson (validated both ways): models are only guaranteed to see a
skill's **name + description** — the description must state the failure
mode ("files written with `open()/os` are LOST and INVISIBLE to the
user"), not list features. Both shipped skill variants carry this wording.

## Compatibility

| | Status |
|---|---|
| Open WebUI | v0.11+ (Skills feature); verified on 0.11.1 and 0.10.2 — per-upgrade checklist in [OWUI-COMPAT](docs/OWUI-COMPAT.md) |
| Browsers | ✅ Chrome, Edge, Firefox · ❌ **Safari** (blocks localhost fetches) |
| OS | Windows 10/11 · macOS 11+ · Linux |
| Python (running from source) | 3.8+, **zero pip dependencies** for the core; optional add-ons (pymupdf, tesseract) enable OCR/PDF endpoints (clear 501 without) |

## Repository layout

```
├── src/file_bridge.py            # the app — single file, stdlib-only (3.8+)
│                                 #   (+ src/wheels/, src/tessdata/ assets)
├── skill/open-file-bridge/      # OWUI skill: SKILL.md, SKILL-STRICT.md, CHANGELOG
├── scripts/setup_owui.py         # idempotent admin setup via OWUI REST API
├── build/                        # Linux/Windows/macOS packaging (PyInstaller, Inno)
├── .github/workflows/build.yml   # CI: all 3 OSes on tag push
├── tests/e2e_test.sh             # 215 endpoint + security assertions
├── tests/addon_test.sh           # 136 add-on suite (Office/PDF/OCR/convert)
└── docs/                         # guides, compat window, support runbook, diagrams
```

## Documentation

| Doc | For |
|---|---|
| [user-guide.md](docs/user-guide.md) | end users — install, first chat, prompts |
| [admin-guide.md](docs/admin-guide.md) | admins — setup, hardening, tiers, variants |
| [OWUI-COMPAT.md](docs/OWUI-COMPAT.md) | compatibility window + per-upgrade checklist |
| [SUPPORT.md](docs/SUPPORT.md) | SmartScreen, port 8765, Safari runbook |
| [BUILDING.md](docs/BUILDING.md) | building the per-OS packages |
| [RCLONE.md](docs/RCLONE.md) | mounting cloud drives into the shared folder |
| [ROADMAP.md](docs/ROADMAP.md) | design decisions, verified results, history |
| [DEVNOTES.md](docs/DEVNOTES.md) | every gotcha we hit (agent-friendly) |

## What this is not

- Not a file-sync or RAG system — it's live read/write of the current
  folder contents into the chat.
- Not a way to bypass the user: the folder is chosen by the user, the
  browser asks consent for local-network access, and the bridge only
  ever serves that one folder.
- Not Safari-compatible (fundamental browser limitation).

## License

Apache-2.0 — open for any use, with patent grant. See [LICENSE](LICENSE),
[NOTICE](NOTICE) (attributions to OpenWorker & Open WebUI openapi-servers),
and [CLA.md](CLA.md) (contributions).
