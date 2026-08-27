---
name: local-file-bridge
description: Read, write, edit and CREATE files — including Word/Excel/PowerPoint/PDF — in the user's chosen local folder via the File Bridge app (http://127.0.0.1:8765). Use with Code Interpreter (Pyodide engine) enabled.
---

# Local File Bridge

Access files in **the user's own computer** through their local File Bridge service (running at `http://127.0.0.1:8765`). The user has explicitly installed and authorized this — files NEVER pass through the Open WebUI server; all access happens from the user's browser via the Code Interpreter (Pyodide), which runs on the user's machine.

## Bridge API

| Endpoint | Method | Use |
|---|---|---|
| `/health` | GET | Check bridge is running |
| `/list?path=.` | GET | Recursive folder listing (path, type, size, mtime) |
| `/stat?path=X` | GET | Size/mtime/**kind** (text, zip=docx/xlsx/pptx, pdf, image, legacy=doc/xls/ppt) |
| `/read?path=X` | GET | Read **text** file (utf-8, ≤200 KB) |
| `/read_b64?path=X` | GET | Read **binary** file as base64 (≤8 MB) — for Office/PDF/images |
| `/write` | POST | Write **text** file `{"path","content"}` |
| `/write_b64` | POST | Write **binary** file `{"path","b64"}` — for Office/PDF/images |

## Bootstrap helpers (run once per session)

```python
from pyodide.http import pyfetch
import json, base64, io

async def bridge_get(path, params=None):
    url = f"http://127.0.0.1:8765{path}"
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    r = await pyfetch(url)
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}")
    return await r.json()

async def bridge_post(path, payload):
    r = await pyfetch(f"http://127.0.0.1:8765{path}", method="POST",
                      headers={"Content-Type": "application/json"},
                      body=json.dumps(payload))
    if r.status != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {r.status}")
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

Install libraries — **prefer the bridge's local wheels** (faster, works
offline; served from the user's own disk). Always try local first, PyPI as
fallback:

```python
import micropip
from pyodide.http import pyfetch
r = await pyfetch("http://127.0.0.1:8765/wheels")
wheel_urls = (await r.json())["urls"]
if wheel_urls:
    await micropip.install(wheel_urls)          # openpyxl, python-docx,
else:                                            # python-pptx, fpdf2 + deps
    await micropip.install(["openpyxl", "python-docx", "python-pptx", "fpdf2"])
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

Reading existing PDFs: no pure-Python extractor works reliably in Pyodide —
ask the user to paste key passages, or use the OWUI knowledge base upload.

### Plain text / CSV / Markdown

Use `/read` + `/write` (text endpoints) — no libraries needed. CSV parses
with the stdlib `csv` module from a `StringIO`.

## Workflow rules

1. **Check first:** `await bridge_get("/health")` — if not ok or fetch fails,
   tell the user: "Your File Bridge isn't running — start the File Bridge app,
   then ask me again." Do NOT retry more than once.
2. **`/stat` before `/read`:** if kind is `zip`/`pdf`/`image`, use the b64
   endpoints; only `text` kinds work with `/read`.
3. **Never overwrite without saying so.** When editing an existing file, state
   what will change; prefer writing new versions alongside (e.g. `report_v2.docx`)
   unless the user asked for in-place edit.
4. **Legacy formats (.doc/.xls/.ppt) are read-only-ish:** no library support —
   tell the user to convert to the modern format first (e.g. open in Office →
   Save As .docx).
5. **Keep files under ~8 MB** (bridge cap). Bigger → ask the user first.
6. The browser may ask once for local-network permission — user must click Allow.
7. Only touch files inside the shared folder. Never construct `../` paths.
8. Supported libraries are pure-Python only. No pandas/openpyxl-with-numpy
   extras: if a micropip install fails, fall back to stdlib approaches.

## Detection

`await bridge_get("/health")` → `{"ok": true}` means running; the response also
shows the shared root folder.
