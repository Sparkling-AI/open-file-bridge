---
name: open-file-bridge-strict
description: "Read, create, edit, search, convert, and organize documents and other files in the folder the user shared from their computer through Open File Bridge. Use for requests involving the user's local Word, Excel, PowerPoint, PDF, image, archive, email, text, or code files. MUST-CALL before acting: sandbox file APIs cannot reach that folder; only a successful bridge response confirms the work."
---

# Local File Bridge — STRICT variant (org token) — skill v2.10.1

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
7. Creating a new file needs no confirmation. **HTTP 409 on a write
   means approval is required** because the action would overwrite,
   delete, restore, or destructively update files in bulk. Show the
   exact action and ask the user to approve it, then STOP that code
   execution. `bridge_post` preserves the exact payload in
   `PENDING_BRIDGE_WRITE`. Only in a LATER turn, after a new explicit
   user approval, call `bridge_commit_approved()` once. NEVER rebuild
   or regenerate the file, NEVER issue and consume a fresh approval in
   one execution, and NEVER send another token-free request after the
   user approved. The internal value is single-use, bound to the exact
   payload, and valid for about 10 minutes; never display it, name it,
   or ask the user to copy it. If it expires, require
   renewed approval and say: *"The approval window expired before I
   could complete the change. Please review the action above and
   approve it again."* If the action changes, show the revised action
   and ask again. Never use an earlier approval for a changed action.
8. **After EVERY write: verify.** Re-read the file via the bridge (or
   confirm the response contains `"ok": true` and the `"written"`
   path) and report THOSE facts. Never claim success from your own
   belief — if you did not see a 200 from the bridge, say so.
9. Only touch files inside the shared folder. Never construct `../`
   paths. Never dump a whole large file into chat — summarize and cite
   `path:line`.
10. On any 4xx/5xx: read the `error` and `hint` fields and follow
    them. For an expired, invalid, or changed approval, use the plain
    language in Rule 7 and never expose token terminology. Otherwise,
    if still stuck, tell the user the exact error text — do not guess.

## Bootstrap — run this first, copy it exactly

```python
from pyodide.http import pyfetch
import json

# TOKEN variant — this bridge runs in Tier-2 token mode and the ORG
# TOKEN IS EMBEDDED below. Use this BRIDGE_HEADERS verbatim on EVERY
# call; do not remove the X-Bridge-Token line, do not redefine the
# variable, never echo the token back.
BRIDGE_HEADERS = {"Content-Type": "application/json",
                  "X-Bridge-Token": "__ORG_TOKEN__"}
PENDING_BRIDGE_WRITE = globals().get("PENDING_BRIDGE_WRITE")

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
    global PENDING_BRIDGE_WRITE
    r = await pyfetch(f"http://127.0.0.1:8765{path}", method="POST",
                      headers=BRIDGE_HEADERS,
                      body=json.dumps(payload))
    t = await r.text()
    d = json.loads(t) if t else {}
    if r.status == 409 and d.get("confirmation_required"):
        PENDING_BRIDGE_WRITE = {
            "path": path,
            "payload": json.loads(json.dumps(payload)),
            "confirmation_token": d.get("confirmation_token"),
        }
        safe = {k: v for k, v in d.items() if k != "confirmation_token"}
        raise RuntimeError(f"bridge {path} -> HTTP 409: {json.dumps(safe)}; "
                           "STOP and ask the user for approval")
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}: {t}")
    return d

async def bridge_commit_approved():
    """Call only in a later turn, after the user explicitly approves."""
    global PENDING_BRIDGE_WRITE
    if not PENDING_BRIDGE_WRITE:
        raise RuntimeError("no pending approved bridge write")
    pending = PENDING_BRIDGE_WRITE
    PENDING_BRIDGE_WRITE = None  # one attempt only, including failures
    payload = json.loads(json.dumps(pending["payload"]))
    payload["confirmation_token"] = pending["confirmation_token"]
    r = await pyfetch(f"http://127.0.0.1:8765{pending['path']}", method="POST",
                      headers=BRIDGE_HEADERS, body=json.dumps(payload))
    t = await r.text()
    if r.status != 200:
        raise RuntimeError(f"bridge {pending['path']} -> HTTP {r.status}: {t}")
    return json.loads(t) if t else {}

# session start (Rule 3) — ONE call: /health already carries the version:
h = await bridge_get("/health")
print(h.get("ok"), h.get("root"), h.get("version"))
```

`/health` → `{"ok": true, ...}` means running; it also shows the shared
root folder and the `version` (older than v2.5 → tell the user "the bridge
app and the skill are out of sync — re-run the installer"). Send
`BRIDGE_HEADERS` on EVERY call, GETs included. Non-200 bodies are JSON with
an `error` (+ often `hint`) — read and adjust; e.g. 401 "missing or invalid
bridge token" → the embedded org token doesn't match this user's bridge:
tell the user *"your bridge token doesn't match the one embedded in this
skill — ask your admin, or paste the current org token into the bridge
settings page"* — do NOT retry unchanged.

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
| write/edit plain text, md, csv, code | `/write {"path","content"}` (overwrite → 409 flow, Rule 7) |
| surgical text replacements | `/edit {"path","edits":[…],"dry_run":true}` — show the diff, then apply via 409 flow |
| new Word document | use the fixed in-memory Word recipe below → `/write_b64` (do NOT use `/docx_write`) |
| new PDF | `/pdf_from_text {"out":"x.pdf","blocks":[…]}` |
| Excel rows (create or append) | `/xlsx_append {"path":"x.xlsx","rows":[[…]],"header":[…]}` |
| fill a .docx template | `/docx_merge {"path","out","values":{…}}` |

3. POST it. 409 → Rule 7 (confirm with the user, resend same payload
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

The fixed timestamp and sorted part names make this package deterministic, but
still build it only once. A new target is written immediately. If the target
exists, `bridge_post` saves the exact payload and stops: follow Rule 7, then in
the later approved turn call only `d = await bridge_commit_approved()` before
verification. Do not rebuild the document. After a 200 response, verify with
`/docx_read` and report the returned `written` path. Do not use `/docx_write`
for new Word documents in packaged installations. For richer formatting,
expand the OOXML parts while preserving deterministic ZIP metadata and this
approval-safe `/write_b64` flow.

## Recipe C — legacy formats (.doc/.xls/.ppt)

Convert to a modern format first, then Recipe A/B on the product:

```python
d = await bridge_post("/convert", {"path": "old.doc", "out": "new.docx"})
# A new output needs no confirmation. If the output already exists,
# follow the 409 approval flow in Rule 7. 501 → the user has no
# LibreOffice: say so and ask them to convert manually.
```

## Error phrases — say these EXACTLY, then stop

| Response | Tell the user |
|---|---|
| fetch/`/health` failure | "Your Open File Bridge app isn't running. Please start the Open File Bridge app, then ask me again." |
| 401 | "This bridge requires an access token — ask your admin for the current org token, or paste it into the Open File Bridge settings page." |
| 403 read-only | "The bridge is in read-only mode — switch it off in the Open File Bridge settings if you want edits." |
| `approval_error: expired` | "The approval window expired before I could complete the change. Please review the action above and approve it again." |
| `approval_error: invalid` | "The previous approval is no longer valid. Please review the action above and approve it again." |
| `approval_error: payload_changed` | "The requested change is different from the action you approved. Please review the revised action and approve it again." |
| 429 | "The write-rate safety brake tripped (many writes in a minute). Please confirm you want me to continue." |
| 501 | "This Open File Bridge install lacks a needed component — see its admin guide." |

## Detection

`await bridge_get("/health")` → `{"ok": true}` = running. Anything
else → Rule 4. `/health` reports the bridge version; older than v2.5
→ out of sync.
