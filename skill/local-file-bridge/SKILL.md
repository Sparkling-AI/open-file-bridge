---
name: local-file-bridge
description: Read, write, edit and CREATE files — Word/Excel/PowerPoint/PDF, plus PDF text extraction and OCR of scanned documents — in the user's local folder via the File Bridge app (http://127.0.0.1:8765). Use with Code Interpreter (Pyodide engine) enabled.
---

# Local File Bridge

Access files in **the user's own computer** through their local File Bridge service (running at `http://127.0.0.1:8765`). The user has explicitly installed and authorized this — files NEVER pass through the Open WebUI server; all access happens from the user's browser via the Code Interpreter (Pyodide), which runs on the user's machine.

## Bridge API

| Endpoint | Method | Use |
|---|---|---|
| `/health` | GET | Check bridge is running (also reports `security` mode + addons) |
| `/list?path=.` | GET | Recursive folder listing (path, type, size, mtime) |
| `/stat?path=X` | GET | Size/mtime/**kind** (text, zip=docx/xlsx/pptx, pdf, image, legacy=doc/xls/ppt) |
| `/peek?path=X&bytes=512` | GET | **Identify** any file cheaply: kind sniff, printable ratio, preview, next-endpoint hint |
| `/read?path=X&start_line=1&max_lines=2000` | GET | Read **text** file — numbered lines (`     1→text`), windowed; trailer tells how to continue. Text extensions only (fail-closed) |
| `/read_b64?path=X` | GET | Read **binary** file as base64 (≤8 MB) — for Office/PDF/images |
| `/write` | POST | Write **text** file `{"path","content"}` — overwriting needs a confirmation token (409 flow below) |
| `/write_b64` | POST | Write **binary** file `{"path","b64"}` — same confirmation rule |
| `/versions/list` | POST | `{"path":""}` — metadata of pre-write snapshots (ts/path/size) |
| `/versions/restore` | POST | `{"path","ts"}` — restore needs its own confirmation token |
| `/pdf_text?path=X&pages=1-3,5` | GET | **Extract text layer** from PDF (addon: pymupdf) |
| `/pdf_text?path=X&mode=images&max_pages=100` | GET | **Vision mode**: pages as PNG data URLs (144 dpi, pypdfium2 addon) — for vision models |
| `/ocr?path=X&lang=swe+eng&max_pages=5` | GET | **OCR** scanned PDF/image (tesseract) |
| `/ocr_pdf` | POST | `{"path","out":"x.pdf","lang","dpi"}` → **searchable PDF** (invisible text layer; confirm flow) |
| `/pdf_op` | POST | `{"op":"split\|merge\|rotate","paths":[...],"out","pages":"1-3","angle":90}` — page surgery (confirm on overwrite) |
| `/docx_merge` | POST | `{"path":"template.docx","out","values":{"name":"…"},"strict":false}` — fill `{{placeholders}}` (confirm flow; reports missing) |
| `/pptx_from_template` | POST | `{"path":"deck.potx","out","values":{…},"slides":[{"layout":1,"title":"…","body":"…"}]}` — build deck from corporate template (confirm flow) |
| `/image_info?path=X` | GET | Image dimensions/format/megapixels + EXIF orientation (effective size) — stdlib, no addon |
| `/reveal?path=X` | GET | Open the user's file manager at the file — **consent-gated** (403 unless the user enabled it in settings) |
| `/ocr/config` | GET | Current OCR language + installed languages |
| `/xlsx_read?path=X&sheet=&range=A1:B2&max_rows=` | GET | Read **Excel** as JSON (row_count, headers, grid, merged cells) — no install needed |
| `/docx_read?path=X` | GET | Read **Word** as markdown-ish text (headings, lists, pipe tables) |
| `/pptx_read?path=X` | GET | Read **PowerPoint**: per-slide title + text boxes |
| `/csv_head?path=X&rows=20` | GET | First rows of a CSV without loading it all |
| `/csv_stats?path=X` | GET | CSV shape: row count, columns, type sampling, numeric ranges |
| `/html_text?path=X` | GET | HTML with tags stripped (script/style dropped) — not raw source |
| `/search?q=&glob=*.md&exclude=&context=2&case=0` | GET | Cross-file grep with context lines; respects ignore lists |
| `/edit` | POST | `{"path","edits":[{"old_text","new_text"}],"dry_run":true}` → unified diff preview; real apply needs confirmation token (409 flow) |
| `/directory_tree?path=.&max_entries=500&max_depth=6` | GET | Recursive folder **tree** (name/type/size + children) — respects ignore lists, symlinks never listed |
| `/zip` | POST | `{"members":["dir","file.txt"],"out":"bundle.zip"}` — create archive (members stored flat; recursive for dirs) |
| `/unzip` | POST | `{"path":"bundle.zip","dest":"outdir"}` — extract under dest/ (zip-slip names rejected) |
| `/wheels` | GET | Local wheel URLs for micropip (openpyxl etc.) |

**Caching (P2):** `/pdf_text` and `/ocr` results are cached per
(sha256(file), params) — a repeat call returns the same answer instantly
with `"cached": true`. Editing the file or changing params (lang, dpi,
pages) recomputes. You don't need to do anything; just don't be surprised
by the flag.

**Reading rules (P0):** `/read` is text-only and **fail-closed** — unknown
extensions and binary files are rejected with 415 + a routing hint. When
unsure what a file is, call `/peek` first (a few tokens) and follow its
`hint`. Never try to `/read` a PDF/Office/image directly.

**Large files:** `/read` windows at 2000 lines by default and clips lines at
500 chars. The response tells you `total_lines` and `start_line=N` to
continue. NEVER dump whole large files into chat — read windows, summarize,
and cite `path:line`.

**Reading office files (P1 — read via the BRIDGE, write via Pyodide):**
`/xlsx_read`, `/docx_read`, `/pptx_read`, `/csv_head`, `/csv_stats`,
`/html_text` are plain GETs — **no wheel install, no code needed**. Use them
whenever the task is READ-ONLY:

```python
d = await bridge_get("/xlsx_read", {"path": "reports/financials.xlsx"})
print(d["row_count"], d["headers"], d["merged_cells"])
doc = await bridge_get("/docx_read", {"path": "docs/report.docx"})
print(doc["markdown"])
```

Keep the Pyodide wheel route (below) only for **creating or editing** office
files. If you only need to answer a question about a file, never install.

**Finding things:** `/search` is the top office query tool ("which contract
mentions the termination clause"). It returns per-file matches with context
lines and respects the user's ignore lists — if a file you expect is absent,
it may be excluded in settings; say so rather than scanning manually.

**Editing text files:** prefer `/edit` with `dry_run: true` — it returns a
unified diff you can show the user; applying without `dry_run` follows the
standard 409 confirmation flow (snapshot + token). For many scattered
replacements in one file, one `/edit` call beats several `/write` calls.

## Bootstrap helpers (run once per session)

**Version check first:** call `/version` (no token needed). If the
response's `bridge` version doesn't match what this skill documents
(v2.2), tell the user "the bridge app and the skill are out of sync —
re-run the File Bridge installer or scripts/setup_owui.py" and continue
carefully: newer bridges keep old skills working, but new endpoints
(like /ocr_pdf, /pdf_op, /docx_merge) won't be in an old skill's
vocabulary.

```python
from pyodide.http import pyfetch
import json, base64, io

# If the org set a Tier-2 token (admin will have told you; it looks like
# BRIDGE_TOKEN = "..." in an injected block above), send it on EVERY call:
BRIDGE_HEADERS = {"Content-Type": "application/json"}   # default, no token
# BRIDGE_HEADERS = {"Content-Type": "application/json",
#                   "X-Bridge-Token": BRIDGE_TOKEN}      # when token exists

async def bridge_get(path, params=None):
    url = f"http://127.0.0.1:8765{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    r = await pyfetch(url)
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}: {await r.text()}")
    return await r.json()

async def bridge_post(path, payload):
    r = await pyfetch(f"http://127.0.0.1:8765{path}", method="POST",
                      headers=BRIDGE_HEADERS,
                      body=json.dumps(payload))
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}: {await r.text()}")
    return await r.json()

async def read_binary(path):
    d = await bridge_get("/read_b64", {"path": path})
    return base64.b64decode(d["b64"])

async def write_binary(path, data: bytes):
    return await bridge_post("/write_b64",
        {"path": path, "b64": base64.b64encode(data).decode()})

async def write_text(path, text: str):
    return await bridge_post("/write", {"path": path, "content": text})
```

## Office files (Word / Excel / PowerPoint / PDF)

**Reading** office files needs NO libraries — use the bridge GET endpoints
(`/xlsx_read`, `/docx_read`, `/pptx_read`; see API table above).

**Creating/editing** runs in Pyodide. Install libraries from the **bridge's
local wheels** (served from the user's own disk — offline-safe,
version-pinned; do NOT use PyPI):

**Templates beat blank files:** when the user has a corporate .docx
template with `{{placeholders}}`, or a .potx deck layout, use the bridge's
native template endpoints instead of building from scratch — formatting,
fonts and logos survive:

```python
# Word: fill placeholders (missing keys are reported in the response)
d = await bridge_post("/docx_merge", {"path": "templates/contract.docx",
                                      "out": "out/acme-contract.docx",
                                      "values": {"client_name": "Acme AB",
                                                 "amount": "12500"}})
# PowerPoint: fill the template's own placeholders + append layout-based slides
d = await bridge_post("/pptx_from_template",
                      {"path": "templates/deck.potx", "out": "out/q4.pptx",
                       "values": {"report_title": "Q4 Wrap"},
                       "slides": [{"layout": 1, "title": "Agenda",
                                   "body": "One\nTwo"}]})
```
Both follow the 409 confirmation flow. For docs without a template, keep
the Pyodide route below.

```python
import micropip
from pyodide.http import pyfetch
r = await pyfetch("http://127.0.0.1:8765/wheels")
urls = (await r.json())["urls"]                  # openpyxl, python-docx,
await micropip.install(urls)                      # python-pptx, fpdf2 + deps
```

NOTE: install is per-session (the Pyodide worker is shared and persistent
within a chat session). Importing again later in the same session is instant
(cached). First call in a session: a few seconds. Do NOT reinstall per request
— wrap installs in `try: import openpyxl except ImportError: <install>`:

```python
try:
    import openpyxl
except ImportError:
    <install block above>; import openpyxl
```

**fpdf2 needs this shim before import** (Pyodide has no raw HTTPS sockets):

```python
import urllib.request as _ur, http.client as _hc
if not hasattr(_ur, "HTTPSHandler"):
    class _H(_ur.BaseHandler):
        https_open = lambda self, req: (_ for _ in ()).throw(
            NotImplementedError("no https in pyodide"))
    _ur.HTTPSHandler = _H
if not hasattr(_hc, "HTTPSConnection"):
    class _C(_hc.HTTPConnection):
        def __init__(self, *a, **k):
            raise NotImplementedError("no https in pyodide")
    _hc.HTTPSConnection = _C
```

### Excel (.xlsx) — openpyxl

```python
from openpyxl import Workbook, load_workbook

# CREATE
wb = Workbook(); ws = wb.active
ws.append(["Quarter", "Revenue"]); ws.append(["Q1", 120000])
buf = io.BytesIO(); wb.save(buf)
await write_binary("reports/financials.xlsx", buf.getvalue())

# READ / EDIT an existing file
raw = await read_binary("reports/financials.xlsx")
wb = load_workbook(io.BytesIO(raw))
ws = wb.active
ws["B2"] = 999999                      # edit a cell
buf = io.BytesIO(); wb.save(buf)
await write_binary("reports/financials.xlsx", buf.getvalue())
```

### Word (.docx) — python-docx

```python
from docx import Document
doc = Document()
doc.add_heading("Quarterly Report", 0)
doc.add_paragraph("Auto-generated summary.")
doc.add_page_break(); doc.add_heading("Details", 1)
buf = io.BytesIO(); doc.save(buf)
await write_binary("reports/report.docx", buf.getvalue())

# EDIT existing: raw = await read_binary("x.docx"); doc = Document(io.BytesIO(raw))
# doc.add_paragraph("appended"); save back same way
```

### PowerPoint (.pptx) — python-pptx

```python
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[0])   # title slide
slide.shapes.title.text = "Q3 Review"
slide.placeholders[1].text = "Revenue up 17%"
# content slide with bullets:
s2 = prs.slides.add_slide(prs.slide_layouts[1])
s2.shapes.title.text = "Agenda"
s2.placeholders[1].text = "One\nTwo\nThree"          # paragraphs = bullets
buf = io.BytesIO(); prs.save(buf)
await write_binary("reports/deck.pptx", buf.getvalue())
```

### PDF — fpdf2 (create) 

```python
from fpdf import FPDF   # AFTER the shim above
pdf = FPDF()
pdf.add_page(); pdf.set_font("Helvetica", "B", 16)
pdf.cell(0, 10, "Title", ln=True)
pdf.set_font("Helvetica", size=12)
pdf.multi_cell(0, 8, "Body text, wrapped automatically.")
await write_binary("reports/summary.pdf", bytes(pdf.output()))
```

### PDF reading — use the bridge (NOT Pyodide)

Pyodide cannot parse PDFs, but the bridge can (native Python on the user's
machine). Check `/health` → `addons`:

```python
h = await bridge_get("/health")
if h["addons"]["pdf"]:
    d = await bridge_get("/pdf_text", {"path": "docs/invoice.pdf"})
    text = "\n\n".join(p["text"] for p in d["pages"])
    print(d["page_count"], "pages")

# scanned PDFs (image-only, no text layer) → OCR:
if h["addons"]["ocr"]:
    cfg = await bridge_get("/ocr/config")     # installed languages
    # lang: default is the user's saved setting; override per request when
    # the user says the document language, e.g. Swedish invoice → swe+eng
    d = await bridge_get("/ocr", {"path": "docs/invoice-scanned.pdf",
                                  "lang": "swe+eng", "max_pages": 5})
    for pg in d["pages"]:
        print(pg["page"], "\n".join(pg["lines"]))
```

Language rules: use what `/ocr/config` lists as available. For Nordic office
docs `swe+eng` works well (verified: fixes å/ä/ö AND keeps digits correct —
single-language runs each lose one of the two). Chinese: `chi_sim(+eng)`.
If the needed language is missing, tell the user to add the .traineddata file
(see admin guide) or change the default in the File Bridge settings page.

Rules: try `/pdf_text` first (instant, exact). If it returns empty text the
PDF is scanned → fall back to `/ocr` (tesseract: ~0.5 s/page at 200 dpi —
fast). OCR also works on plain images (png/jpg/bmp/webp/tiff). If
addons.ocr is false, the user's bridge lacks the tesseract binary — suggest
the full installer or `TESSERACT_CMD` (admin guide). addons.pdf false →
`pip install pymupdf`.

**Scans the user wants to ARCHIVE:** after OCR-reading, offer
`/ocr_pdf` — it writes a NEW file with the page image plus an invisible
text layer, so the PDF becomes searchable/copyable forever:

```python
d = await bridge_post("/ocr_pdf", {"path": "scans/receipt-2024.pdf",
                                   "out": "scans/receipt-2024-searchable.pdf",
                                   "lang": "swe+eng"})
# 409 + confirmation_token flow (see write rules) — confirm, re-send
```

**Vision models:** if YOU can see images and the user asks about layout,
charts or handwriting, `/pdf_text?mode=images` returns each page as a PNG
data URL (`png_b64` per page, 144 dpi, ≤100 pages):

```python
d = await bridge_get("/pdf_text", {"path": "docs/annual.pdf",
                                   "mode": "images", "pages": "1-3"})
import base64
png = base64.b64decode(d["pages"][0]["png_b64"])   # show to the user or inspect
```

**PDF page surgery** (`/pdf_op`): split extracts selected pages to
`<out-base>.pN.pdf` files; merge concatenates 2-20 PDFs in order; rotate
turns selected pages by `angle` (90/180/270). Overwriting an existing
out file follows the 409 confirmation flow.

### Plain text / CSV / Markdown

Use `/read` + `/write` (text endpoints) — no libraries needed. CSV parses
with the stdlib `csv` module from a `StringIO`.

## Workflow rules

1. **Check first:** `await bridge_get("/health")` — if not ok or fetch fails,
   tell the user: "Your File Bridge isn't running — start the File Bridge app,
   then ask me again." Do NOT retry more than once.
2. **`/stat` or `/peek` before `/read`:** if kind is `zip`/`pdf`/`image`, use the
   format reader (`/xlsx_read` `/docx_read` `/pptx_read`) or b64 endpoints;
   only `text` kinds work with `/read`. Unknown extension or unsure →
   `/peek` and follow its hint.
3. **Never overwrite without confirmation.** Writing to an EXISTING file returns
   HTTP 409 with a `confirmation_token` (60 s). Show the user what will change,
   and when they approve re-send the SAME request plus `"confirmation_token"`.
   The bridge snapshots the old version automatically — if the user regrets an
   edit, offer `POST /versions/list` → `POST /versions/restore` (restore itself
   needs a confirmation token too). Do NOT resend with a changed payload: the
   token burns on any attempt and you must start a new 409 flow.
4. **Legacy formats (.doc/.xls/.ppt) are read-only-ish:** no library support —
   tell the user to convert to the modern format first (e.g. open in Office →
   Save As .docx).
5. **Never dump whole large files into chat.** Read windows (`start_line` /
   `max_lines`), summarize what you found, and cite `path:line`. For Office
   files, extract and report the relevant parts, not the whole grid.
6. The browser may ask once for local-network permission — user must click Allow.
7. Only touch files inside the shared folder. Never construct `../` paths.
8. Supported libraries are pure-Python only. No pandas/openpyxl-with-numpy
   extras: if a micropip install fails, fall back to stdlib approaches.

## Detection

`await bridge_get("/health")` → `{"ok": true}` means running; the response also
shows the shared root folder.
