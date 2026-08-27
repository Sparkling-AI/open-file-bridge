# Research: OpenWorker (andrewyng) — what to borrow

Date: 2026-08-27 · Sources: repo clone @HEAD (351 commits), issues #1-#520,
README, source reading of coworker/ (agent engine, tools, skills, audit,
risk, pdf_support, readonly, selfwake, compaction).

Project: Andrew Ng's open-source desktop AI coworker. Created 2026-07-20,
16.5k stars in 5 weeks, MIT, Python backend (aisuite) + Tauri GUI + Rust STT
sidecar. macOS signed/notarized; Windows unsigned (SmartScreen warns — same
friction we documented). Fun facts: their dev server also runs on **port
8765** with a per-launch token in `X-OpenWorker-Token` — we independently
converged on the same design (validation!).

Threat-model note: OpenWorker is a *desktop agent* (agent runs locally, model
APIs remote). We are the inverse (model/UI central, execution in browser).
Still highly borrowable — their governance engineering is ahead of ours.

---

## 1. Governance patterns (their crown jewel — borrow aggressively)

- **RiskClass taxonomy** (`risk.py`): every tool declares READ / EGRESS /
  WRITE_LOCAL / EXEC / EXTERNAL; effective risk = user override ?? base,
  with **override floors** (you can tighten but never relax below the
  catalog floor). → Borrow for bridge endpoints: `/read*` = READ,
  `/write*` = WRITE_LOCAL, future `/ocr_pdf` etc stay READ. Cheap to add,
  future-proofs confirmation logic.
- **Audit with approval provenance** (`audit.py`, sqlite): every tool call
  logs session, tool, stage, status, approval origin, args,
  result_preview + secret-scrubbing (`_SECRET_KEYS`). → Direct template for
  our P0 audit log — copy the scrub list & preview truncation.
- **Read-only session classifier** (`readonly.py`): allowlist of safe read
  commands, pipelines allowed, **fail-closed**, network clients excluded
  even for GET (exfil channel). → Validates our binary-whitelist design;
  adopt fail-closed default for unknown extensions.
- **Secrets never in model context** (`secrets.py`): 0600 JSON store,
  `${ENV_VAR}` indirection, swap-to-Keychain-ready interface. → Our token
  should live in state file with 0600, never echoed by skill.
- **Workspace trust** (`workspace_trust.py`): canonical-path trust store,
  per-workspace grants, atomic tmp+rename writes. → Pattern for multi-folder
  support later (v2 idea: several shared roots, each trusted separately).

## 2. File/PDF handling (direct feature donors)

- **`read_file` windowing** (`tools/files.py`): cat -n style numbered lines,
  2000-line default window, 500-char line clip, `start_line` continuation,
  "tells the agent how to continue". → **Borrow verbatim into `/read`**:
  solves our big-file token bonfire better than a hard cap; model cites
  path:line naturally.
- **PDF capability fallback** (`pdf_support.py`): text mode (pypdf) vs
  images mode (pypdfium2 raster @2x = 144dpi, ≤100 pages),
  **content-hash cached** (history replays every turn!). → Two ideas: (a)
  add `?mode=text|images` to /pdf_text for vision models; (b) **cache OCR
  and pdf_text results by (sha256, params)** in the bridge — repeated asks
  in a session become free.
- Attachment caps (MAX_TEXT_CHARS 200k, image 12M, pdf 15M, 8 per turn):
  sane numbers to align our caps with.

## 3. Skills system (they use Anthropic SKILL.md format!)

- Folder + `SKILL.md` (frontmatter name/description/allowed-tools) +
  resources/scripts; **progressive disclosure** catalog→load_skill;
  load_skill rescans on miss (skills added mid-session work);
  project skills in `<workspace>/.coworker/skills` = **git-shareable**;
  disable state kept OUT of the folder (one user's mute ≠ teammate's).
  Upload flow = parse→preview→confirm staging.
  → Our OWUI skill is single-markdown (platform limit), but the *pattern*
  matters for our repo: ship the skill as a folder with version pinning +
  changelog; staging/preview idea for the admin setup script (show diff of
  what will change on update).

## 4. Issues — demand signals for office-file work

- **#454 (Office/PPT templates)**: native docx/xlsx/pptx + doc→PPT
  generation + **.potx template matching**. We have reads/writes; the
  template idea is new → P2: `/pptx_from_template` (python-pptx can build
  from .potx), `/docx_merge` placeholder filling. Real office demand.
- **#490 (files don't appear)**: their directory-analysis UI misses files —
  our `/list` + `/stat` routing avoids this; user-education point.
- **#232/#171 (Linux build, 21+/10+)**: they're macOS-first; Linux+Windows
  lag. Our cross-OS packaging story is actually *ahead* on Windows/Linux.
- **#72/#22/#315 (OpenAI-compatible/openrouter/Chinese)**: model-flex +
  i18n demand — not our layer.
- Security issues they're still working (#100/#292 SSRF in web_fetch,
  #518 same-origin HTML preview, #520 approval parser) — cautionary tales:
  our CORS-lock + no-HTML-preview stance avoids these classes entirely.

## 5. What NOT to borrow

- Tauri desktop shell / 25 connectors / Slack surfaces — different product.
- Auto-approve reviewer model (LLM judges actions): interesting but our
  bridge stays deterministic; a human (chat) is always in the loop anyway.
- Self-wake/automations: OWUI has its own automations; bridge stays dumb.
- Compaction: OWUI handles context; bridge never sees history.

## 6. Adopted into ROADMAP (new/changed items)

1. `/read` windowing (start_line/max_lines, numbered lines) — P0 (replaces
   "hard cap" framing; solves token bonfire)
2. Content-hash cache for /pdf_text + /ocr results — P1
3. RiskClass per endpoint + audit scrub list from audit.py — P0 (upgrades
   audit item)
4. `/pptx_from_template` + `/docx_merge` placeholders — P2 (from #454)
5. pdf_text?mode=text|images (pypdfium2 raster for vision models) — P2
6. Skill folder w/ version+changelog, setup script shows preview-diff — P2
7. Fail-closed unknown-extension policy — P0 whitelist item (confirmed)
8. 0600 token file + never-in-skill-echo rule — P0 token item (confirmed)
