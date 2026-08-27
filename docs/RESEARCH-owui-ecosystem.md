# Research: Open WebUI ecosystem — what to borrow

Date: 2026-08-27 · Sources: open-webui/open-webui issues/PRs, openapi-servers
repo, Open Terminal docs (docs.openwebui.com), GitHub search API.

---

## ⚠️ 1. Strategic risk first: Pyodide is officially "legacy"

Open WebUI's own docs now say: *"Pyodide is a legacy code-execution engine…
no longer the recommended path… may be deprecated in a future release."*
The recommended path is **Open Terminal** (Docker-based agent workspace).
Issue trail shows repeated Pyodide regressions across releases
(#26660 "Pyodide again broken", #26800 matplotlib fix, #27550 client-session
disconnects).

**Impact on us:** the entire File Bridge architecture rides on the Pyodide
Code Interpreter (browser-side execution + pyfetch to localhost).

**Mitigations (add to ROADMAP as standing items):**
- Pin the OWUI version in production; test Pyodide CI on every upgrade.
- Watch release notes for CI engine changes; the two-switch preset config
  (`capabilities` + `defaultFeatureIds`) is exactly the kind of thing that
  shifts between versions.
- Fallback path if Pyodide CI is removed: Jupyter-engine CI **does not help**
  (server-side); the realistic fallback is per-user Open Terminal via the
  "Terminals" orchestrator, which changes the whole security story (files on
  server containers). Document, don't build yet.

## 2. Official `openapi-servers` Filesystem Server — direct feature donors

FastAPI server from OWUI org (server-side, admin-run — different trust model
from our per-user localhost bridge, but great endpoint design). Borrow:

| Their feature | Ours today | Action |
|---|---|---|
| **Confirmation tokens** for destructive ops (60 s validity, two-step, `.pending_confirmations.json`) | none | P0→borrow for /write on existing files & future delete |
| **/edit_file**: multiple replacements + **dry-run with unified diff preview** | none (we write whole files) | P1: add `/edit` with dry_run param — token-cheap surgical edits |
| /search_content: case-insensitive, **line numbers + context**, file-pattern filter | /search planned | adopt their param design verbatim |
| /search_files: name pattern + **exclusion patterns**, recursive | /list only | merge into /search plan |
| /directory_tree (recursive structure) | /list is flat-ish recursive JSON | add `?format=tree` |
| /get_metadata | /stat | ours richer (kind detection) — keep |
| 403/404/400 error semantics table | ad hoc | align error codes |

## 3. Open Terminal — UX and security patterns to steal

Open Terminal = OWUI's official "agent harness" (Docker or bare metal,
admin-configured; per-user via "Terminals" orchestrator). Not our competitor
(trust model differs: their files live in server containers) but:

- **Security posture validates our P0 list**: since v0.11.30 it *refuses to
  start without an API key*. → We should consider: bridge refuses unlocked
  CORS `*` + no token after a first-run "production mode" toggle.
- **File browser previews** (PDF pages, DOCX page layout, PPTX slide viewer,
  CSV tables, sandboxed HTML iframe): inspiration for our picker/settings
  page — a local preview tab showing what the AI can see. P3.
- **Inline file cards in chat** (AI attaches file to reply w/ preview +
  download): we can't inject into OWUI chat UI, but the skill can be taught
  to end with a `/reveal` call so the file pops open in Explorer/Finder —
  already on our P2; promote to P1 (cheap, high perceived value).
- **Chat Uploads → Filesystem routing**: their answer to "attachments land
  in workspace". Our equivalent gap: files dropped into OWUI chat can't reach
  the user's shared folder. Future idea: bridge `/save_upload` + skill rule
  "if user attaches a file, tell them to drop it in the folder instead" —
  document as known limitation rather than build.

## 4. High-vote open issues — demand signals

| Issue | Votes | Signal → action for us |
|---|---|---|
| #5872 data sources (Drive/OneDrive/Dropbox/Notion pickers) | 52+ | P3 idea: bridge folder can BE an rclone mount of a cloud drive — zero bridge code, document the recipe |
| #12228 upload w/o backend processing | 45+ | Validates our no-server-processing philosophy; quote in README |
| #12619 per-context extraction settings (fast chat vs thorough KB) | 20+ | Borrow: `/pdf_text?mode=fast|thorough`, OCR `dpi` param already exists; add `quality` alias |
| #13225 reindex all | 19+ | n/a (server RAG) |
| #21341 skills support | 13+ | Watch — skills API still moving |
| #24654 upload folder to sidebar | 6+ | Folder-level UX demand; our /list covers model side |
| #14768 allowed file types not enforced per engine | — | Validates our binary whitelist P0 |
| #22528 sync uploads→terminal fs (merged) | 14+ | Pattern reference only |
| #3583 pyodide file upload support (2024) | — | The origin of /mnt/uploads; historical |

## 5. Borrowable feature shortlist (added to ROADMAP)

1. `/edit` endpoint w/ dry-run diff (from openapi-servers) — P1
2. `/search` param design: context lines, file glob, exclusions — P1 (upgrade)
3. Confirmation-token flow for overwrite/destructive ops — P0 (upgrade of
   the snapshot item: snapshot AND confirm)
4. `/directory_tree?format=tree` — P2
5. "Refuse to start unsecured in production mode" stance — P0 discussion
6. `/reveal` promotion to P1
7. rclone cloud-drive recipe in docs — P3
8. Local preview tab in settings page — P3

## 6. What we deliberately do NOT borrow

- Running arbitrary commands (Open Terminal's core) — our threat model is
  non-technical office users; a file bridge must stay a file bridge.
- Server-side filesystem mounting for OWUI (openapi-servers default mode) —
  that's the central-server trust model we explicitly avoid.
- Per-user container orchestration (Terminals) — ops-heavy; revisit only if
  Pyodide dies (see §1).
