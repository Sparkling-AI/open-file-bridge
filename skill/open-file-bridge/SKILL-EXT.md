---
name: open-file-bridge
description: "MUST-CALL before ANY file task. User's real files are reachable ONLY via the local bridge — call this skill first and run its Bootstrap. Files written with open()/os in this sandbox are LOST and INVISIBLE to the user; claiming success without a bridge response is a failure."
---

# Local File Bridge — skill v2.10-EXT (extension transport)

> **PUBLISHING NOTE (2026-09-06):** `scripts/setup_owui.py` does not know
> this variant yet — admins publish it MANUALLY (OWUI Workspace → Skills,
> paste this file's body; keep the `open-file-bridge-ext`-style id distinct
> from the main skill). Wiring it into setup_owui is follow-up work; when
> that lands, this variant joins the main version numbering.

> **EXTENSION VARIANT** — use when the user has the Open File Bridge
> **browser extension** installed (Open File Bridge Connector). Everything
> below is identical to the standard skill EXCEPT the transport: requests
> travel `postMessage → page relay → extension service worker → bridge`
> instead of direct `pyfetch` to `http://127.0.0.1:8765`. This transport
> works on **any OWUI origin** (public HTTPS included) because the loopback
> fetch happens in the extension, exempt from CORS and Chrome's Local
> Network Access gate.
>
> If `ofb_fetch` requests time out (no reply within ~30 s), the extension is
> NOT installed (or has no token configured) — fall back to the standard
> `pyfetch` transport and, if that fails too on a public site, tell the user
> the extension is required there.

Requires bridge ≥ **2.5** (checked at bootstrap below; newer bridges are
always fine — the API is backward-compatible). The bridge app itself is
UNCHANGED — extension mode speaks the same v2 HTTP API.

## How the transport differs

- `bridge_get(path, params)` / `bridge_post(path, payload)` keep the SAME
  signatures as the standard skill. Internally they call `ofb_fetch` (the
  postMessage round-trip below) — all recipes in the standard skill that use
  `bridge_get`/`bridge_post` work unchanged.
- **No `BRIDGE_HEADERS`, no token handling.** The tier-2 token lives in the
  extension (`chrome.storage.local`, set once on the extension's options
  page) and is attached by the service worker. Model code never sees it.
- Binary helpers (`read_binary`, wheel installs) use `ofb_fetch_b64` — the
  service worker base64-encodes binary responses (`b64: true` flag).
- The relay rate-limits (120 req/min, 30 in-flight) — batch sensibly, don't
  poll in tight loops.

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
    ev = await asyncio.wait_for(fut, 30.0)
    return ev.data.to_py()

async def ofb_fetch_b64(path):
    _install()
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    rid = _next[0]; _next[0] += 1
    _pending[rid] = fut
    parent.postMessage(to_js({"ofb": True, "id": rid, "method": "GET",
                              "path": path, "b64": True}), "*")
    ev = await asyncio.wait_for(fut, 60.0)
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

**First call:** `GET /health` — `h = await bridge_get("/health")` — one call
answers everything: bridge running, `version`, `security` mode, `addons`.
In extension mode `/health` failing usually means the bridge app is not
running; `ofb_fetch` timing out means the extension/token problem above.
Version rule: if the bridge `version` is OLDER than **2.5**, say once that
the app is older than this skill and updating is recommended, then continue.

**No 401 recovery block in this variant.** If you get HTTP 401
`"missing or invalid bridge token"`, the token configured in the extension
is wrong or missing — tell the user to fix it on the extension's options
page (Open File Bridge Connector → options → token). Do NOT ask the user to
paste a token into chat (that pattern is retired in extension mode).

**Errors are JSON** — read them, don't blind-retry. HTTP 409 →
confirmation flow (same as the standard skill). Never repeat a failed
request unchanged.

## Office files — wheel installs in extension mode

Reading office files is unchanged (`/xlsx_read`, `/docx_read`, `/pptx_read`
GETs). For CREATING files, the standard skill's `micropip.install(urls)`
cannot fetch `http://127.0.0.1:8765/wheels/...` on public-origin sites
(that exact fetch is what the LNA gate blocks). In extension mode, fetch
each wheel binary via `ofb_fetch_b64` and unzip it straight into
site-packages (all bridge-served wheels are pure-Python `py3-none-any` —
no compiled code, no micropip needed):

```python
import zipfile, io, sysconfig
SP = sysconfig.get_paths()["purelib"]
async def install_bridge_wheels(*prefixes):
    wl = (await bridge_get("/wheels"))["wheels"]
    for name in wl:
        if not prefixes or any(name.startswith(p) for p in prefixes):
            data = await ofb_fetch_b64("/wheels/" + name)
            zipfile.ZipFile(io.BytesIO(data)).extractall(SP)
    # e.g. install_bridge_wheels("openpyxl", "et_xmlfile")
```

Do NOT hardcode the site-packages path — resolve it once per session:

```python
import sysconfig
SP = sysconfig.get_paths()["purelib"]   # e.g. /lib/python3.14/site-packages
# then: zipfile.ZipFile(io.BytesIO(data)).extractall(SP)
```
Compiled data-science wheels (`pandas`/`matplotlib` …) still come from
Pyodide's own lock via `micropip.install("pandas")` — those are fetched
from the OWUI origin, NOT localhost, so they are unaffected by the gate.

Everything else in the standard skill applies verbatim: the endpoint table,
reading rules (`/peek` first), 409 confirmation flows, `/link` outcome
links, caching notes, strict-mode rules.
