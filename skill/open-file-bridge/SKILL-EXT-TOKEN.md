---
name: open-file-bridge
description: "Read, create, edit, search, convert, and organize files in the folder the user shared from their computer through the Open File Bridge extension — Word, Excel, PowerPoint, PDF, image, archive, email, text, or code files, INCLUDING trivial asks like 'create a small test file' or 'save 2 lines of text', and when the user attached a file in the chat and wants a changed or new file back. MUST-CALL before acting: the code sandbox's own filesystem (e.g. /mnt/uploads) is a throwaway VM the user cannot see — files written there NEVER reach the user's machine. Only a successful bridge response confirms the work."
---

# Local File Bridge — skill v3.7.3-EXT (extension backend, TOKEN variant)

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
app to talk to). A slow TIMEOUT (no reply in ~45 s) usually means the
elected relay's tab was closed mid-session — retry once (the bootstrap
re-elects automatically).

> Requires the Open File Bridge extension ≥ **3.4.0** (checked on the
> first /health below; newer extensions are always fine — the pipe is
> backward-compatible).

## Rules — read these first (each exists because it failed in a real session)

1. **The sandbox is NOT the user's computer.** `/mnt/uploads`,
   `os.getcwd()`, `open()`, `Path(…)` are a throwaway VM. A file the
   user should end up with is written ONLY with the bridge helpers, and
   only a `written` value in a bridge response proves it exists. Never
   say "saved"/"created" without one.
2. **Run the bootstrap EXACTLY as written — never retype it partially.**
   Copies that dropped helpers caused most trial failures
   (`NameError: read_binary`). If any helper raises `NameError`, the
   sandbox was RESET (the host kills cells at 60 s and recreates it):
   run the whole block again, unchanged, then continue.
3. **Every cell must finish within ~45 s.** Split big jobs across cells
   (`max_pages` on OCR/PDF, windows on /read); never loop a cell over a
   whole worksheet.
4. **Print little.** Everything printed is re-sent to the model on every
   later step. Use `out(obj)` (caps at 4000 chars); never print file
   bytes or base64 (except the one image line of §Showing an image).
5. **Never hand-build binary formats** — no raw PDF syntax, no
   hand-written OOXML XML, no PNG pixel "OCR". Use the helpers and
   endpoints below; if a library is missing, use the named fallback.
6. **Look in the shared folder before answering from general knowledge**
   when the user refers to "my material / the offer / the results".
7. **Errors are explicit — read them, don't guess.** Helpers raise
   `BridgeError` carrying the extension's own message; `e.info` holds
   the FULL parsed error body (`e.info["results"]` for batch 207s,
   `e.info["retry_after_s"]` for rate limits) and `e.status` the HTTP
   number. Never repeat a failed request unchanged.
8. **Find a file before you use it — never guess a path** (E03/D03
   failures). When the folder is unknown, call
   `/find?name=<part of the name>` FIRST. A listing that says
   `truncated: true` never means "not there" — narrow the `path` or
   `/find` again. If `/find` (with `truncated: false`) finds nothing,
   say what you searched and offer close names.
9. **"Change / fix / update this file" means write the SAME path**
   (E01: edits saved as `…_v2_updated.docx` — users lost track of
   which file is current). The snapshot system makes overwrites
   undoable; a NEW name only for a genuinely new, derived output
   (summary, chart, export) or an asked-for copy.
10. **Destructive steps run ONE at a time, sequentially** — never
   `asyncio.gather` on deletes/moves/overwrites (E03: 12 parallel
   deletes, 12 approval cards, 9 duplicates left behind). For batches,
   use the batch endpoints (`/move {"moves": [...]}`,
   `/delete {"paths": [...]}`) — ONE approval card covers the whole
   batch. For more than ~5 items, show the plan and wait for a yes.
11. **Never probe for packages** (`__import__`/`importlib`/try-import
   loops): hosts install a package only when a cell has a literal
   `import name` line, so probes report available packages as missing.
   Write the import directly, as in the recipes.
12. **Safety filters are not obstacles.** If a file is refused as a
   credential or ignored by policy, tell the user why. NEVER suggest
   renaming, copying or moving a file to get around a filter (F01).

## The sandbox is NOT the user's computer (details)

Your code sandbox has its own filesystem — a THROWAWAY VM. Writing a
file there creates NOTHING on the user's machine, however cleanly the
cell runs. This includes trivial asks — "create a small test file",
"save any 2 lines" — the user still means a file they can open, i.e. in
their shared folder. Every file the user should end up with is
created/edited ONLY through the bridge helpers; the write response's
`written` is your proof it exists. After ANY successful write, and
whenever the user asks where a file is, name it as
`folder-name/relative/path` (the `root_name` + `written` fields of the
response, no leading `/`) in a code span. NEVER report `/mnt/uploads/…`
or any sandbox path — if you catch yourself quoting one, you are
describing the wrong file.

Folders also use the bridge: `make_folder(path)` creates a real folder
(nested parents are created, and repeating an existing folder is a no-op).
The response's `created`/`written` fields are the proof; empty folders are
visible to `/list` and `/directory_tree`.

## What is different from the app-backed skill

- **Sender security gate** — the extension serves ONLY the one Open
  WebUI site the user allowed (set in the extension's settings). Two
  403 shapes can come back, each self-explaining:
  - `security_locked` / `origin_blocked` — this site is not the allowed
    one. Tell the user ONCE: click the Open File Bridge **toolbar icon →
    🔒 Security → Allowed site → set it to <the origin named in the
    error>** (one click if it already shows under "Recently blocked"),
    then retry. Do NOT retry before they confirm.
  - `token_required` — the token embedded in the bootstrap is wrong or
    was rotated in the extension's settings. Ask the user ONCE for the
    current bridge token (toolbar icon → 🔒 Security → Bridge token →
    Show/copy), then run `ofb_set_token("<pasted>")`
    and retry. NEVER echo the token back in your answer. If a correct
    token still fails, the page may hold a STALE relay from before an
    extension update — tell the user to REFRESH the page once and retry.
- **Permission errors (403 `permission_needed`)** — after a browser
  restart or extension update the user must re-confirm folder access
  once. Tell the user: click the Open File Bridge toolbar icon →
  **Reconnect**. On the browser's bubble, **"Allow on every visit" is
  the persistent choice**; "Allow this time" repeats after every
  restart. The folder is NOT re-picked.
- **Engines start themselves** — PDF text/PDF ops/OCR run in a hidden
  engine document the extension starts automatically the FIRST time you
  call `/pdf_text`, `/pdf_op`, `/ocr`, or `/ocr_pdf` (the first call
  takes a few extra seconds). `"engine_alive": false` on `/health` is
  the NORMAL resting state — just call the endpoint. If a 409
  `engine_needed` appears anyway, retry ONCE, and only if it persists
  tell the user: toolbar icon → OCR card → check "Auto-start the
  engines" / "Open engine tab".
- **Moved endpoints** (501 + recipe): `/docx_read /docx_write
  /docx_merge /docx_mailmerge /pptx_read /pptx_from_template
  /xlsx_read /xlsx_append /eml_read /html_text /pdf_from_text
  /csv_head /csv_stats` — the office stack runs HERE in Pyodide with
  the bundled wheels (§Office files). `/convert` is GONE (501) except
  as recipes: **xlsx→csv** and **docx→html**.
- No clickable outcome links in extension mode — every write answer
  names the file's `written` path instead.

## Which Open WebUI host

Newer hosts bundle more of the office stack (installed on `import`,
preferred over bridge wheels):

- **0.12.0+**: lxml, python-docx and python-pptx bundled — Word and
  PowerPoint work out of the box. Code that merely *mentions*
  matplotlib no longer crashes.
- **0.11.4+**: openpyxl and seaborn bundled.
- **0.11.0–0.11.3**: matplotlib works; no bundled Office libraries —
  use the bridge wheels; Word/PowerPoint need lxml (often unavailable).
- **0.10.x**: matplotlib is broken in the iframe sandbox; no bundled
  office libraries. Word/PowerPoint are usually NOT available — say so
  and offer `.md`/`.html` instead. Do not hand-write the XML.

On any version: a stdout line starting with `data:image/png;base64,`
becomes an uploaded image link (§Showing an image); `PIL` is not
auto-installed (`import matplotlib` in the same cell loads it).

## Bootstrap (run once per chat, and again after any reset)

**First, try the fast path** (one line, works when the Security card
says "client injection active"):

### Fast path — one-line bootstrap (extension ≥ 3.6.0 with injection)

```python
import js; exec(js.OFB_CLIENT_PY); ofb_set_token("__ORG_BRIDGE_TOKEN__"); await ofb_init()
```

If `js.OFB_CLIENT_PY` raises AttributeError, do NOT report an error —
the host runs cells in a worker or the permission was declined;
silently use the full block below instead.

### Fallback — full bootstrap block (workers, older extensions)

It defines ALL helpers and prints the extension version + the shared
folders (ids, names, permission). It does NOT list files — do that
afterwards with a `path`.

```python
import json, base64, asyncio, random, urllib.parse, io, zipfile, sysconfig
import js
from pyodide.ffi import create_proxy, to_js
try:
    from js import parent            # iframe sandbox; absent in a worker
except ImportError:
    parent = None
_TOKEN = ["__ORG_BRIDGE_TOKEN__"]    # pre-filled; set via ofb_set_token on 403 token_required
_S = {"pending": {}, "n": 0, "bc": None, "relay": None, "roots": [],
      "wid": "w%08x" % random.getrandbits(32)}

class BridgeError(RuntimeError):
    pass

class BridgeError_with_info(BridgeError):
    """Full parsed error body on .info, HTTP number on .status."""
    def __init__(self, msg, info, status=None):
        super().__init__(msg)
        self.info = info
        self.status = status

def ofb_set_token(t):
    _TOKEN[0] = str(t or "")

def _js(d):                          # plain JS object, never a Map
    try:
        return to_js(d, dict_converter=js.Object.fromEntries)
    except Exception:
        return js.JSON.parse(json.dumps(d))

def _on_msg(ev):
    try:
        d = ev.data.to_py()
        # only RESPONSES resolve futures: responses carry ok, requests
        # carry method — with two OWUI tabs open, the OTHER tab's worker
        # posts requests with colliding ids (observed live).
        if d.get("ofb") is not True or d.get("method") is not None or "ok" not in d:
            return
        f = _S["pending"].pop(d.get("id"), None)
        if f is not None and not f.done():
            f.set_result(d)
    except Exception:
        pass

def _install():
    if _S.get("on"):
        return
    js.addEventListener("message", create_proxy(_on_msg))
    try:
        _S["bc"] = js.BroadcastChannel.new("ofb-pipe")
        _S["bc"].addEventListener("message", create_proxy(_on_msg))
    except Exception:
        _S["bc"] = None
    _S["on"] = True

async def _elect(wait=0.25):
    tags = []
    def hello(ev):
        try:
            d = ev.data.to_py()
            if d.get("ofbRelay") is True and d.get("workerId") == _S["wid"]:
                tags.append(d.get("tag"))
        except Exception:
            pass
    p = create_proxy(hello)
    _S["bc"].addEventListener("message", p)
    _S["bc"].postMessage(_js({"ofbHello": True, "workerId": _S["wid"]}))
    await asyncio.sleep(wait)
    _S["bc"].removeEventListener("message", p)
    _S["relay"] = min(tags) if tags else None

async def ofb_fetch(method, path, body=None, b64=False, timeout=45.0):
    """One bridge request. 45 s default: hosts kill code cells at 60 s —
    a longer timeout outlives its own cell."""
    _install()
    rid = _S["wid"] + "-" + str(_S["n"]); _S["n"] += 1
    fut = asyncio.get_event_loop().create_future()
    _S["pending"][rid] = fut
    msg = {"ofb": True, "id": rid, "method": method, "path": path}
    if body is not None: msg["body"] = body
    if _TOKEN[0]: msg["token"] = _TOKEN[0]
    if b64: msg["b64"] = True
    if parent is not None:
        parent.postMessage(_js(msg), "*")            # iframe executor
    else:
        if _S["bc"] is None:
            _S["pending"].pop(rid, None)
            raise BridgeError("no transport (worker without BroadcastChannel) — extension mode needs a Chromium-based browser")
        if _S["relay"] is None:
            await _elect()
        if _S["relay"] is None:
            _S["pending"].pop(rid, None)
            raise BridgeError("Open File Bridge extension not present on this page (no relay answered)")
        msg["to"] = _S["relay"]
        _S["bc"].postMessage(_js(msg))               # worker executor
    try:
        return await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        _S["pending"].pop(rid, None)
        _S["relay"] = None   # elected tab may have closed — re-elect next call
        raise BridgeError(f"{path.split('?')[0]}: no reply in {timeout:.0f} s — retry once, then narrow the request (a path=, fewer files, max_pages)")

def _url(path, params=None):
    if not params:
        return path
    return path + "?" + "&".join(f"{k}={urllib.parse.quote(str(v), safe='/')}" for k, v in params.items())

def _check(path, d, key="body"):
    """Both failure shapes -> one BridgeError with the real reason.
    Message is bounded; the FULL body rides on .info so batch results
    and long hints are never lost."""
    if d.get("status") == 200 and key in d:
        return
    info = d.get("error") or ""
    if d.get("body"):
        try: info = json.loads(d["body"])
        except Exception: info = d["body"][:400]
    msg = f"{path} -> HTTP {d.get('status')}: {json.dumps(info, ensure_ascii=False)[:700]}"
    raise BridgeError_with_info(msg, info, d.get("status"))

async def bridge_get(path, params=None, timeout=45.0):
    d = await ofb_fetch("GET", _url(path, params), timeout=timeout)
    _check(path, d)
    return json.loads(d["body"])

async def bridge_post(path, payload, timeout=45.0):
    d = await ofb_fetch("POST", path, json.dumps(payload), timeout=timeout)
    _check(path, d)
    return json.loads(d["body"])

async def ofb_fetch_b64(path, timeout=45.0):
    d = await ofb_fetch("GET", path, b64=True, timeout=timeout)
    _check(path, d, "bodyB64")
    return base64.b64decode(d["bodyB64"])

async def read_binary(path):
    """File bytes; a 413 (over the 8 MB cap) auto-loops ranges."""
    try:
        d = await bridge_get("/read_b64", {"path": path})
        return base64.b64decode(d["b64"])
    except BridgeError_with_info as e:
        if getattr(e, "status", None) != 413:
            raise
        st = e.info.get("size_bytes") if isinstance(e.info, dict) else None
        if not st:
            raise
        chunks, off = [], 0
        while off < st:
            n = min(4_000_000, st - off)
            chunks.append(await read_binary_range(path, off, n))
            off += n
        return b"".join(chunks)

async def read_binary_range(path, offset, length):
    d = await bridge_get("/read_b64", {"path": path, "offset": offset, "length": length})
    return base64.b64decode(d["b64"])

async def read_text(path, encoding="utf-8-sig"):
    return (await read_binary(path)).decode(encoding, "replace")

async def write_text(path, text):
    return await bridge_post("/write", {"path": path, "content": text})

async def write_binary(path, data):
    return await bridge_post("/write_b64", {"path": path, "b64": base64.b64encode(data).decode()})

async def make_folder(path):
    return await bridge_post("/mkdir", {"path": path})


async def install_bridge_wheels(*prefixes):
    """Extract bundled pure-Python wheels into the sandbox. Try a plain
    import FIRST — hosts 0.11.4+/0.12+ install openpyxl/docx/pptx on
    import, and extracting over them mixes versions."""
    sp = sysconfig.get_paths()["purelib"]; got = []
    for name in (await bridge_get("/wheels"))["wheels"]:
        if not prefixes or any(name.lower().startswith(p.lower()) for p in prefixes):
            zipfile.ZipFile(io.BytesIO(await ofb_fetch_b64("/wheels/" + name))).extractall(sp)
            got.append(name)
    return got

def bridge_path(p):
    """Translate a path the USER typed into a bridge path.

    Explicitly root-qualified input wins, always:
      'r3/reports/x.xlsx'      -> 'r3/reports/x.xlsx'  (root id = r3)
      'Shared/reports/x.xlsx'  -> 'rA/reports/x.xlsx'  (root alias, multi-root)
    A RELATIVE path is never re-anchored on a folder name inside it, so
    'reports/Archive/x.xlsx' stays relative even when another shared
    folder is called 'Archive'.
    Only a pasted ABSOLUTE path ('N:\\...\\<shared folder>\\a', '/Users/…')
    is searched for a shared-folder name; the LAST (deepest) match wins
    because an ANCESTOR of the mounted folder may carry the same name
    (N:\\Shared\\…\\shared\\…). If an absolute path could belong to more
    than one shared folder this raises instead of guessing."""
    parts = [x for x in str(p).replace("\\", "/").split("/") if x and x != "."]
    roots = _S["roots"]
    if not parts:
        return ""

    def _names(r):
        return {str(r.get(k) or "").lower()
                for k in ("alias", "path", "id")} - {""}

    def _hit(seg):
        return [r for r in roots if seg.lower() in _names(r)]

    def _join(r, rest):
        rel = "/".join(rest)
        if len(roots) > 1:
            return (str(r["id"]) + "/" + rel).rstrip("/")
        return rel

    # 1) explicit root qualifier — a root id always, an alias/path only
    # when several folders are shared (the same rule resolveGuarded uses).
    first = _hit(parts[0])
    ids = [r for r in first if str(r["id"]).lower() == parts[0].lower()]
    if ids:
        return _join(ids[0], parts[1:])
    if first and len(roots) > 1:
        return _join(first[0], parts[1:])

    # 2) relative path — returned as typed, never re-anchored on a
    # folder name inside it (a subfolder called like another shared
    # folder must not silently move the target to that other folder)
    raw = str(p)
    drive = len(parts[0]) == 2 and parts[0][1] == ":"
    if not (drive or raw.startswith("/")):
        return "/".join(parts)

    # 3) absolute path: anchor on the deepest shared-folder name
    hits = [(i, r) for i, seg in enumerate(parts) for r in _hit(seg)]
    if not hits:
        raise BridgeError(f"no shared folder contains {p!r} — shared roots: "
                          f"{[r.get('alias') or r.get('id') for r in roots]}")
    ids_found = {str(r["id"]) for _, r in hits}
    if len(ids_found) > 1:
        cands = sorted({f"{r['id']} ({r.get('alias') or r['id']}) -> "
                        f"{_join(r, parts[i + 1:])}" for i, r in hits})
        raise BridgeError(
            f"{p!r} matches more than one shared folder — " + "; ".join(cands) +
            ". Re-send the path with the folder id in front (e.g. "
            f"{hits[0][1]['id']}/<relative path>).")
    i, root = hits[-1]
    return _join(root, parts[i + 1:])

def out(obj, limit=4000):
    """Print cap — everything printed is re-sent to the model later."""
    s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, default=str)
    print(s if len(s) <= limit else s[:limit] + f" …[+{len(s) - limit} chars cut — print a smaller slice]")

async def ofb_init(token=None, transport="auto", quiet=False):
    """(Re)run the first-cell handshake — also callable after the
    fallback block, mirroring the one-liner's ofb_init."""
    if token:
        ofb_set_token(token)
    if transport in ("js", "pm"):
        _S["transport"] = transport
    h = await bridge_get("/health")
    _S["roots"] = h.get("roots") or []
    if not quiet:
        out({"version": h.get("version"),
             "roots": [{"id": r.get("id"), "name": r.get("alias") or r.get("path"),
                        "perm": r.get("perm")} for r in _S["roots"]],
             "helpers": "ready"})
    return h

h = await ofb_init()
```

Helpers: `bridge_get(path, params)` (params URL-encoded for you — å/ä/ö,
spaces, apostrophes fine), `bridge_post(path, payload)`, `ofb_fetch`,
`ofb_fetch_b64(path)`, `read_binary(p)` / `read_binary_range(p, off, len)`
/ `read_text(p)`, `write_text(p, s)` / `write_binary(p, b)` (>1 MB chunks
automatically), `install_bridge_wheels(*prefixes)`, `bridge_path(win_path)`,
`out(obj)`. If ANY of them raises `NameError`, the sandbox was reset —
run the whole block again (rule 2).

**What the first cell can tell you**
- `BridgeError … no relay answered` → the extension is not installed or
  enabled on this page. Tell the user it is required, and stop.
- a root shows `perm: "prompt"` → STOP. Tell the user: toolbar icon →
  **Reconnect** on that folder → in Chrome's bubble choose **"Allow on
  every visit"**. Wait for them.
- 403 `security_locked`/`origin_blocked` → the user sets the allowed
  site (see above), ONCE.
- 403 `token_required` → ask for the token ONCE, `ofb_set_token(<pasted>)`,
  retry. Never echo it.
- No folders (`roots: []`) → the user must click the toolbar icon and
  choose one.
- Version older than 3.4.0 → say once that the extension should be
  updated, then continue with what works.
- The user mentions a desktop "app": that is the old Open File Bridge
  app, a different backend. This skill needs the browser extension in
  Chrome/Edge.

## Paths

- **Several shared folders:** the folder **id** (from the first cell,
  e.g. `r3`) is the first path segment: `r3/BBAF/Output/x.xlsx`. A path
  without an id goes to the FIRST folder — output once landed in the
  wrong place that way. With one shared folder, no id is needed.
- **Windows paths from the user** (`N:\Open Lan Shared\Cost Assurance\
  TELIA ÖPPEN FIBER\202608`) → `bridge_path(that)` returns the bridge
  path. If it raises, either the folder is not shared or the absolute
  path fits more than one shared folder — tell the user which folders
  are and ask which one they meant. Never re-anchor on your own guess.
- A path you already have is used as-is: `rA/reports/Archive/x.xlsx`
  stays in `rA` even when another shared folder is called `Archive`.
  `bridge_path` only searches folder names inside an ABSOLUTE paste.
- Paths never need a leading `/` (a single leading `/` is tolerated and
  stripped). `written` values are ready to reuse as paths as-is.
- File names that are bare credential words (`token.txt`,
  `backup_secrets.yml`, `id_rsa`, `server.pem`, `.env` …) are refused
  with 403 — tell the user. Business names like `Q3_token_usage.xlsx`
  are fine.
- Check a known file cheaply with `/stat` before listing.

## Finding files — cheap first

| Need | Call |
|---|---|
| **where is file X (folder unknown)** | `bridge_get("/find", {"name": "part of the name"})` — case-/accent-insensitive, `*`/`?` wildcards, `path=`/`type=`/`max=` optional. Every match's `path` is ready to reuse and names its folder (`root_id`); a match under `truncated: true` is NOT the whole answer |
| does X exist / size / mtime (path known) | `bridge_get("/stat", {"path": p})` |
| what is in ONE folder (top level) | `bridge_get("/list", {"path": folder})` — non-recursive |
| N levels under a folder | `bridge_get("/list", {"path": p, "depth": 3, "max_entries": 200, "fields": "path,type"})` |
| entries whose NAME matches, in one folder tree | `bridge_get("/list", {"path": p, "name": "ärenden"})` (same folding as /find) |
| full recursive listing | `bridge_get("/list", {"path": p, "depth": 0})` — 500 entries / 10 s cap; `truncated: true` = narrow the path |
| folder structure (tree) | `bridge_get("/directory_tree", {"path": p, "max_depth": 2, "max_entries": 200})` |
| find text in files | `bridge_get("/search", {"q": term, "glob": "docs/*.md", "context": 1, "max": 50})` |
| what kind of file | `bridge_get("/peek", {"path": p})` |

**Never `/list` a share root recursively** (depth=0 at the root of a
network share / OneDrive: 25 timeouts in the trial) — a BARE `/list`
(no path) already answers just the top level plus a hint. Print only
names you need: `out([e["path"] for e in r["entries"] if …])`.
`fields=path,type` skips `size`/`mtime` (each `getFile()` is slow on
network shares).

Limits: reads ≤ 8 MB per whole file (`413` — but `read_binary` switches
to ranges automatically for bigger files); `/read?raw=1` pages are
2 MB each (a full pass over a big log = a handful of calls, not ~50);
≤ 120 bridge requests per minute and ≤ 30 in flight; `BridgeError`
messages name the real reason.

## Reading & writing

- Text you will PARSE (CSV, JSON, code): `read_text(p)` — clean bytes,
  no line numbers. (`/read`'s REST answer adds a `"     N\t"` prefix to
  every line; `raw=1` returns plain text if you ever call it directly.)
- Binary (xlsx, docx, pptx, pdf, images): `read_binary(p)`.
- Write: `write_text(p, s)` / `write_binary(p, b)`. When asked to
  CHANGE an existing file, write the SAME path (rule 9 — snapshots
  make it undoable); a NEW name only for derived outputs. Writing to
  a new folder path creates the folders; `/mkdir {"path": p}` exists
  for empty-folder creation.
- The write answer carries `written` (reuse it as a path — no leading
  `/`, root-prefixed when several folders are shared), `root_id`,
  `root_name` — name files for the user as `root_name/written`.
- Overwrites and deletes of EXISTING files pop an Approve/Deny box in
  the user's page and wait ~20 s: approved → your call returns
  normally; `denied` → do not retry, ask what they want;
  `confirmation_required` + `timed_out` → the box has DISAPPEARED.
  Tell the user: "I need your approval to change `<file>`. When you
  say go, an Approve box appears on this page for 20 seconds." Wait
  for their reply, then retry the SAME request ONCE — the retry shows
  a NEW box. (A late click on the old box is impossible; it closed.)

**Moving / renaming / sorting files** — `POST /move {"from": p, "to": p}`
moves or renames a file or folder inside the shared root (one approval
card, worded as a move; destination must not exist — 409). Batch:
`POST /move {"moves": [{"from", "to"}, …]}` and
`POST /delete {"paths": [p, …]}` — ONE card for the whole batch
("move 12 files"), every item's result reported in `results[]`; a
partial failure returns 207 with `failed` and per-item reasons — say
which originals are still in place, never leave silent duplicates.
- Every overwrite keeps a snapshot (`/versions/list`, `/versions/read`,
  `/versions/restore`); deletes go to `.ofb-trash/` (`/trash/list`,
  `/trash/restore`). `/edit {"path", "edits": [{"from", "to"}],
  "dry_run"}` for text replacements; `/write_many {"writes": [...]}` ≤
  100; `/zip {"members", "out"}`, `/unzip {"path", "dest"}`.
- `/xlsx_read`, `/docx_read`, `/pptx_read`, `/csv_head`, `/convert` …
  answer 501 "moved": those jobs run in Python here (§Office files).

**Files the user attached in the chat** live in `/mnt/uploads`
(sandbox). A changed or new version the user should get must be written
with `write_binary` into their shared folder — say where. If no folder
is shared, tell them to open the chat controls panel (sliders icon, top
right) → **Files**, select the file and press **Download**.

## Office files

Libraries do the work — never edit the XML inside xlsx/docx/pptx by
hand. Import first, wheels only as fallback:

```python
try:
    import openpyxl                      # hosts 0.11.4+ install it on import
except ImportError:
    await install_bridge_wheels("openpyxl", "et_xmlfile"); import openpyxl
try:
    import docx, pptx                    # hosts 0.12+ bundle these (need lxml)
except ImportError:
    try:
        import micropip                # 3.7.1: not auto-imported on 0.10.x
        await micropip.install("lxml")
        await install_bridge_wheels("python_docx", "python_pptx", "typing_extensions")
        import docx, pptx
    except Exception as e:
        out(f"docx/pptx unavailable on this host: {e}")
```

- **If lxml/docx/pptx are unavailable**: for READING, unzip and take
  text from `word/document.xml` / `ppt/slides/*.xml`; for PRODUCING a
  document or deck, write clean `.md`/`.html` and say Word/PowerPoint
  are not available on this host. Never hand-write the XML.
- **Big workbooks**: `openpyxl.load_workbook(buf, read_only=True,
  data_only=True)` + `ws.iter_rows(values_only=True, max_row=…)`.
  Check `ws.max_row` FIRST — formatted templates often report ~1M rows
  and a `ws.cell` loop runs past the 60 s limit. Writing into a
  template: load normally, write only the cells you need, skip
  `MergedCell`s.
- **CSV for Swedish Excel**: prefer a real `.xlsx`; if CSV is asked
  for, use `;` as separator and encode `utf-8-sig`.
- **Pillow**: `import matplotlib` in the same cell loads it, then
  `from PIL import Image`.
- **Outlook `.msg`**: `await install_bridge_wheels("olefile")` then
  `import olefile` (metadata + `olefile.OleFileIO` streams — body text
  often needs the RTF stream; ask for `.eml` if you need the full
  body, stdlib `email` parses it).
- pandas/matplotlib (compiled) come from the host's Pyodide via
  `micropip.install("pandas")` — never from bridge wheels.

```python
# xlsx read → edit → write:
import io
wb = openpyxl.load_workbook(io.BytesIO(await read_binary(path)))
buf = io.BytesIO(); wb.save(buf)
w = await write_binary(out_path, buf.getvalue()); out(w)

# xlsx → csv (the /convert pair that survives as a recipe):
import csv
wb = openpyxl.load_workbook(io.BytesIO(await read_binary(path)), data_only=True)
b = io.StringIO(); wr = csv.writer(b, delimiter=";")
for r in wb.active.iter_rows(values_only=True):
    wr.writerow(["" if v is None else v for v in r])
await write_binary(out_path, b.getvalue().encode("utf-8-sig"))

# docx → html (semantic — headings/paragraphs/lists/tables, not a styled render):
import docx, html
d = docx.Document(io.BytesIO(await read_binary(path)))
# … walk d.paragraphs / d.tables, html.escape text, build tags …
```

## PDF

- Text: `bridge_get("/pdf_text", {"path": p, "pages": "1-3"})`.
- **See a page** (check your own output, show the user):
  `bridge_get("/pdf_text", {"path": p, "pages": "2", "mode": "images"})`
  → `pages[i]["png_b64"]` → print the data-URL line (§Showing an image).
- Scanned PDF / image text: `bridge_get("/ocr", {"path": p,
  "lang": "swe+eng", "max_pages": 5})` — split long documents across
  cells with `max_pages` (rule 3); searchable copy:
  `bridge_post("/ocr_pdf", {"path": p, "out": "x_ocr.pdf"})`. Engines
  start themselves (first call a few seconds slower); retry once on 409.
- **`/pdf_op` works on WHOLE pages only** — the full body shapes:
  `{"op": "merge", "paths": [a, b, …], "out": "c.pdf"}` ·
  `{"op": "split", "paths": [a], "pages": "1-3,5", "out": "a.pdf"}`
  (writes `a.p1.pdf …`) · `{"op": "rotate", "paths": [a], "pages": "2",
  "angle": 90, "out": "a_rot.pdf"}`.
- **"Creating a PDF" and "adding to a PDF" = build pages + merge.**
  Nothing edits what is ON an existing page. To add content, build a
  new page (same page size — read it from the source's MediaBox or
  `/pdf_text` images mode) and `/pdf_op merge`. If the user wanted it
  "inside" a page, say once that it goes on its own page.
- **fpdf2 recipe (creating PDFs from text):** needs ssl + the wheel:

```python
import io, os, re, base64, micropip, importlib, http.client, urllib.request
await micropip.install("ssl")            # fpdf2 imports HTTPSHandler
if not hasattr(urllib.request, "HTTPSHandler"):   # urllib imported pre-ssl
    importlib.reload(http.client); importlib.reload(urllib.request)
await install_bridge_wheels("fpdf2", "defusedxml", "fonttools")
from fpdf import FPDF                    # FPDF, not FPdf
import matplotlib                         # loads Pillow + the DejaVu fonts
FONTS = os.path.join(matplotlib.get_data_path(), "fonts", "ttf")

class Doc(FPDF):
    def footer(self):
        self.set_y(-36); self.set_font("DejaVu", "", 8); self.set_text_color(110, 110, 110)
        self.cell(0, 10, f"{self.footer_text}   ·   {self.page_no()}/{{nb}}", align="C")

def new_doc(footer_text, fmt="A4"):      # fmt may be (w, h) in pt
    pdf = Doc(unit="pt", format=fmt); pdf.footer_text = footer_text
    for st, f in {"": "DejaVuSans", "B": "DejaVuSans-Bold",
                  "I": "DejaVuSans-Oblique", "BI": "DejaVuSans-BoldOblique"}.items():
        pdf.add_font("DejaVu", st, os.path.join(FONTS, f + ".ttf"))
    pdf.set_margins(56, 56, 56); pdf.set_auto_page_break(True, 56); pdf.add_page()
    return pdf

NL = dict(new_x="LMARGIN", new_y="NEXT")   # every block ends at the LEFT margin
def h(pdf, text, level=1):
    size = {0: 20, 1: 13, 2: 11}[level]; pdf.ln({0: 0, 1: 8, 2: 4}[level])
    pdf.set_font("DejaVu", "B", size); pdf.set_text_color(32, 56, 100)
    pdf.multi_cell(0, size * 1.3, text, **NL); pdf.ln(2); pdf.set_text_color(0, 0, 0)
def p(pdf, text, size=10, style=""):
    pdf.set_font("DejaVu", style, size); pdf.multi_cell(0, size * 1.45, text, align="L", **NL); pdf.ln(4)
def bullets(pdf, items, size=10):
    pdf.set_font("DejaVu", "", size)
    for t in items:
        pdf.set_x(pdf.l_margin + 8); pdf.cell(12, size * 1.45, "•")
        pdf.multi_cell(0, size * 1.45, t, align="L", **NL)
    pdf.ln(4)

pdf = new_doc("Document title — summary")
h(pdf, "Document title", 0); p(pdf, "Subtitle · version · date", 9, "I")
h(pdf, "1. Section"); p(pdf, "Paragraph text …"); bullets(pdf, ["First", "Second"])
w = await write_binary("Summary.pdf", bytes(pdf.output()))
shot = await bridge_get("/pdf_text", {"path": "Summary.pdf", "pages": "1", "mode": "images"})
out({"written": w["written"], "pages": pdf.page_no()})
print("data:image/png;base64," + shot["pages"][0]["png_b64"])
```

Always use the DejaVu font from matplotlib — fpdf2's built-in fonts
are Latin-1 only and crash on `—`, `’`, `“`. Never place text with your
own `set_xy`/`cell` layout code: after a `multi_cell` fpdf2 leaves the
cursor at the RIGHT margin, and paragraphs squeeze into the page edge —
that is how a real 2-page summary came out unreadable. `pdf.page_no()`
higher than asked = shorten the text, don't shrink the font. Write in
the language of the user's request, not Swedish by default.

## Showing an image or chart in your answer

A stdout line that STARTS with `data:image/png;base64,` is uploaded by
the host and replaced by `![Output Image](/api/v1/files/<id>/content)`
before you see it. Put THAT link in your answer, copied exactly. PNG
only. Never type/copy base64 yourself, never print a data URL to look
at it, and never echo it as `![name](data_url)` (15–20 K wasted output
tokens and corrupted images in the trial).

**A local image file** (screenshot, photo, slide export): fetch it as
PNG with `/image_b64?path=…&format=png` (3.5.0) and print the data
line — no base64 copying, no matplotlib round trip. SVG files come
back as `image/svg+xml` (rasterising on the host is not supported) —
check `img["data_url"].startswith("data:image/png")` before printing;
for an SVG, print the file PATH for the user instead of a data URL:

```python
img = await bridge_get("/image_b64", {"path": p, "format": "png"})
if img["data_url"].startswith("data:image/png"):
    print(img["data_url"])          # raster image — print the line
else:
    out({"path": p, "note": "vector (svg) — not printable as a data URL"})
```

```python
import io, base64
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(10, 6))
# … draw …
buf = io.BytesIO(); fig.savefig(buf, format="png", dpi=110, bbox_inches="tight"); plt.close(fig)
png = buf.getvalue()
w = await write_binary("usage-chart.png", png)      # the user's copy, if wanted
out({"written": w["written"]})
print("data:image/png;base64," + base64.b64encode(png).decode())   # own line, last
```

An existing picture: `from PIL import Image` (after `import
matplotlib`), `im.thumbnail((1600, 1600))`, save as PNG, print the same
line. A PDF page: `/pdf_text?mode=images` → `png_b64` → the same line.

## Pictures you need to READ (slides, scans, screenshots)

Your code output is TEXT only — you cannot see images through the
bridge. For text inside a picture (including images inside a
PPTX/DOCX: take them out of the zip's `media/` folder), write it into
the shared folder (e.g. `.ofb-tmp/slide4.png`) and call `/ocr` on it.
For a chart or layout you need to UNDERSTAND, ask the user to attach
the image directly in the chat — an attached upload is the one input
path vision models consume. One trial turn burned ~50 cells decoding
PNG pixels into ASCII art; never do that.

## Answers and follow-ups

- Reply — status lines included — in the language of the user's LATEST
  message. Swedish file names are not a reason to switch languages.
- Python state carries over between cells (until a reset): reuse
  workbooks, chart bytes and results instead of recomputing or
  reprinting them.
- A status question ("how is it going?", "did you generate the file?")
  is NOT a request to redo the work: answer from what you did, with the
  `written` path. If the user cannot find a file, check it with
  `/stat` and give the exact `root_name/…` path; re-show a chart from
  the saved PNG.
- When a long job runs, say what each step does in one short line; the
  user sees nothing else until you finish.

## OCR notes

Languages bundled (21, alphabetical — the live list is `/health`'s
`ocr_langs_available`; set with `POST /ocr/lang {"lang": "swe+eng"}` or
per-request `lang=`; combo langs matter — `swe+eng` fixes å/ä/ö AND
digits, each alone can break one): `ara chi_sim chi_tra dan deu eng est
fin fra hun ita jpn kor lav lit nor pol por rus spa swe`. A lone
all-caps diacritic token ("ÅÄÖ") may decode as AAO — ask the user if it
matters. Small photos are auto-upscaled; if lines still look garbled
after one try, give the best reading, say the photo is hard, and show
it to the user (§Showing an image) — they can read a sign faster than
three more OCR passes.

## Diagnostics: ONE `print` per cell — never inside a loop

Prints survive bridge calls on current hosts (3.6+), but everything
printed is re-sent to the model on every later step — keep it small.
Accumulate results into a dict/list across iterations, print it ONCE
at the end (`out()`); never print inside a loop.

## Method cheat (405 enforces it)

Reads are **GET** with query params — `/list /find /read /peek /stat
/search /directory_tree /image_info /image_b64 /pdf_text /ocr`; writes &
actions are **POST** with a JSON body — `/write /write_b64
/write_b64_chunk /write_many /edit /delete /move /mkdir /zip /unzip
/versions/* /trash/* /ocr_pdf /pdf_op`. `/list` is THE listing endpoint —
`/files`, `/ls`, `/dir` do not exist; the endpoint table above is complete.
