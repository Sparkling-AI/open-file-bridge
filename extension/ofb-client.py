"""Open File Bridge — Pyodide client (ofb_client) 3.7.2-inj.

Same helpers as the SKILL-EXT bootstrap, refactored for injection:
exec()'d from js.OFB_CLIENT_PY inside Open WebUI's sandbox iframe.
Differences from the pasted bootstrap:
  - ofb_init(token=None) replaces the top-level `await bridge_get("/health")`
    (exec() cannot run top-level awaits; the cell itself runs under
    runPythonAsync, so `await ofb_init(...)` works).
  - transport "js": awaits js.ofb.fetch(...) — the MAIN-world transport
    the extension registers at document_start. Falls back to the exact
    3.3.x postMessage pipe when absent (worker executor, older ext).
Nothing here is a secret: the token arrives per call from the cell.
"""

import json, base64, asyncio, random, urllib.parse, io, zipfile, sysconfig
import js
from pyodide.ffi import create_proxy, to_js
try:
    from js import parent            # iframe sandbox; absent in a worker
except ImportError:
    parent = None

OFB_CLIENT_VERSION = "3.7.2-inj"
_TOKEN = [""]
_S = {"pending": {}, "n": 0, "bc": None, "relay": None, "roots": [],
      "wid": "w%08x" % random.getrandbits(32), "transport": None}


class BridgeError(RuntimeError):
    pass


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
        if d.get("ofb") is not True or d.get("method") is not None or "ok" not in d:
            return                   # only RESPONSES resolve futures
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


async def _fetch_js(method, path, body, b64, timeout):
    # js.ofb.fetch is an awaitable JsProxy; resolve through asyncio
    fut = asyncio.get_event_loop().create_future()
    try:
        jp = js.ofb.fetch(method, path,
                          body,               # None -> JS null/undefined
                          bool(b64), _TOKEN[0],
                          int(timeout * 1000))
        res = await jp
        d = res.to_py() if hasattr(res, "to_py") else dict(res)
        return d
    except Exception as e:
        raise BridgeError(str(e))


async def ofb_fetch(method, path, body=None, b64=False, timeout=45.0):
    _install()
    use_js = (_S.get("transport") != "pm") and getattr(js, "ofb", None) is not None
    if use_js:
        return await _fetch_js(method, path, body, b64, timeout)
    # legacy pipe (3.3.x shape) — worker executor / older extension
    rid = '%s-%d' % (_S["wid"], _S["n"]); _S["n"] += 1
    fut = asyncio.get_event_loop().create_future()
    _S["pending"][rid] = fut
    msg = {"ofb": True, "id": rid, "method": method, "path": path}
    if body is not None: msg["body"] = body
    if _TOKEN[0]: msg["token"] = _TOKEN[0]
    if b64: msg["b64"] = True
    if parent is not None:
        parent.postMessage(_js(msg), "*")
    else:
        if _S["bc"] is None:
            raise BridgeError("no transport (worker without BroadcastChannel)")
        if _S["relay"] is None:
            await _elect()
        if _S["relay"] is None:
            _S["pending"].pop(rid, None)
            raise BridgeError("Open File Bridge extension not present on this page (no relay answered)")
        msg["to"] = _S["relay"]
        _S["bc"].postMessage(_js(msg))
    try:
        return await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        _S["pending"].pop(rid, None); _S["relay"] = None
        raise BridgeError(f"{path.split('?')[0]}: no reply in {timeout:.0f} s — retry once; narrow the request (a path=, fewer files)")


def _url(path, params=None):
    if not params:
        return path
    return path + "?" + "&".join(f"{k}={urllib.parse.quote(str(v), safe='/')}" for k, v in params.items())


class BridgeError_with_info(BridgeError):
    """BridgeError whose .info carries the full parsed error body and
    .status the HTTP number (pilot 3.7.0 blocker 5)."""
    def __init__(self, msg, info, status=None):
        super().__init__(msg)
        self.info = info
        self.status = status


def _check(path, d, key="body"):
    """Raise BridgeError on any non-200. The message carries a BOUNDED
    excerpt; the full parsed error body rides on .info so batch results
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
    """Whole-file read. 413 (over the b64 cap) falls back to a range
    loop (pilot 3.7.0 blocker 4) so a 9 MB log no longer needs manual
    read_binary_range plumbing."""
    try:
        return base64.b64decode((await bridge_get("/read_b64", {"path": path}))["b64"])
    except BridgeError_with_info as e:
        if getattr(e, "status", None) != 413:
            raise
        st = e.info.get("size_bytes") if isinstance(e.info, dict) else None
        if not st:
            raise
        chunks = []
        off = 0
        while off < st:
            chunks.append(await read_binary_range(path, off, min(4_000_000, st - off)))
            off += min(4_000_000, st - off)
        return b"".join(chunks)


async def read_binary_range(path, offset, length):
    return base64.b64decode((await bridge_get(
        "/read_b64", {"path": path, "offset": int(offset), "length": int(length)}))["b64"])


async def read_text(path, encoding="utf-8-sig"):
    return (await read_binary(path)).decode(encoding, "replace")


async def write_text(path, text):
    return await bridge_post("/write", {"path": path, "content": text})


async def write_binary(path, data):
    return await bridge_post("/write_b64", {"path": path, "b64": base64.b64encode(data).decode()})


async def install_bridge_wheels(*prefixes):
    sp = sysconfig.get_paths()["purelib"]; got = []
    for name in (await bridge_get("/wheels"))["wheels"]:
        if not prefixes or any(name.lower().startswith(p.lower()) for p in prefixes):
            zipfile.ZipFile(io.BytesIO(await ofb_fetch_b64("/wheels/" + name))).extractall(sp)
            got.append(name)
    return got


def bridge_path(p):
    parts = [x for x in str(p).replace("\\", "/").split("/") if x and x != "."]
    roots = _S["roots"]
    # 3.7.2 (tester): match the RIGHTMOST segment naming a root — a
    # pasted absolute path may contain an ANCESTOR folder sharing the
    # root's name (N:\Shared\…\shared\…), and the leftmost match cut
    # at the ancestor, 404ing every path under it. The mounted folder
    # is the last place the root's own name can appear in the prefix.
    for i in range(len(parts) - 1, -1, -1):
        hit = [r for r in roots if parts[i].lower() in {
            str(r.get("alias") or "").lower(), str(r.get("path") or "").lower(),
            str(r.get("id")).lower()}]
        if hit:
            rest = "/".join(parts[i + 1:])
            return (hit[0]["id"] + "/" + rest).rstrip("/") if len(roots) > 1 else rest
    if parts and (len(parts[0]) == 2 and parts[0][1] == ":"):
        raise BridgeError(f"no shared folder contains {p!r} — shared roots: "
                          f"{[r.get('alias') or r.get('id') for r in roots]}")
    return "/".join(parts)


def out(obj, limit=4000):
    s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, default=str)
    print(s if len(s) <= limit else s[:limit] + f" …[+{len(s) - limit} chars cut — print a smaller slice]")


async def ofb_init(token=None, transport="auto", quiet=False):
    """First line of a chat: import js; exec(js.OFB_CLIENT_PY);
    await ofb_init("<bridge token>"). Calls /health, remembers the
    roots and prints a one-line summary. transport: "auto" (js pipe
    when present), "js" (injection only), "pm" (legacy pipe only)."""
    if token:
        ofb_set_token(token)
    if transport in ("js", "pm"):
        _S["transport"] = transport
    h = await bridge_get("/health")
    _S["roots"] = h.get("roots") or []
    if not quiet:
        out({"version": h.get("version"),
             "client": OFB_CLIENT_VERSION,
             "roots": [{"id": r.get("id"), "name": r.get("alias") or r.get("path"),
                        "perm": r.get("perm")} for r in _S["roots"]],
             "helpers": "ready"})
    return h
