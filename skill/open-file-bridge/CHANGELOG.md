# Changelog — Local File Bridge skill

Notable, user-facing changes to the OWUI skill

## 2.4 — 2026-08-29 (staged with bridge 2.4)

Cut from a real trace: "list files" cost 4 code executions (version
check, health check, a tokenless GET that failed opaquely, and a blind
retry). Now two calls — `/health` then `/list`.

- `bridge_get` now sends `BRIDGE_HEADERS` (the 2.3 example omitted them
  on GETs — the direct cause of tokenless calls failing with an opaque
  CORS AbortError).
- The separate `/version` preflight step is gone: `/health` already
  returns `version`; the skill says so and tells models to check it
  there once per session.
- Injected org-token block (setup_owui.py --bridge-token) now includes
  Content-Type and says "use verbatim, do not redefine".
- New rule: non-200 responses are JSON with `error` (+`hint`) — read
  and adjust (e.g. 401 → add token header, retry once); never
  blind-retry.
- Bridge side of 2.4: null-origin (sandboxed Pyodide) 401s are now
  CORS-readable so a missing token is a self-explanatory error instead
  of `AbortError: Failed to fetch`.

(`skill/open-file-bridge/SKILL.md`) that admins should announce when
they re-run `scripts/setup_owui.py`. Bridge-side changes without a
skill-visible surface stay in ROADMAP/DEVNOTES.

## 2.3.1 — 2026-08-28

- **Skill description unified across variants (weak-model fix,
  validated both ways)**: models are only guaranteed to see
  name+description — opening the skill body is optional. The new
  shared description front-loads the failure mode ("MUST-CALL before
  ANY file task… files written with open()/os are LOST and
  INVISIBLE; claiming success without a bridge response is a
  failure") instead of listing features. Chat-verified on glm-4.5-air
  (strict skill): old description → ignored the skill, fabricated
  success in /mnt/uploads/, zero bridge requests; new description →
  called the skill, ran the Bootstrap, completed /list → /read →
  /write with the file landing on disk. Re-verified on glm-5.3
  (standard skill): no regression for strong models (clean bridge
  flow, file on disk). Applied to both SKILL.md and SKILL-STRICT.md
  frontmatter + setup_owui.py (single UNIFIED_DESC constant — was
  three diverging inline strings); setup rerun verified idempotent
  (live descriptions survive).

## 2.3 — 2026-08-28 (staged with bridge 2.3)

New endpoints the skill can teach:
- **/convert** — LibreOffice headless format conversion: legacy
  .doc/.xls/.ppt → modern formats, office → PDF, xlsx → csv,
  docx → png/html. Requires LibreOffice on the user machine (bridge
  answers 501 with an install hint when absent).
- **/pdf_from_text** — create PDFs natively on the bridge (fpdf2):
  title/h1/h2/body/pagebreak blocks. No Pyodide shim needed.
- **/docx_write** — create Word documents from structured sections
  (headings, paragraphs, lists, numbered lists, page breaks).
- **/xlsx_append** — create-or-append Excel rows, with header on
  create and per-sheet targeting.
- **/docx_mailmerge** — one document per row from a template +
  xlsx/csv/inline rows; output-name patterns (`merged/{{client}}.docx`)
  or a .zip bundle.
- **/eml_read** — read .eml emails: headers, text body (html stripped),
  attachment metadata only.

Operational:
- **Skill variants**: the repo now ships a second skill body,
  SKILL-STRICT.md — 10 hard rules + fixed recipes + bridge-only
  writes + verify-after-write for weaker models (born from smoke
  tests: weak models wrote into the Pyodide sandbox and reported
  success). `setup_owui.py --variant strict` (strict-only org) or
  `--variant-strict-model <id>` (both skills + a second preset on
  the weak model). Standard SKILL.md unchanged.
- Skill now ships as a folder (`skill/open-file-bridge/`) with
  SKILL.md + CHANGELOG.md; `setup_owui.py` reads SKILL.md from there.
- `setup_owui.py` on update shows a unified diff preview of skill-body
  changes and asks before overwriting (`--yes` to skip).
- Version-sync: bridge `/version` expects skill 2.3.

## 2.2 — 2026-08-28

- **/pdf_op** (split/merge/rotate), **/reveal** (open in Explorer/
  Finder; consent-gated in the bridge), **/image_info** (dimensions,
  format, EXIF orientation awareness) added to the API table.
- Guidance: template fills (docx_merge/pptx_from_template), vision
  routing (image_info → OCR decision), PDF modes text|images.
- Security notes updated: two-tier model (origin lock / org token),
  UNLOCKED 503 gate, sensitive-name floor, snapshots + confirmations.

## 2.1 — 2026-08-28

- **/version** handshake at session start; skill tells the user to
  re-run the installer on version mismatch.
- **/zip, /unzip, /directory_tree** documented; mass-edit rule (list
  plan first when >5 files).
- Write-rate circuit-breaker (429) — skill relays "ask the user".

## 2.0 — 2026-08-27

- v2 security model: per-process state dir, origin lock, optional
  org token, audit log, UNLOCKED refuse-to-serve gate.
- API table rewritten for read-safety endpoints: /read windowing,
  /peek, binary whitelist, 409 confirmation flow.

## 1.x — 2026-08-2x

- Initial skill: file reads/writes via Pyodide pyfetch, office reads
  bridge-side, OCR (tesseract, swe+eng combo), /search, /edit,
  csv/html helpers.

## 2.5 — 2026-08-29 (staged with bridge 2.5)

- `/image_b64?path=&max_bytes=` — image as a data URL, size-capped
  (default 4 MB), auto-downscaled by the bridge when pymupdf is
  installed. New "Images" section: fetch the data URL and echo it as
  markdown in the reply to SHOW the user (OWUI's own matplotlib
  convention). Honest note added: code output reaches the model as text,
  so a vision model literally seeing a local image still requires the
  user attaching it to their message.
- OCR languages: bridge now merges a user drop-in dir
  (state-dir/tessdata) over the bundled set — extra languages without
  rebuilding the app. Picker shows the drop-in path.
- Picker: token field shows •••• when a token is configured.
