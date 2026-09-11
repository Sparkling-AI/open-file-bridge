---
name: open-file-bridge
description: "Read, create, edit, search, convert, and organize documents and other files in the folder the user shared from their computer through the Open File Bridge extension. Use for requests involving the user's local Word, Excel, PowerPoint, PDF, image, archive, email, text, or code files. MUST-CALL before acting: sandbox file APIs cannot reach that folder; only a successful bridge response confirms the work."
---

# Local File Bridge — skill v3.0.28-EXT (extension backend, TOKEN variant)

> **TOKEN variant — publish this only when the extension's 🔒 Security
> card HAS a bridge token set** (no token set? publish `SKILL-EXT.md`
> instead). The org's bridge token is already embedded in the bootstrap
> below — `_TOKEN` was pre-filled when this skill was prepared. Copy
> the bootstrap EXACTLY; do not remove or redefine the `_TOKEN` line;
> and NEVER echo the token back in your answer. Paste the description
> above into the skill's description field and everything below this
> line into its content.

The Open File Bridge **browser extension** is the file backend: no
desktop app, no bridge process. Requests travel
`postMessage or BroadcastChannel → page relay → extension service
worker → the user's granted folder` (Chrome File System Access API).
OWUI may execute cells either in an iframe sandbox (`postMessage`
transport) or a pyodide worker (`BroadcastChannel`); the bootstrap
detects the context and picks the transport automatically. This works
on **any OWUI origin** — public HTTPS included.

If `ofb_fetch` raises "no relay answered", the extension is NOT
installed/enabled on this page — tell the user the extension is
required and stop; do not fall back to `pyfetch 127.0.0.1` (there is no
app to talk to). A slow TIMEOUT (no reply in ~30 s) usually means the
elected relay's tab was closed mid-session — retry once (the bootstrap
re-elects automatically).

Requires the Open File Bridge Chrome extension (any `3.0.x-EXT` build;
`GET /version` names the running one). The endpoint surface mirrors the
desktop bridge app — every recipe below is complete on its own.

## What is different from the app-backed skill

- `bridge_get` / `bridge_post` / `ofb_fetch` / `ofb_fetch_b64` — IDENTICAL
  signatures and behavior (bootstrap below).
- **Sender security gate** — the extension serves ONLY the one Open
  WebUI site the user allowed (set in the extension's settings). Two
  403 shapes can come back, each self-explaining:
  - `{"security_locked": true}` or `{"origin_blocked": true}` — this
    site is not the allowed one. Tell the user ONCE: click the Open
    File Bridge **toolbar icon → 🔒 Security → Allowed site → set it to
    <the origin named in the error>** (one click if it already shows
    under "Recently blocked"), then retry. Do NOT retry before they
    confirm; every retry while blocked fails identically.
  - `{"token_required": true}` — the token embedded below is wrong or
    was rotated in the extension's settings. Ask the user ONCE for the
    current bridge token (toolbar icon → 🔒 Security → Bridge token →
    Show/copy), then run `ofb_set_token("<the pasted token>")` and
    retry. NEVER echo the token back in your answer; it rides in the
    `token` field of every request from then on (the bootstrap handles
    that automatically).
- **Permission errors (HTTP 403 `permission_needed: true`)** — after a
  browser restart or extension update the user must re-confirm folder
  access once. Tell the user: click the Open File Bridge toolbar
  icon → **Reconnect**. On the browser's bubble, **"Allow on every
  visit" is the persistent choice** (asks never again); "Allow this
  time" works but repeats after every restart. The folder is NOT
  re-picked.
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

Languages bundled (21, alphabetical — same set as the desktop app):
`ara chi_sim chi_tra dan deu eng est fin fra hun ita jpn kor lav lit
nor pol por rus spa swe`. Older extension builds bundle only 8 of
these — trust `/health`'s `ocr_langs_available` over this list (set
with `POST /ocr/lang {"lang": "swe+eng"}` or per-request `lang=`;
combo langs matter — `swe+eng` fixes å/ä/ö AND digits, each alone can
break one).
One known caveat: an isolated ALL-CAPS diacritic token (e.g. a lone
"ÅÄÖ") may decode as AAO. Words with diacritics in normal case are
accurate; if a critical all-caps token looks wrong, ask the user to
confirm it rather than trusting the OCR blindly.

Small photos are auto-upscaled before recognition (sign snapshots,
crops — a big accuracy win). If lines STILL look garbled, do not burn
cells re-trying languages: give the best reading you got, say the
photo is hard, and show it to the user —
`GET /image_b64?path=…` then echo
`![name](its data_url)` in your reply (the sanctioned display
convention; big images auto-downscale, `shrunk` says so). The user can
read a sign themselves faster than three more OCR passes.

**Vision input — the honest rule:** code output reaches you
as TEXT only. You CANNOT see local images through the bridge, no
matter what you print in a cell (OWUI never attaches cell output to
your vision input). If the task truly needs YOU to look at a local
image (layout, charts, handwriting, "what is this a picture of"), tell
the user: **"please attach/upload the image directly in this chat"** —
an attached upload is the one input path vision models actually
consume. Meanwhile use OCR for text and the display convention above
to SHOW the user the image. For ORIGINAL bytes (e.g. to embed into a
document), use `/read_b64`, not `/image_b64`.

## Bootstrap (run once per session)

**Run the block EXACTLY as written.** The transport (and, in the token
variant, the bridge token) lives inside it — hand-written or trimmed
copies fail the sender gate with 403 `token_required` and waste turns.
After an extension update, a page that was already open holds a STALE
relay that drops the token silently: if a correct token still gets
`token_required`, tell the user to REFRESH the page once and retry.

```python
import sys, json, base64, asyncio, random
import js
from pyodide.ffi import create_proxy, to_js

# OWUI may run cells in a pyodide WORKER: no parent window exists
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
_TOKEN = ["__BRIDGE_TOKEN__"]   # org bridge token EMBEDDED (filled in when
                     # this skill was prepared). NEVER redefine it, and
                     # NEVER echo the value back in your answer

def ofb_set_token(t):
    _TOKEN[0] = str(t or "")

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
            # only RESPONSES resolve futures: responses carry ok, requests
            # carry method. "ofb-pipe" is a broadcast channel — with two OWUI
            # tabs open, the OTHER tab's worker posts requests with ids that
            # collide with ours, and without this guard its REQUEST would
            # steal our pending future (observed live: ofb_fetch "returned"
            # the request itself and bridge_get died with KeyError 'status').
            if dd.get("ofb") is not True or dd.get("method") is not None \
                    or "ok" not in dd:
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
    # session-unique ids: two OWUI tabs = two workers with counters that
    # both start at 0 — bare ints collide on the shared channel (see the
    # _on_msg guard); the _wid prefix makes every id globally unambiguous
    rid = _wid + "-" + str(_next[0]); _next[0] += 1
    _pending[rid] = fut
    msg = {"ofb": True, "id": rid, "method": method, "path": path}
    if body is not None:
        msg["body"] = body
    if _TOKEN[0]:
        msg["token"] = _TOKEN[0]
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
everything: extension alive, `version` (`3.0.x-EXT`), `addons`
(`{pdf: true, ocr: true}` — bundled capability), `engine_alive`
(false is NORMAL — engines are lazy; they auto-start the moment you
call an engine endpoint, so do NOT treat it as unavailable), `roots`
(granted folders; empty = the user
has not picked one yet → tell them to click the toolbar icon and choose
a folder). "no relay answered" or "extension not present" means no
extension on this page; a 503 "no shared folder" means no folder picked
yet. A raw TIMEOUT is rare — retry once (the relay election
self-heals), then treat it as a dead extension. The first call may
instead return 403 `security_locked`/`origin_blocked`
or 403 `token_required` — see the sender-gate bullet above for the
exact one-shot recovery (user allows the site / pastes the token).

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
403 `permission_needed` (Reconnect → Allow on every visit), 403
`security_locked`/`origin_blocked` (site not allowed — user sets it in
the extension settings; retry ONCE after they confirm), 403
`token_required` (ask for the paste ONCE, `ofb_set_token`, retry —
never echo the token), 409
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
endpoint — `/files`, `/ls`, `/dir`, `/entries` do not exist; don't
discovery-scan, the endpoint table above is complete.

**Diagnostics: ONE `print(json.dumps(...))` per cell — and NEVER
print inside a loop.** OWUI chats show only the LAST stdout line of a
cell; sessions have lost a 403 this way and then guessed nonexistent
endpoints, and lost every loop-iteration result but the last.
Accumulate into a dict/list across iterations, then print it ONCE at
the end.

Writes are IMMEDIATE and snapshot-first: every overwrite keeps a copy
under `.ofb-snapshots/`, deletes under `.ofb-trash/` — recovery via
`/versions/list` + `/versions/restore`, `/trash/list` + `/trash/restore`.
To READ an old version WITHOUT changing the live file, use
`POST /versions/read {"path": …, "ts": …}` (text by default,
`"b64": true` for binary) — do NOT restore just to read. Restoring IS
a write (it replaces the live file) and asks for approval worded as a
restore. Writes >1 MB chunk automatically inside the pipe (model code
never chunks manually).

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
from fpdf import FPdf  # build the document with its usual API (add_page, cell, multi_cell)
```

(eml/html stay stdlib: `email.message_from_bytes(await read_binary(p))` /
regex-strip after `read_binary(...).decode("utf-8", "replace")`.)

Compiled data-science wheels (`pandas`/`matplotlib` …) still come from
Pyodide's own lock via `micropip.install("pandas")` — fetched from the
OWUI origin, not through the pipe.

Reading rules, `/link` outcome links and caching match the desktop-app
skill; when unsure what a file is, call `/peek` first (a few tokens).
