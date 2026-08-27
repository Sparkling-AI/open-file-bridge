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
| `/ocr?path=X&lang=swe+eng&max_pages=5` | GET | **OCR** scanned PDF/image (tesseract) |
| `/ocr/config` | GET | Current OCR language + installed languages |
| `/wheels` | GET | Local wheel URLs for micropip (openpyxl etc.) |

**Reading rules (P0):** `/read` is text-only and **fail-closed** — unknown
extensions and binary files are rejected with 415 + a routing hint. When
unsure what a file is, call `/peek` first (a few tokens) and follow its
`hint`. Never try to `/read` a PDF/Office/image directly.

**Large files:** `/read` windows at 2000 lines by default and clips lines at
500 chars. The response tells you `total_lines` and `start_line=N` to
continue. NEVER dump whole large files into chat — read windows, summarize,
and cite `path:line`.

## Bootstrap helpers (run once per session)

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

Install libraries from the **bridge's local wheels** (served from the user's
own disk — offline-safe, version-pinned; do NOT use PyPI):

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

### Plain text / CSV / Markdown

Use `/read` + `/write` (text endpoints) — no libraries needed. CSV parses
with the stdlib `csv` module from a `StringIO`.

## Workflow rules

1. **Check first:** `await bridge_get("/health")` — if not ok or fetch fails,
   tell the user: "Your File Bridge isn't running — start the File Bridge app,
   then ask me again." Do NOT retry more than once.
2. **`/stat` or `/peek` before `/read`:** if kind is `zip`/`pdf`/`image`, use the b64
   endpoints; only `text` kinds work with `/read`. Unknown extension or unsure →
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
