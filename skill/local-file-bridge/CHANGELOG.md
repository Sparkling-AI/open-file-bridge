# Changelog — Local File Bridge skill

Notable, user-facing changes to the OWUI skill
(`skill/local-file-bridge/SKILL.md`) that admins should announce when
they re-run `scripts/setup_owui.py`. Bridge-side changes without a
skill-visible surface stay in ROADMAP/DEVNOTES.

## 2.3.1 — 2026-08-28

- **Strict skill description rewritten (weak-model fix, validated)**:
  the old text described features; the new one front-loads the failure
  mode into the ONLY text a model is guaranteed to see (the tool-list
  description — opening the skill body is optional). Chat-verified on
  glm-4.5-air: with the old description the model ignored the skill
  entirely and fabricated success in /mnt/uploads/ (zero bridge
  requests); with the new one it called the skill, ran the Bootstrap,
  and completed /list → /read → /write with the file landing on disk.
  Applied to SKILL-STRICT.md frontmatter + setup_owui.py (single
  STRICT_DESC constant now — was two diverging inline strings); setup
  rerun verified idempotent (live description survives).

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
- Skill now ships as a folder (`skill/local-file-bridge/`) with
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
