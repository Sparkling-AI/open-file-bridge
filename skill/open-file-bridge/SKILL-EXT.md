---
name: open-file-bridge
description: "MUST-CALL before ANY file task. User's real files are reachable ONLY via the local bridge — call this skill first and run its Bootstrap. Files written with open()/os in this sandbox are LOST and INVISIBLE to the user; claiming success without a bridge response is a failure."
---

# Local File Bridge — skill v3.0.10-EXT (extension backend)

> **PUBLISHING NOTE (2026-09-06):** `scripts/setup_owui.py` does not know
> this variant yet — admins publish it MANUALLY (OWUI Workspace → Skills,
> paste this file's body; keep the `open-file-bridge-ext`-style id distinct
> from the main skill). Wiring it into setup_owui is follow-up work.

> **EXTENSION VARIANT (3.0 — Stage 3)** — use when the user has the Open
> File Bridge **browser extension**. The extension IS the backend now: no
> desktop app, no bridge process, no token. Requests travel
> `postMessage or BroadcastChannel → page relay → extension service
> worker → the user's granted folder` (Chrome File System Access API).
> OWUI ≥ 0.11 may execute cells in a pyodide **worker** (no parent
> window); the bootstrap detects the context and picks the transport —
> `postMessage` in an iframe sandbox, `BroadcastChannel` in a worker
> (requires extension ≥ 3.0.1 relay). This works on **any OWUI origin**
> — public HTTPS included — because nothing touches localhost at all.
>
> If `ofb_fetch` raises "no relay answered", the extension is NOT
> installed/enabled on this page — tell the user the extension is
> required (Chrome Web Store / unpacked load) and stop; do not fall back
> to `pyfetch 127.0.0.1` (there is no app to talk to in extension
> mode). A slow TIMEOUT (no reply in ~30 s) now almost always means the
> elected relay's tab was closed mid-session — retry once (the
> bootstrap re-elects automatically on the next call).

Requires extension ≥ **3.0.1** (`/version` reports `3.0.5-EXT` on
current builds; `skill_min` 2.5). ≥ **3.0.3** = invisible engine
auto-start (offscreen); on 3.0.1–3.0.2 engines still auto-start but in a
background tab. The endpoint surface mirrors bridge app 2.11 — every
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
- **Engines start themselves — never ask the user to open anything.**
  PDF text/PDF ops/OCR run in a hidden engine document that the extension
  starts automatically the FIRST time you call `/pdf_text`, `/pdf_op`,
  `/ocr`, or `/ocr_pdf` (the first call takes a few extra seconds).
  `"engine_alive": false` on `/health` is the NORMAL resting state, NOT
  a blocker and NOT a reason to ask the user — just call the endpoint.
  You should never see 409 `engine_needed`; if one appears anyway,
  retry ONCE, and only if it persists tell the user: toolbar icon →
  settings → OCR card → check "Auto-start the engines" and press
  "Open engine tab" (manual fallback).
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

Small photos are auto-upscaled before recognition (sign snapshots,
crops — big accuracy win since ext 3.0.5). If lines STILL look
garbled, do not burn cells re-trying languages: give the best reading
you got, say the photo is hard, and show it to the user —
`GET /image_b64?path=…` then echo
`![name](data:image/jpeg;base64,…)` in your reply (the sanctioned
display convention; 8 MB cap). The user can read a sign themselves
faster than three more OCR passes.

## Bootstrap (run once per session)

```python
import sys, json, base64, asyncio, random
import js
from pyodide.ffi import create_proxy, to_js

# OWUI >= 0.11 may run cells in a pyodide WORKER: no parent window exists
# there, and `from js import parent` ImportError-kills the whole cell. In
# an iframe sandbox parent EXISTS. Guard it and pick the transport at runtime.
try:
    from js import parent
except ImportError:
    parent = None

_pending = {}
_next = [0]
_installed = [False]
_bc = None            # worker transport (BroadcastChannel "ofb-pipe")
_relay_tag = [None]   # elected relay — the ONE tab that forwards for us
_wid = "w%08x" % random.getrandbits(32)

def _install():
    if _installed[0]:
        return
    global _bc
    def _on_msg(ev):
        try:
            d = getattr(ev, "data", None)
            if d is None:
                return
            dd = d.to_py()          # JsProxy -> dict (REQUIRED before .get)
            if dd.get("ofb") is not True:
                return
            fut = _pending.pop(dd.get("id"), None)
            if fut is not None and not fut.done():
                fut.set_result(d)
        except Exception:
            pass
    js.addEventListener("message", create_proxy(_on_msg))  # iframe replies
    try:
        _bc = js.BroadcastChannel.new("ofb-pipe")           # worker replies
        _bc.addEventListener("message", create_proxy(_on_msg))
    except Exception:
        _bc = None
    _installed[0] = True

async def _elect_relay(timeout=0.25):
    # every relay tab on this origin answers; the smallest tag is the single
    # forwarder (2 OWUI tabs must not run a write twice). No answer = no
    # extension on this page.
    found = []
    def _on_hello(ev):
        try:
            dd = getattr(ev, "data", None).to_py()
            if dd.get("ofbRelay") is True and dd.get("workerId") == _wid:
                found.append(dd.get("tag"))
        except Exception:
            pass
    proxy = create_proxy(_on_hello)
    _bc.addEventListener("message", proxy)
    _bc.postMessage(to_js({"ofbHello": True, "workerId": _wid}))
    await asyncio.sleep(timeout)
    try: _bc.removeEventListener("message", proxy)
    except Exception: pass
    _relay_tag[0] = min(found) if found else None

async def ofb_fetch(method, path, body=None, b64=False, timeout=60.0):
    _install()
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    rid = _next[0]; _next[0] += 1
    _pending[rid] = fut
    msg = {"ofb": True, "id": rid, "method": method, "path": path}
    if body is not None:
        msg["body"] = body
    if b64:
        msg["b64"] = True
    if parent is not None:
        parent.postMessage(to_js(msg), "*")     # iframe-sandbox executor
    else:
        if _bc is None:
            _pending.pop(rid, None)
            raise RuntimeError("no transport available (worker without "
                               "BroadcastChannel) — extension mode needs "
                               "a Chromium-based browser")
        if _relay_tag[0] is None:
            await _elect_relay()
        if _relay_tag[0] is None:
            _pending.pop(rid, None)
            raise RuntimeError("Open File Bridge extension not present on "
                               "this page (no relay answered)")
        msg["to"] = _relay_tag[0]
        _bc.postMessage(to_js(msg))             # worker executor
    try:
        ev = await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        _relay_tag[0] = None    # elected tab may have closed — re-elect next call
        raise
    return ev.to_py()   # fut holds the event's data (set in _on_msg) — do NOT unwrap .data again

async def ofb_fetch_b64(path, timeout=120.0):
    d = await ofb_fetch("GET", path, b64=True, timeout=timeout)
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
everything: extension alive, `version` (`3.0.3-EXT`), `addons`
(`{pdf: true, ocr: true}` — bundled capability), `engine_alive`
(false is NORMAL — engines are lazy; they auto-start the moment you
call an engine endpoint, so do NOT treat it as unavailable), `roots`
(granted folders; empty = the user
has not picked one yet → tell them to click the toolbar icon and choose
a folder). "no relay answered" or "extension not present" means no
extension on this page; a 503 "no shared folder" means no folder picked
yet. A raw TIMEOUT is now rare — retry once (the relay election
self-heals), then treat it as a dead extension.

**Permission preflight (same /health call):** every root carries a
`perm` field. If ANY root shows `"perm": "prompt"` instead of
`"granted"`, STOP — do not call any other endpoint. Tell the user
plainly: *"your browser needs to re-confirm folder access once — click
the Open File Bridge toolbar icon (it opens this extension's settings page), press
**Reconnect** on the folder, and in Chrome's bubble choose **'Allow on
every visit'** (the persistent choice; 'Allow this time' repeats after
every restart). The folder is not re-picked."* Then WAIT for the user
to confirm before retrying. A browser restart or extension reload
resets `perm` to `prompt`; every read/write would fail with 403
`permission_needed` until they Reconnect.

**Errors are JSON** — read them, don't blind-retry. The shapes:
403 `permission_needed` (Reconnect → Allow on every visit), 409
`engine_needed` (auto-start usually handles it — retry once; only if
it persists, the user opens the engine tab from settings), 503
no-folder (pick a folder), 405 wrong method (the error NAMES the right
method — re-issue with it, don't guess endpoints). Never repeat a
failed request unchanged.

**Method cheat** (405 enforces it): reads are **GET** with query
params — `/list /read /peek /stat /search /directory_tree /image_info
/image_b64 /pdf_text /ocr`; writes & actions are **POST** with a JSON
body — `/link /write /write_b64 /write_many /edit /delete /zip /unzip
/versions/* /trash/* /ocr_pdf /pdf_op`. `/list` is THE listing
endpoint — `/files`, `/ls`, `/dir`, `/entries` do not exist (real
chats kept probing them); don't discovery-scan, the endpoint table
above is complete.

**Diagnostics: ONE `print(json.dumps(...))` per cell — and NEVER
print inside a loop.** OWUI chats show only the LAST stdout line of a
cell (observed 2026-09-07: a 403 `permission_needed` was printed,
vanished, and the session went guessing nonexistent endpoints;
2026-09-09: a loop printing one dict per iteration hid every result
but the last — the model literally could not see its own /image_b64
output). Accumulate into a dict/list across iterations, then print it
ONCE at the end.

Writes are IMMEDIATE and snapshot-first: every overwrite keeps a copy
under `.ofb-snapshots/`, deletes under `.ofb-trash/` — recovery via
`/versions/list` + `/versions/restore`, `/trash/list` + `/trash/restore`.
Writes >1 MB chunk automatically inside the pipe (model code never
chunks manually).

**Out-of-chat confirmations (default on).** Deletes and overwrites of
EXISTING files push an Approve/Deny popup into the chat page (the
extension renders it) and the request WAITS ~20 s for the click:
- user clicks **Approve in time → your SAME call returns the real
  result** (200 + the write outcome — no retry needed).
- `403 {confirmation_required, timed_out: true}` → they hadn't clicked
  yet. Tell them once, plainly ("an approval popup appeared — please
  click Approve"), WAIT for them to confirm, then retry the exact same
  request ONCE. A LATE click still counts (single-use, 5 min).
- `denied: true` → the user refused: do not retry; ask in chat what
  they want instead.
Creating a NEW file never asks. (Admins can change the scope in the
extension settings; `confirmation_required` only appears when a
confirmation is actually required.)

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
