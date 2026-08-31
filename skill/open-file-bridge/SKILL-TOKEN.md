---
name: open-file-bridge
description: "MUST-CALL before ANY file task. User's real files are reachable ONLY via the local bridge (http://127.0.0.1:8765) — call this skill first and run its Bootstrap. Files written with open()/os in this sandbox are LOST and INVISIBLE to the user; claiming success without a bridge response is a failure."
---

# Local File Bridge — skill v2.9

> Requires bridge ≥ **2.5** (checked at bootstrap below; newer bridges are
> always fine — the API is backward-compatible).

Access files in **the user's own computer** through their local Open File Bridge service (running at `http://127.0.0.1:8765`). The user has explicitly installed and authorized this — files NEVER pass through the Open WebUI server; all access happens from the user's browser via the Code Interpreter (Pyodide), which runs on the user's machine.

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
| `/image_b64?path=X&max_bytes=` | GET | Image as a **data URL** (`data:image/png;base64,…`), size-capped (default 4 MB; auto-downscaled when pymupdf is present) — for showing images in chat |
| `/reveal?path=X` | GET | Open the user's file manager at the file — **consent-gated** (403 unless the user enabled it in settings) |
| `/link` | POST | `{"path":"x.pdf"}` → user-clickable links for your ANSWER: `open_url` (default app) + `reveal_url` (file manager), multi-use; TTL is configured on the user's bridge (default 7 days; older bridges 1 h) — **outcome links** (v2.7+) |
| `/ocr/config` | GET | Current OCR language + installed languages |
| `/convert` | POST | `{"path":"old.doc","out":"new.docx"}` — **LibreOffice headless conversion**: legacy .doc/.xls/.ppt → modern, office → PDF, xlsx → csv, docx → png/html. Format pair comes from the extensions; confirm flow; 501 with install hint if the user has no LibreOffice |
| `/pdf_from_text` | POST | `{"out":"x.pdf","blocks":[{"style":"title\|h1\|h2\|body\|pagebreak","text":"…"}]}` — create PDF natively (fpdf2 addon, no Pyodide shim); confirm flow |
| `/docx_write` | POST | `{"out":"x.docx","sections":[{"style":"h1\|h2\|paragraph\|list\|numbered\|pagebreak","text":"…","items":["…"]}]}` — create Word from structured sections; confirm flow |
| `/xlsx_append` | POST | `{"path":"log.xlsx","rows":[["a",1],…],"header":["…"],"sheet":"Sheet1"}` — create-or-append Excel (header only applied on create; appending to an existing file needs confirm) |
| `/docx_mailmerge` | POST | `{"path":"template.docx","out":"merged/{{client}}.docx"\|"bundle.zip","rows":[…]\|"rows.xlsx"\|"rows.csv"}` — one document per row; collision + unresolved-pattern checks BEFORE confirm |
| `/eml_read?path=X&max_chars=` | GET | Read .eml: headers + date_iso, text body (html stripped), attachment **metadata only**; .msg → 415 hint |
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
lines and respects the user's ignore lists (plus OS junk like `.DS_Store`,
always hidden at any depth) — if a file you expect is absent,
it may be excluded in settings; say so rather than scanning manually.

**Editing text files:** prefer `/edit` with `dry_run: true` — it returns a
unified diff you can show the user; applying without `dry_run` follows the
standard 409 confirmation flow (snapshot + token). For many scattered
replacements in one file, one `/edit` call beats several `/write` calls.
Writes into ignored paths are refused (`excluded by ignore settings`) — that
is the user's deliberate ignore configuration, not a bug: tell the user
(patterns are editable in the Open File Bridge settings page) instead of retrying
or writing somewhere else.

## Bootstrap helpers (run once per session)

**First call (and only preflight-ish call you need):** `GET /health` — no
token required. One call answers everything: bridge running, `version`,
`security` mode, `addons`. If the fetch itself fails, the bridge isn't
running — tell the user and stop (do not retry more than once). Version
rule (one-way floor, no lockstep): if the bridge `version` is OLDER than
**2.5** (this skill's minimum), say once: "your Open File Bridge app is
older than this skill — some endpoints may be missing; updating the app
is recommended" — then continue with what works. Newer bridge versions
are always fine; never warn about them. If the bridge is MUCH newer than
this skill (e.g. a whole minor version), optionally suggest the admin
re-run `scripts/setup_owui.py` to refresh the skill — a hint, not a
warning.

**Headers:** send `BRIDGE_HEADERS` on EVERY call — GETs included, not just
POSTs. **This is the TOKEN variant of the skill**: your bridge runs in
Tier-2 token mode and the org token is already embedded in the code block
below — `BRIDGE_HEADERS` is pre-defined WITH the token. Copy it exactly;
do not remove the `X-Bridge-Token` line, do not redefine the variable,
and NEVER echo the token back in your answer.

```python
from pyodide.http import pyfetch
import json, base64, io

BRIDGE_HEADERS = {"Content-Type": "application/json",
                  "X-Bridge-Token": "__ORG_TOKEN__"}   # org token EMBEDDED — required on every call

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

**Errors are JSON — read them, don't blind-retry.** Every non-200 response
carries an `error` field (often a `hint` telling you the next step). HTTP
401 `"missing or invalid bridge token"` → the token in `BRIDGE_HEADERS`
doesn't match this user's bridge: tell the user *"your bridge token
doesn't match the one embedded in this skill — ask your admin, or paste
the current org token into the bridge settings page"*, and do NOT retry.
HTTP 409 → confirmation flow (see write rules). Never repeat a failed
request unchanged.

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
(see admin guide) or change the default in the Open File Bridge settings page.

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

### Images — showing them in chat

`/image_b64` returns an image as a **data URL** (with `mime`, `width`,
`height`, `bytes`; size-capped via `max_bytes`, default 4 MB — images over
the cap are auto-downscaled by the bridge when pymupdf is installed).
OWUI's convention for images produced by code is a printed data URL (its
matplotlib integration does exactly this): fetch the data URL, then
**include it in your reply as markdown** so the chat renders it —

```python
d = await bridge_get("/image_b64", {"path": "photos/site.jpg"})
print(d["mime"], d["width"], "x", d["height"], d["bytes"], "bytes")
# then in your ANSWER (not code):  ![site.jpg](<the data_url value>)
```

Keep `max_bytes` modest (e.g. 300000–800000) when echoing into chat —
data URLs are ~1.35× the image size in tokens-of-text. For OCR-ing the
image instead of showing it, use `/ocr`.

**Truth about vision input:** code output reaches you as TEXT in this
environment — a data URL in stdout does not let a vision model literally
SEE local image pixels. If true visual inspection is required, ask the
user to attach the image file to their chat message (that is the input
path vision models actually consume). `/image_b64` and
`/pdf_text?mode=images` are for SHOWING the user, and for answering
questions about files via OCR/text extraction.

**PDF page surgery** (`/pdf_op`): split extracts selected pages to
`<out-base>.pN.pdf` files; merge concatenates 2-20 PDFs in order; rotate
turns selected pages by `angle` (90/180/270). Overwriting an existing
out file follows the 409 confirmation flow.

### Plain text / CSV / Markdown

Use `/read` + `/write` (text endpoints) — no libraries needed. CSV parses
with the stdlib `csv` module from a `StringIO`.

## Data analysis (pandas / matplotlib)

For real tabular analysis — grouping, pivots, joins, time series, charts —
install **pandas + matplotlib via micropip**. These are COMPILED packages:
they resolve against the Pyodide distribution OWUI itself runs, using its
bundled package lock (numpy and friends come as dependencies automatically —
do NOT list them). One install per chat session:

```python
import micropip
await micropip.install(["pandas", "matplotlib"])   # deps auto-resolve
import pandas as pd, matplotlib
```

Data in: fetch raw bytes via the bridge (`/read` for CSV, `/xlsx_read` for
Excel as a JSON grid) and wrap in pandas. Write results back with
`bridge_write_bytes(...)` (see bootstrap helpers), then show charts in chat
with `/image_b64`.

```python
# CSV → DataFrame (bytes from the bridge, no CORS/file-system access needed)
from io import StringIO
csv = await bridge_get("/read", {"path": "data/sales-2026.csv"})
df = pd.read_csv(StringIO(csv["content"]))
monthly = df.groupby("month")["amount"].sum()

# Chart → save locally → show in chat (Agg only; no GUI backends in wasm)
import matplotlib.pyplot as plt
matplotlib.use("Agg")
ax = monthly.plot(kind="bar", figsize=(7, 4), title="Monthly sales")
ax.set_xlabel("Month"); ax.set_ylabel("SEK")
plt.tight_layout()
buf = io.BytesIO(); plt.savefig(buf, format="png", dpi=110); plt.close()
await bridge_write_bytes("charts/monthly-sales.png", buf.getvalue())

d = await bridge_get("/image_b64", {"path": "charts/monthly-sales.png",
                                    "max_bytes": 500000})
# then in your ANSWER:  ![monthly-sales.png](<the data_url value>)
```

Excel: `/xlsx_read` returns the grid as JSON (`data: [[...]]`, first row =
headers when `header_row=1`) — `pd.DataFrame(d["data"][1:], columns=d["data"][0])`.
For WRITING Excel with formatting, stay on openpyxl from the bridge's local
wheels (see Office files section) — pandas `to_excel` also uses openpyxl,
installed from the same local wheels.

**Do NOT take pandas/numpy/matplotlib from `/wheels`** — those bridge-served
wheels are pure-Python office packages only. Compiled wasm packages must come
from the running Pyodide's own lock (micropip resolves them by name); a
version mismatch (wrong Python/ABI tag) fails at import with a confusing
`ModuleNotFoundError`/`AttributeError`, not a clear version error.

If micropip cannot reach the package index (strictly-offline OWUI without
its bundled package dir), say so and fall back to stdlib `csv` + `statistics`
for simple aggregations — most group-by sums/means/counts still work.

## Outcome links — files you created or changed

When a step ENDS with a new or changed file the user will care about
(created, edited, converted), the write response ALREADY carries clickable
links — no extra call:

```python
d = await bridge_post("/write", {"path": "notes v2.md", "content": ...})
# d["written"], d["bytes"] — and d["links"]["open_url"] + d["links"]["reveal_url"]
```

`POST /link {"path":…}` exists for one case only: RE-MINTING after a user
reports an expired link (link lifetime is set on the user's bridge —
default 7 days; the user can change it in the bridge settings page).

Then in your ANSWER (not code), for a file:

> **`Fortnox Bookkeeping Context.pdf`** · [📄 Open](open_url) · [📂 Show in folder](reveal_url)

For a folder: name + [📂 Show in folder](reveal_url) only.

- Labels are ALWAYS "📄 Open" and "📂 Show in folder" — OS-neutral words; the
  clicked page itself names Finder / Explorer / Files.
- Paste the URLs exactly as returned — never construct a /click/… URL yourself,
  and never fetch one (they are for the user's browser click; the bridge
  refuses scripted/cross-site triggers).
- **Outcomes only.** Passing mentions — listings, "I found 9 files",
  citations — stay plain code spans (click copies the name). Never wrap a
  whole listing in links. One link pair per outcome file; with many outcome
  files, link the headline ones and list the rest as code spans.
- Links are multi-use and expire after the bridge's configured lifetime
  (default 7 days; the user can change it in the bridge settings page).
  If the user reports an expired page, call `POST /link` with the path
  and give the fresh URLs.
- `/link` 404s on bridges older than 2.7 → skip the links silently and keep
  the plain code span (at most one attempt).

## Workflow rules

1. **Check once per session:** `await bridge_get("/health")` — it doubles as
   the version check (see Bootstrap). If not ok or fetch fails, tell the
   user: "Your Open File Bridge isn't running — start the Open File Bridge
   app, then ask me again." Do NOT retry more than once. Within the same
   chat session you do not need to re-check before every call.
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
shows the shared root folder, version, security mode and addons. For a plain
"what's in my folder" request, `/health` (once per session) followed directly
by `/list` or `/directory_tree` is enough — two calls total.
