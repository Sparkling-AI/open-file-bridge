---
name: open-file-bridge
description: "MUST-CALL before ANY file task. User's real files are reachable ONLY via the local bridge — call this skill first and run its Bootstrap. Files written with open()/os in this sandbox are LOST and INVISIBLE to the user; claiming success without a bridge response is a failure."
---

# Local File Bridge — skill v3.0-EXT (extension backend)

> **PUBLISHING NOTE (2026-09-06):** `scripts/setup_owui.py` does not know
> this variant yet — admins publish it MANUALLY (OWUI Workspace → Skills,
> paste this file's body; keep the `open-file-bridge-ext`-style id distinct
> from the main skill). Wiring it into setup_owui is follow-up work.

> **EXTENSION VARIANT (3.0 — Stage 3)** — use when the user has the Open
> File Bridge **browser extension**. The extension IS the backend now: no
> desktop app, no bridge process, no token. Requests travel
> `postMessage → page relay → extension service worker → the user's
> granted folder` (Chrome File System Access API). This works on **any
> OWUI origin** — public HTTPS included — because nothing touches
> localhost at all.
>
> If `ofb_fetch` requests time out (no reply within ~30 s), the extension
> is NOT installed or its content script is not on this page — tell the
> user the extension is required (Chrome Web Store / unpacked load) and
> stop; do not fall back to `pyfetch 127.0.0.1` (there is no app to talk
> to in extension mode).

Requires extension ≥ **3.0.0** (`/version` reports `3.0.0-EXT`;
`skill_min` 2.5). The endpoint surface mirrors bridge app 2.11 — every
recipe from the standard skill works with the exceptions below.

## What is different from the app-backed skill

- `bridge_get` / `bridge_post` / `ofb_fetch` / `ofb_fetch_b64` — IDENTICAL
  signatures and behavior (bootstrap below).
- **No token, no 401 flow.** The security boundary is the browser's own
  folder-permission gate + the relay's descendant-iframe/id/rate gates.
- **Permission errors (HTTP 403 `permission_needed: true`)** — after a
  browser restart the user must re-confirm folder access once. Tell the
  user: click the Open File Bridge toolbar icon → **Reconnect**. On the
  browser's bubble, **"Allow on every visit" is the persistent choice**
  (asks never again); "Allow this time" works but repeats after every
  restart. The folder is NOT re-picked.
- **Engine endpoints (HTTP 409 `engine_needed: true`)** — PDF text/PDF
  ops/OCR run in the extension's engine tab. Tell the user: click the
  toolbar icon → open the engine tab → keep it open while we work with
  PDFs or scanned files.
- `/pdf_text`, `/pdf_op`, `/ocr`, `/ocr_pdf`, `/image_info`, `/image_b64`,
  `/csv_head`, `/csv_stats` — same request/response shapes as the app.
- **Moved endpoints** (501 with a recipe): `/docx_read /docx_write
  /docx_merge /docx_mailmerge /pptx_read /pptx_from_template /xlsx_read
  /xlsx_append /eml_read /html_text /pdf_from_text` — the office stack
  runs HERE in Pyodide: fetch bytes with `/read_b64`, write with
  `/write_b64` (recipes below).
- `/convert` is GONE (501). Legacy formats: ask the user to open the file
  in their office app (Word / Excel / LibreOffice) and save as
  `.docx` / `.xlsx`, then we can read and edit it.
- `/link` + `/reveal` degrade honestly: the extension page shows the file
  path with a copy button — it cannot open the OS file manager.

## OCR notes (tesseract.js, bundled fast models)

Languages bundled: `eng swe dan nor deu fra spa chi_sim` (set with
`POST /ocr/lang {"lang": "swe+eng"}` or per-request `lang=`; combo langs
matter — `swe+eng` fixes å/ä/ö AND digits, each alone can break one).
One known caveat: an isolated ALL-CAPS diacritic token (e.g. a lone
"ÅÄÖ") may decode as AAO. Words with diacritics in normal case are
accurate; if a critical all-caps token looks wrong, ask the user to
confirm it rather than trusting the OCR blindly.

## Bootstrap (run once per session)

```python
import sys, json, base64, asyncio
from js import parent
from pyodide.ffi import create_proxy, to_js

_pending = {}
_next = [0]
_installed = [False]

def _install():
    if _installed[0]:
        return
    import js
    def on_message(ev):
        try:
            d = getattr(ev, "data", None)
            dd = d.to_py()          # JsProxy -> dict (REQUIRED before .get)
            if dd.get("ofb") is not True:
                return
            fut = _pending.pop(dd.get("id"), None)
            if fut is not None and not fut.done():
                fut.set_result(d)
        except Exception:
            pass
    js.addEventListener("message", create_proxy(on_message))
    _installed[0] = True

async def ofb_fetch(method, path, body=None):
    _install()
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    rid = _next[0]; _next[0] += 1
    _pending[rid] = fut
    msg = {"ofb": True, "id": rid, "method": method, "path": path}
    if body is not None:
        msg["body"] = body
    parent.postMessage(to_js(msg), "*")
    ev = await asyncio.wait_for(fut, 60.0)
    return ev.data.to_py()

async def ofb_fetch_b64(path):
    _install()
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    rid = _next[0]; _next[0] += 1
    _pending[rid] = fut
    parent.postMessage(to_js({"ofb": True, "id": rid, "method": "GET",
                              "path": path, "b64": True}), "*")
    ev = await asyncio.wait_for(fut, 120.0)
    d = ev.data.to_py()
    if not d.get("ok"):
        raise RuntimeError(f"bridge {path} -> HTTP {d.get('status')}: {d.get('error')}")
    return base64.b64decode(d["bodyB64"])

async def bridge_get(path, params=None):
    url = path
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    d = await ofb_fetch("GET", url)
    if d["status"] != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {d['status']}: {d['body'][:400]}")
    return json.loads(d["body"])

async def bridge_post(path, payload):
    d = await ofb_fetch("POST", path, json.dumps(payload))
    if d["status"] != 200:
        raise RuntimeError(f"bridge {path} -> HTTP {d['status']}: {d['body'][:400]}")
    return json.loads(d["body"])

async def read_binary(path):
    d = await bridge_get("/read_b64", {"path": path})
    return base64.b64decode(d["b64"])

async def write_text(path, text: str):
    return await bridge_post("/write", {"path": path, "content": text})

async def write_binary(path, data: bytes):
    return await bridge_post("/write_b64",
        {"path": path, "b64": base64.b64encode(data).decode()})
```

**First call:** `h = await bridge_get("/health")` — one call answers
everything: extension alive, `version` (`3.0.0-EXT`), `addons`
(`{pdf: true, ocr: true}`), `roots` (granted folders; empty = the user
has not picked one yet → tell them to click the toolbar icon and choose
a folder). `/health` failing with a TIMEOUT means no extension; a 503
"no shared folder" means no folder picked yet.

**Errors are JSON** — read them, don't blind-retry. The three
user-actionable shapes: 403 `permission_needed` (Reconnect → Allow on
every visit), 409 `engine_needed` (open the engine tab), 503 no-folder
(pick a folder). Never repeat a failed request unchanged.

Writes are IMMEDIATE and snapshot-first (extension inherits the 2.11
no-approval contract): every overwrite keeps a copy under
`.ofb-snapshots/`, deletes under `.ofb-trash/` — recovery via
`/versions/list` + `/versions/restore`, `/trash/list` + `/trash/restore`.
Writes >1 MB chunk automatically inside the pipe (model code never
chunks manually).

## Office files in extension mode (the moved endpoints)

`/xlsx_read /docx_read /pptx_read /eml_read /html_text` answer
`501 {moved: true, hint: …}` — parse in Pyodide instead. First install
the bundled wheels (served by the extension through the same pipe; all
pure-Python, no micropip):

```python
import zipfile, io, sysconfig
SP = sysconfig.get_paths()["purelib"]          # never hardcode this

async def install_bridge_wheels(*prefixes):
    wl = (await bridge_get("/wheels"))["wheels"]
    for name in wl:
        if not prefixes or any(name.startswith(p) for p in prefixes):
            data = await ofb_fetch_b64("/wheels/" + name)
            zipfile.ZipFile(io.BytesIO(data)).extractall(SP)
    # e.g. install_bridge_wheels("openpyxl", "et_xmlfile")
```

Then (examples):

```python
# xlsx:
await install_bridge_wheels("openpyxl", "et_xmlfile")
import openpyxl
wb = openpyxl.load_workbook(io.BytesIO(await read_binary(path)))
rows = [[c.value for c in r] for r in wb.active.rows]
wb.create_sheet("new")  # … edit …
buf = io.BytesIO(); wb.save(buf)
await write_binary(out_path, buf.getvalue())

# docx:
await install_bridge_wheels("python_docx", "typing_extensions", "lxml")  # if lxml wheel present
import docx
d = docx.Document(io.BytesIO(await read_binary(path)))
paras = [p.text for p in d.paragraphs]

# pdf from text (fpdf2):
await install_bridge_wheels("fpdf2", "fonttools")
from fpdf import FPdf  # (see standard skill's pdf_from_text recipe)
```

(eml/html stay stdlib: `email.message_from_bytes(await read_binary(p))` /
regex-strip after `read_binary(...).decode("utf-8", "replace")`.)

Compiled data-science wheels (`pandas`/`matplotlib` …) still come from
Pyodide's own lock via `micropip.install("pandas")` — fetched from the
OWUI origin, not through the pipe.

Everything else in the standard skill applies verbatim: reading rules
(`/peek` first), `/link` outcome links, caching notes, strict-mode
rules.
