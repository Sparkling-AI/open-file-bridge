---
name: open-file-bridge-strict
description: "Read, create, edit, search, convert, and organize documents and other files in the folder the user shared from their computer through Open File Bridge. Use for requests involving the user's local Word, Excel, PowerPoint, PDF, image, archive, email, text, or code files. MUST-CALL before acting: sandbox file APIs cannot reach that folder; only a successful bridge response confirms the work."
---

# Local File Bridge — STRICT variant — skill v2.11.1

Built for models that need guardrails: fixed recipes, bridge-only writes,
verify-after-write. (Stronger models: use the standard "Local File
Bridge" skill instead — more endpoints, more freedom.)

Use this skill to read, create, edit, search, convert, and organize files in
the folder the user shared from their computer through Open File Bridge.

## THE 10 RULES — follow exactly, never improvise

1. The user's files live in their **shared folder**, reachable ONLY
   through their Open File Bridge at `http://127.0.0.1:8765`. The Python
   sandbox (`/mnt/uploads/` or whatever `os.getcwd()` says) is **NOT**
   the user's folder — it is a throwaway scratch space.
2. **NEVER use `open()`, `os.*`, or `pathlib` to read or write user
   files.** A file written inside the sandbox is LOST — the user will
   never see it. Telling the user it was created would be a lie.
3. First action of every session: run the bootstrap block below (its
   `GET /health` doubles as the version check).
4. If `/health` fails or the fetch fails: say exactly — *"Your File
   Bridge app isn't running. Please start the Open File Bridge app on your
   computer, then ask me again."* — and STOP. Do NOT look in
   `/mnt/uploads`. Do NOT improvise. Maximum ONE retry.
5. To read: `/list` first, then `/stat` (or `/peek`) on the target,
   then the matching reader endpoint from the table below. Never
   `/read` a binary file (Office/PDF/image) — the error response tells
   you the right endpoint; follow its `hint`.
6. To write: ALWAYS a bridge POST endpoint (`/write`, `/write_b64`,
   `/edit`, `/xlsx_append`, `/pdf_from_text`, `/docx_merge`).
   NEVER local file APIs (Rule 2).
7. Writes execute immediately — the BRIDGE provides the safety net,
   not a chat round trip. Every write to an existing file snapshots the
   prior version first (POST `/versions/list`, POST `/versions/restore`);
   deletions are trash-moves (POST `/trash/list`, POST `/trash/restore`).
   Do not ask the user to approve a write before performing it, and do
   not invent confirmation steps: when the user asked for the change,
   perform it, then verify (Rule 8) and REPORT what was replaced and
   that the previous version is recoverable.
8. **After EVERY write: verify.** Re-read the file via the bridge (or
   confirm the response contains `"ok": true` and the `"written"`
   path) and report THOSE facts. Never claim success from your own
   belief — if you did not see a 200 from the bridge, say so.
9. Only touch files inside the shared folder. Never construct `../`
   paths. Never dump a whole large file into chat — summarize and cite
   `path:line`.
10. On any 4xx/5xx: read the `error` and `hint` fields and follow
    them. 404 `"unknown endpoint"` means wrong method — you sent a GET
    to a POST endpoint: retry once with `bridge_post`. If still stuck,
    tell the user the exact error text — do not guess.

## Bootstrap — run this first, copy it exactly

```python
from pyodide.http import pyfetch
import json

# NO-TOKEN variant — bridges in Tier-1 origin-lock mode. On HTTP 401
# (token mode): ask the user ONCE for their bridge token (settings
# page, 🔒 Security → Show), add the header "X-Bridge-Token": "<it>"
# to BRIDGE_HEADERS for the rest of the session, retry once. Never
# echo the token back.
BRIDGE_HEADERS = {"Content-Type": "application/json"}

async def bridge_get(path, params=None):
    url = f"http://127.0.0.1:8765{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    r = await pyfetch(url, headers=BRIDGE_HEADERS)
    t = await r.text()
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}: {t}")
    return json.loads(t)

async def bridge_post(path, payload):
    r = await pyfetch(f"http://127.0.0.1:8765{path}", method="POST",
                      headers=BRIDGE_HEADERS,
                      body=json.dumps(payload))
    t = await r.text()
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}: {t}")
    return json.loads(t) if t else {}

# session start (Rule 3) — ONE call: /health already carries the version:
h = await bridge_get("/health")
print(h.get("ok"), h.get("root"), h.get("version"))
```

`/health` → `{"ok": true, ...}` means running; it also shows the shared
root folder and the `version` (older than v2.11 → tell the user "the bridge
app and the skill are out of sync — re-run the installer"). Send
`BRIDGE_HEADERS` on EVERY call, GETs included. Non-200 bodies are JSON with
an `error` (+ often `hint`) — read and adjust; e.g. 401 "missing or invalid
bridge token" → add the token header, retry once.

## Recipe A — find and read a file (in this order)

1. `h = await bridge_get("/health")` — if it fails, Rule 4.
2. `files = await bridge_get("/list", {"path": "."})` — the user's
   files are HERE, nowhere else.
3. Not sure what a file is? `await bridge_get("/peek", {"path": p})`
   → follow its `hint`.
4. Read with the matching endpoint:

| File type | Endpoint |
|---|---|
| txt / md / code / csv | `/read?path=X` (windowed; `/csv_head` + `/csv_stats` for shape) |
| .xlsx | `/xlsx_read?path=X` (row_count, headers, data) |
| .docx | `/docx_read?path=X` |
| .pptx | `/pptx_read?path=X` |
| .pdf | `/pdf_text?path=X` — empty text = scanned → `/ocr?path=X` |
| image (png/jpg/…) | `/image_info?path=X` then `/ocr` if text is needed; `/image_b64` to SHOW it in chat |
| .eml | `/eml_read?path=X` |
| .html | `/html_text?path=X` |
| .doc/.xls/.ppt (legacy) | Recipe C first |

5. Summarize what you found; cite `path:line`. Show at most a screen
   of content unless the user asks for more.

Search across files: `/search?q=…&glob=…` (respects the user's ignore
lists — a missing file may be excluded on purpose; say so).

## Recipe B — create or modify (write ONLY via the bridge)

1. `GET /health` (Rule 3/4).
2. Pick the endpoint for the job:

| You want | Endpoint |
|---|---|
| write/edit plain text, md, csv, code | `/write {"path","content"}` (overwrites snapshot first) |
| surgical text replacements | `/edit {"path","edits":[…],"dry_run":true}` — show the diff, then apply (snapshotted) |
| new Word document | use the fixed in-memory Word recipe below → `/write_b64` (do NOT use `/docx_write`) |
| new PDF | `/pdf_from_text {"out":"x.pdf","blocks":[…]}` |
| Excel rows (create or append) | `/xlsx_append {"path":"x.xlsx","rows":[[…]],"header":[…]}` |
| fill a .docx template | `/docx_merge {"path","out","values":{…}}` |

3. POST it (an existing target is snapshotted automatically
   + token).
4. **VERIFY (Rule 8):** re-read via the bridge OR report the
   response's `"written"` path and byte count. Example:
   `d = await bridge_post("/write", …)` → tell the user
   `d["written"]` — never "I created it" without this.
5. State the exact final path in your answer, then make it clickable:
   the write response already has `d["links"]` — append
   `**`name`** · [📄 Open](d["links"]["open_url"]) · [📂 Show in folder](d["links"]["reveal_url"])`
   (folders: Show in folder only). Passing mentions stay plain code spans.
   No `d["links"]` (older bridge) → plain code span, no extra call.

### Fixed Word recipe — create a new `.docx`

Use this exact in-memory pattern, changing only the requested file name and document content. It creates a standards-based OOXML package with Python's standard library, so it does not depend on `lxml` being available in the current Pyodide build. Never use `open()`, `os.*`, or `pathlib`; `BytesIO` is temporary memory, not the user's filesystem.

```python
import base64, io, zipfile
from xml.sax.saxutils import escape

heading = escape("Certification Test")
sentence = escape("hello world")
content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'''
package_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''
document_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'''
styles = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>'''
document_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{heading}</w:t></w:r></w:p><w:p><w:r><w:t>{sentence}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'''
buf = io.BytesIO()
parts = {
    "[Content_Types].xml": content_types,
    "_rels/.rels": package_rels,
    "word/_rels/document.xml.rels": document_rels,
    "word/styles.xml": styles,
    "word/document.xml": document_xml,
}
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as docx:
    for name, data in sorted(parts.items()):
        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        docx.writestr(info, data)
d = await bridge_post("/write_b64", {
    "path": "review-note.docx",
    "b64": base64.b64encode(buf.getvalue()).decode("ascii"),
})
print(d)
```

The fixed timestamp and sorted part names make this package deterministic —
build it ONCE and reuse the same bytes. POST it via `/write_b64`; an existing
target is snapshotted automatically before replacement. After a 200 response,
verify with `/docx_read` and report the returned `written` path. Do not use
`/docx_write` for new Word documents in packaged installations. For richer
formatting, expand the OOXML parts while preserving deterministic ZIP
metadata.

## Recipe C — legacy formats (.doc/.xls/.ppt)

Convert to a modern format first, then Recipe A/B on the product:

```python
d = await bridge_post("/convert", {"path": "old.doc", "out": "new.docx"})
# An existing output is snapshotted before replacement.
# 501 → the user has no LibreOffice: say so and ask them to convert manually.
```

## Error phrases — say these EXACTLY, then stop

| Response | Tell the user |
|---|---|
| fetch/`/health` failure | "Your Open File Bridge app isn't running. Please start the Open File Bridge app, then ask me again." |
| 401 | "This bridge needs an access token. Please paste your bridge token (Open File Bridge settings → 🔒 Security → Show) here in chat." |
| 403 read-only | "The bridge is in read-only mode — switch it off in the Open File Bridge settings if you want edits." |
| 429 | "The write-rate safety brake tripped (many writes in a minute). Please confirm you want me to continue." |
| 501 | "This Open File Bridge install lacks a needed component — see its admin guide." |

## Detection

`await bridge_get("/health")` → `{"ok": true}` = running. Anything
else → Rule 4. `/health` reports the bridge version; older than v2.11
→ out of sync.
