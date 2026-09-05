#!/usr/bin/env python3
"""Real-extension e2e runner for the Open File Bridge Connector (Stage 1).

This is the session-2 spike runner (2026-09-05, ALL GREEN) made
self-contained: it embeds its own harness-page builder, builds a test
copy of extension/ (with the extra http://127.0.0.1/* content-script
match the local harness server needs), and can start its own bridge.

What it verifies (proven 2026-09-05, Chrome for Testing 151, full
Chromium — the playwright HEADLESS SHELL cannot load extensions):
  Phase A: no token -> /health 200, /list 401 through the real pipe,
           non-OFB message shape ignored
  Phase C: token set via the REAL options page (chrome.storage) ->
           /list, /read + /write + readback, /state, unknown-endpoint
           404, evil-path negatives, foreign-field drop, PUT refusal,
           and a page-side token-leak sniff (must be 0)
  Phase D: 200 rapid requests -> relay rate limit fires (~120/min)
  Phase E: binary b64 pipe -> openpyxl wheel fetched as b64, extracted
           to purelib, imported, real .xlsx written via /write_b64

Prerequisites:
  - owui-test (or any OWUI) serving Pyodide at $OFB_EXT_OWUI/pyodide/
    (default http://127.0.0.1:8788) — the harness loads Pyodide from it
  - Full Chromium: `playwright install chromium`, found automatically
    under ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
    (override with OFB_EXT_CHROME). NOTE: chrome-linux64, not
    chrome-linux.
  - A tier-2 bridge on 127.0.0.1:8765: either already running (set
    OFB_EXT_TOKEN to its token) or let this script start one from
    source with a generated token (default when 8765 is free).

Usage:
  uv run --with playwright python tests/extension_e2e.py [phase]   # a|c|d|e|all
  python tests/extension_e2e.py --build-only                       # generate
                                                                    # artifacts, no browser

Gotchas baked in from the spike (see the project skill's extension-spike
reference): fresh profile dir per run (Chromium caches MV3 service
workers in the persistent profile — a stale SW runs old code silently);
harness pages served over http (content scripts skip file://); unique
filenames per run (the bridge 409 overwrite gate); Pyodide globals read
via py.globals.get("RESULT"); site-packages resolved via sysconfig, not
hardcoded.
"""
import functools
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EXT_SRC = REPO / "extension"
BRIDGE_ORIGIN = "http://127.0.0.1:8765"
OWUI = os.environ.get("OFB_EXT_OWUI", "http://127.0.0.1:8788")
SCRATCH = Path(os.environ.get("OFB_EXT_E2E_DIR") or tempfile.mkdtemp(prefix="ofb-ext-e2e-"))
PHASE = sys.argv[1] if len(sys.argv) > 1 else "all"
BUILD_ONLY = "--build-only" in sys.argv


def find_chrome():
    env = os.environ.get("OFB_EXT_CHROME")
    if env:
        return env
    hits = sorted(glob.glob(os.path.expanduser(
        "~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome")))
    if not hits:
        sys.exit("no Chromium found: run `playwright install chromium` or set OFB_EXT_CHROME")
    return hits[-1]


# ---------------------------------------------------------------- bridge

def http_json(method, path, payload=None, token=None):
    req = urllib.request.Request(BRIDGE_ORIGIN + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("X-Bridge-Token", token)
    data = json.dumps(payload).encode() if payload is not None else None
    with urllib.request.urlopen(req, data, timeout=5) as r:
        return r.status, r.read().decode()


def bridge_alive():
    try:
        with urllib.request.urlopen(BRIDGE_ORIGIN + "/health", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def start_bridge():
    """Start a tier-2 bridge from source in SCRATCH; return (proc, token)."""
    folder = SCRATCH / "folder"
    state = SCRATCH / "bridge-state"
    folder.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, FILE_BRIDGE_STATE_DIR=str(state), FILE_BRIDGE_MAX_WRITES="500")
    proc = subprocess.Popen(
        [sys.executable, "src/file_bridge.py", str(folder)],
        cwd=str(REPO), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        if bridge_alive():
            break
        time.sleep(0.5)
    else:
        proc.kill()
        sys.exit("bridge did not come up on 8765")
    # tier-2 only (no allowed_origin): token carries auth, CORS echoes for
    # the opaque-origin sandbox — the verified mode (project skill gotcha 10)
    http_json("POST", "/api/root", {"token": {"generate": True}})
    token = (state / "bridge-token").read_text().strip()
    return proc, token


# ---------------------------------------------------------------- harness
# Page/cell content below is the proven session-2 harness, embedded verbatim
# except: (1) the note file read by C2 is runner-created with a unique name
# (the bridge 409 overwrite gate), (2) site-packages resolved dynamically
# via sysconfig instead of a hardcoded /lib/python3.14 path.

PYTHON_BOOTSTRAP = '''import sys, json, base64
from js import parent
from pyodide.ffi import create_proxy, to_js

_pending = {}
_next = [100]
_installed = [False]

def _install():
    if _installed[0]:
        return
    import asyncio, js
    def on_message(ev):
        try:
            d = getattr(ev, "data", None)
            dd = d.to_py()
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
    import asyncio
    _install()
    fut = asyncio.get_event_loop().create_future()
    rid = _next[0]; _next[0] += 1
    _pending[rid] = fut
    msg = {"ofb": True, "id": rid, "method": method, "path": path}
    if body is not None:
        msg["body"] = body
    parent.postMessage(to_js(msg), "*")
    return await asyncio.wait_for(fut, 30.0)

async def ofb_fetch_b64(path):
    import asyncio
    _install()
    fut = asyncio.get_event_loop().create_future()
    rid = _next[0]; _next[0] += 1
    _pending[rid] = fut
    parent.postMessage(to_js({"ofb": True, "id": rid, "method": "GET",
                              "path": path, "b64": True}), "*")
    ev = await asyncio.wait_for(fut, 60.0)
    d = ev.to_py()
    if "bodyB64" not in d:
        raise RuntimeError("no bodyB64: keys=" + str(list(d.keys())) + " ok=" + str(d.get("ok"))
                           + " status=" + str(d.get("status")) + " err=" + str(d.get("error"))
                           + " bodylen=" + str(len(d.get("body") or "")))
    if not d.get("ok"):
        raise RuntimeError("b64 fetch failed: " + str(d.get("status")) + " " + str(d.get("error")))
    return base64.b64decode(d["bodyB64"])

def send_raw(msg):
    _install()
    parent.postMessage(to_js(msg), "*")
'''

# ---- Phase A cells (NO token in chrome.storage yet) ----
PY_A1 = '''d = (await ofb_fetch("GET", "/health")).to_py()
_r = "A1 /health status=" + str(d["status"]) + " ok=" + str(d.get("ok"))
assert d["status"] == 200, _r
print(_r); RESULT = _r
'''

PY_A2 = '''d = (await ofb_fetch("GET", "/list")).to_py()
_r = "A2 /list no-token status=" + str(d["status"]) + " body=" + str(d.get("body"))[:60]
assert d["status"] == 401, _r
print(_r); RESULT = _r
'''

PY_A3 = '''import asyncio
# non-OFB shape must be ignored by the relay -> future never resolves
fut = asyncio.get_event_loop().create_future()
_pending[500] = fut
send_raw({"ofb": False, "id": 500, "method": "GET", "path": "/health"})
try:
    await asyncio.wait_for(fut, 2.0)
    _r = "A3 LEAK: got reply to non-OFB shape"
except asyncio.TimeoutError:
    _r = "A3 IGNORED-OK: non-OFB shape got no reply in 2s"
_pending.pop(500, None)
print(_r); RESULT = _r
assert "IGNORED-OK" in _r, _r
'''

# ---- Phase C cells (token set via options page) ----
PY_C1 = '''data = json.loads((await ofb_fetch("GET", "/list")).to_py()["body"])
entries = data.get("entries") if isinstance(data, dict) else data
files = [e["path"] for e in (entries or [])]
_r = "C1 /list 200 files=" + str(files)
print(_r); RESULT = _r
'''

PY_C2 = '''import js as _js
TFN = str(_js.TFN)
NF = str(_js.NF)
rd = (await ofb_fetch("GET", "/read?path=" + NF)).to_py()
wr = (await ofb_fetch("POST", "/write", json.dumps({"path": TFN, "content": "written via real extension relay+sw"}))).to_py()
back = (await ofb_fetch("GET", "/read?path=" + TFN)).to_py()
_r = ("C2 READ=" + str(rd["status"]) + " " + str(rd["body"])[:30] +
      " | WRITE=" + str(wr["status"]) + " " + str(wr["body"])[:50] +
      " | READBACK=" + str(back["status"]) + " " + str(back["body"])[:60])
print(_r); RESULT = _r
assert rd["status"] == 200 and wr["status"] == 200 and "extension relay" in str(back["body"]), _r
'''

PY_C3 = '''d = (await ofb_fetch("GET", "/state")).to_py()
_r = "C3 /state status=" + str(d["status"])
print(_r); RESULT = _r
assert d["status"] == 200, _r
'''

PY_C4 = '''d = (await ofb_fetch("GET", "/__nosucheofbendpoint")).to_py()
_r = "C4 unknown-endpoint status=" + str(d["status"]) + " body=" + str(d.get("body"))[:50]
print(_r); RESULT = _r
assert d["status"] == 404, _r
'''

PY_C5 = '''# scheme-relative host override WITHOUT port: passes SW path regex, but the
# destination must stay the hardcoded bridge -> bridge 404, not evil.com
d = (await ofb_fetch("GET", "//evil.com/x")).to_py()
_r = "C5 evil-nopath status=" + str(d["status"]) + " body=" + str(d.get("body"))[:60]
print(_r); RESULT = _r
assert d["status"] == 404, _r
'''

PY_C6 = '''# host override WITH port: ':' fails the SW path gate -> refused pre-fetch
d = (await ofb_fetch("GET", "//evil.com:9/x")).to_py()
_r = "C6 evil-port ok=" + str(d.get("ok")) + " status=" + str(d.get("status")) + " error=" + str(d.get("error"))
print(_r); RESULT = _r
assert d.get("ok") is False and d.get("status") == 0, _r
'''

PY_C7 = '''# foreign url/port fields must be DROPPED by the relay; request still hits /health on 8765
import asyncio
fut = asyncio.get_event_loop().create_future()
_pending[501] = fut
send_raw({"ofb": True, "id": 501, "method": "GET", "path": "/health",
          "url": "http://127.0.0.1:9999/health", "port": 9999, "host": "evil.com"})
d = (await asyncio.wait_for(fut, 10.0)).to_py()
_r = "C7 url-drop status=" + str(d["status"])
print(_r); RESULT = _r
assert d["status"] == 200, _r
'''

PY_C8 = '''# method outside GET/POST/DELETE -> SW refuses
d = (await ofb_fetch("PUT", "/health")).to_py()
_r = "C8 PUT ok=" + str(d.get("ok")) + " error=" + str(d.get("error"))
print(_r); RESULT = _r
assert d.get("ok") is False and d.get("status") == 0, _r
'''

# ---- Phase E cells (binary b64 pipe) ----
PY_E1 = '''import base64 as _b64, io, json as _json
d = _json.loads((await ofb_fetch("GET", "/wheels")).to_py()["body"])
names = [n for n in d["wheels"] if n.startswith("openpyxl")]
_r = "E1 /wheels openpyxl wheel: " + str(names)
print(_r); RESULT = _r
assert names, _r
'''

PY_E2 = '''import base64 as _b64, io, sysconfig
# fetch the wheel binary through the extension b64 pipe and install it
whl = await ofb_fetch_b64("/wheels/" + [n for n in json.loads((await ofb_fetch("GET", "/wheels")).to_py()["body"])["wheels"] if n.startswith("openpyxl")][0])
_r = "E2 wheel bytes: " + str(len(whl))
print(_r); RESULT = _r
assert len(whl) > 100000, _r
import zipfile
# pure-Python wheels (py3-none-any): unzip straight into site-packages —
# no micropip network fetch needed in extension mode. Resolve the path
# dynamically: the Pyodide Python version moves across OWUI upgrades.
_wl = json.loads((await ofb_fetch("GET", "/wheels")).to_py()["body"])["wheels"]
_et = [n for n in _wl if n.startswith("et_xmlfile")][0]
etb = await ofb_fetch_b64("/wheels/" + _et)
_sp = sysconfig.get_paths()["purelib"]
zipfile.ZipFile(io.BytesIO(etb)).extractall(_sp)
zipfile.ZipFile(io.BytesIO(whl)).extractall(_sp)
import openpyxl
_r += " | openpyxl " + openpyxl.__version__
print(_r); RESULT = _r
'''

PY_E3 = '''import base64 as _b64, io, json as _json
# write a REAL xlsx via openpyxl + bridge /write_b64, read it back
wb = openpyxl.Workbook(); ws = wb.active; ws["A1"] = "OFB extension e2e"
buf = io.BytesIO(); wb.save(buf)
import js as _js2
_XF = "ext-e2e-report-%d.xlsx" % int(float(str(_js2.TFN).split("-")[-1].split(".")[0]))
wr = (await ofb_fetch("POST", "/write_b64", _json.dumps({"path": _XF,
      "b64": _b64.b64encode(buf.getvalue()).decode()}))).to_py()
info = (await ofb_fetch("GET", "/stat?path=" + _XF)).to_py()
_r = "E3 " + _XF + " write_b64=" + str(wr["status"]) + " stat=" + str(info.get("status")) + " " + str(info.get("body"))[:80]
print(_r); RESULT = _r
assert wr["status"] == 200 and info["status"] == 200, _r
'''

# ---- Phase D cell (rate limit) ----
PY_D1 = '''import asyncio
counts = {}
async def one(i):
    try:
        d = (await ofb_fetch("GET", "/health")).to_py()
        key = "ok" if d.get("ok") else ("rate-limit" if "rate limit" in str(d.get("error"))
               else ("inflight" if "in-flight" in str(d.get("error")) else "err:" + str(d.get("error"))[:40]))
    except asyncio.TimeoutError:
        key = "timeout"
    counts[key] = counts.get(key, 0) + 1
async def batch(start, n):
    await asyncio.gather(*[one(start + i) for i in range(n)])
for b in range(8):
    await batch(b * 25, 25)
_r = "D1 rate-test " + json.dumps(counts)
print(_r); RESULT = _r
assert counts.get("ok", 0) > 50, _r
assert (counts.get("rate-limit", 0) + counts.get("inflight", 0)) > 0, _r
'''


def js_str(s):
    return json.dumps(s)


def build_page(name, cells, stamp):
    srcdoc_body = (
        '<script>\n'
        'const _boot = async () => {\n'
        '  await import("' + OWUI + '/pyodide/pyodide.js");\n'
        '  const loadPyodide = globalThis.loadPyodide;\n'
        'const log = (...a) => parent.postMessage({harnessLog: a.map(String).join(" ")}, "*");\n'
        'globalThis.TFN = ' + js_str("ext-e2e-%f.txt" % stamp) + ';\n'
        'globalThis.NF = ' + js_str("note-%f.txt" % stamp) + ';\n'
        'const PYTHON = ' + js_str(PYTHON_BOOTSTRAP) + ';\n'
        + ''.join('const CELL%d = %s;\n' % (i, js_str(c)) for i, c in enumerate(cells))
        + '(async () => {\n'
        '  try {\n'
        '    log("loading pyodide…");\n'
        '    const py = await loadPyodide({ indexURL: "' + OWUI + '/pyodide/" });\n'
        '    log("pyodide loaded v" + py.version);\n'
        '    await py.runPythonAsync(PYTHON);\n'
        '    log("bootstrap done");\n'
        '    try { await py.loadPackage("micropip"); log("micropip ok"); } catch (e) { log("micropip skip: " + String(e)); }\n'
        + ''.join('    await py.runPythonAsync(CELL%d); log("CELL%d: " + py.globals.get("RESULT"));\n' % (i, i)
                  for i in range(len(cells)))
        + '    log("ALL-SANDBOX-TESTS-DONE");\n'
        '  } catch (e) {\n'
        '    log("HARNESS-ERROR: " + String(e && e.message || e));\n'
        '  }\n'
        '})();\n'
        '};\n'
        '_boot();\n'
    )

    page_js = (
        'window.__ofbSniffed = [];\n'
        'window.addEventListener("message", (ev) => {\n'
        '  const m = ev.data;\n'
        '  if (m && m.harnessLog) { document.getElementById("log").textContent += m.harnessLog + "\\n"; return; }\n'
        '  try { window.__ofbSniffed.push(JSON.stringify(m)); } catch (e) { window.__ofbSniffed.push(String(m)); }\n'
        '}, false);\n'
    )

    page = (
        '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>OFB ext e2e ' + name + '</title></head>\n<body>\n'
        '<h3>extension e2e ' + name + ' — relay-less page, extension does the work</h3>\n'
        '<pre id="log"></pre>\n'
        '<script>\n' + page_js + '</' + 'script>\n'
        '<script>\n'
        'const SRCDOC = ' + js_str(srcdoc_body) + ' + "</" + "script>";\n'
        'const iframe = document.createElement("iframe");\n'
        'iframe.srcdoc = SRCDOC;\n'
        'iframe.setAttribute("sandbox", "allow-scripts");\n'
        'iframe.style.width = "1px"; iframe.style.height = "1px"; iframe.style.border = "0";\n'
        'document.body.appendChild(iframe);\n'
        'window.__harnessReady = true;\n'
        '</' + 'script>\n'
        '</body>\n</html>\n'
    )
    path = SCRATCH / ("harness-ext-%s.html" % name)
    path.write_text(page)
    return path


def build_test_extension():
    """Copy extension/ and widen content_scripts.matches for the local
    harness server (http://127.0.0.1:PORT) — the shipped https-only match
    would never inject into the local test page. file:// gets no injection
    at all, hence the http server."""
    dest = SCRATCH / "ext-test"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(EXT_SRC, dest)
    mf = json.loads((dest / "manifest.json").read_text())
    matches = mf["content_scripts"][0]["matches"]
    if "http://127.0.0.1/*" not in matches:
        matches.append("http://127.0.0.1/*")
    (dest / "manifest.json").write_text(json.dumps(mf, indent=2) + "\n")
    return dest


# ---------------------------------------------------------------- runner

def wait_done(pg, timeout=240):
    deadline = time.time() + timeout
    text = ""
    while time.time() < deadline:
        text = pg.evaluate("document.getElementById('log').textContent")
        if "ALL-SANDBOX-TESTS-DONE" in text or "HARNESS-ERROR" in text:
            break
        time.sleep(1)
    return text


def run_harness(ctx, url, phase):
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(f"[console.{m.type}] {m.text}"))
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    pg.goto(url)
    text = wait_done(pg)
    ok = "ALL-SANDBOX-TESTS-DONE" in text and "HARNESS-ERROR" not in text
    print(f"===== PHASE {phase} =====")
    print(text.strip())
    sniffed = []
    try:
        sniffed = pg.evaluate("window.__ofbSniffed || []")
    except Exception:
        pass
    pg.close()
    return ok, logs, sniffed


def main():
    stamp = time.time()
    pages = {
        "a": build_page("a", [PY_A1, PY_A2, PY_A3], stamp),
        "c": build_page("c", [PY_C1, PY_C2, PY_C3, PY_C4, PY_C5, PY_C6, PY_C7, PY_C8], stamp),
        "d": build_page("d", [PY_D1], stamp),
        "e": build_page("e", [PY_E1, PY_E2, PY_E3], stamp),
    }
    ext = build_test_extension()
    print("scratch:", SCRATCH)
    print("harness pages + test extension built:", ext)
    if BUILD_ONLY:
        for k, p in pages.items():
            print(" ", k, "->", p)
        return 0

    from playwright.sync_api import sync_playwright

    chrome = find_chrome()
    print("chrome:", chrome)

    # bridge: external (token from env) or self-started (generated token)
    bridge_proc = None
    token = os.environ.get("OFB_EXT_TOKEN")
    if bridge_alive():
        if not token:
            sys.exit("a bridge is already serving 8765 — set OFB_EXT_TOKEN to its token")
        print("using external bridge on 8765")
    else:
        bridge_proc, token = start_bridge()
        print("self-started bridge (pid %d), generated token" % bridge_proc.pid)

    # unique note file for cell C2 (fresh name every run: the bridge's 409
    # overwrite-confirmation gate must never fire in this suite)
    note_name = "note-%f.txt" % stamp
    http_json("POST", "/write", {"path": note_name,
                                 "content": "note from the OFB extension e2e runner"}, token=token)

    # serve harness pages over http so the content script injects
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(SCRATCH))
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    print("harness server on", base)

    results = {}
    try:
        with sync_playwright() as p:
            # FRESH profile every run: Chromium caches the MV3 service worker
            # in the persistent profile — an edited sw.js + reused profile
            # silently runs the OLD code (spike gotcha #1).
            profile = SCRATCH / "profile"
            if profile.exists():
                shutil.rmtree(profile)
            ctx = p.chromium.launch_persistent_context(
                str(profile),
                executable_path=chrome,
                headless=True,
                args=[
                    f"--disable-extensions-except={ext}",
                    f"--load-extension={ext}",
                    "--no-first-run", "--no-default-browser-check",
                ],
                ignore_default_args=["--enable-automation"],
            )
            print("extension context up; pages:", [pp.url for pp in ctx.pages])

            sw = None
            for _ in range(30):
                for worker in ctx.service_workers:
                    if worker.url.startswith("chrome-extension://"):
                        sw = worker
                        break
                if sw:
                    break
                time.sleep(0.5)
            if not sw:
                print("VERDICT: FAIL — no extension service worker found")
                ctx.close()
                return 1
            print("SW up:", sw.url)
            ext_origin = "chrome-extension://" + sw.url.split("//")[1].split("/")[0]

            def set_token():
                opt = ctx.new_page()
                opt.goto(ext_origin + "/options.html")
                opt.fill("#token", token)
                opt.click("#save")
                time.sleep(0.5)
                opt.close()
                print("token set via options page")

            if PHASE in ("all", "a"):
                ok, logs, _ = run_harness(ctx, base + "/harness-ext-a.html", "A (no token)")
                results["A"] = ok

            if PHASE in ("all", "c"):
                set_token()
                ok, logs, sniffed = run_harness(ctx, base + "/harness-ext-c.html", "C (token)")
                leak = [s for s in sniffed if token in s]
                print(f"token-leak sniff: {len(sniffed)} msgs sniffed, {len(leak)} contain the token")
                if leak:
                    print("LEAKED:", leak[:3])
                results["C"] = ok and not leak
                if not ok:
                    for l in logs[-20:]:
                        print(l)

            if PHASE in ("all", "e", "ce"):
                if "C" not in results:
                    set_token()
                ok, logs, _ = run_harness(ctx, base + "/harness-ext-e.html", "E (wheels b64)")
                results["E"] = ok
                if not ok:
                    for l in logs[-20:]:
                        print(l)

            if PHASE in ("all", "d"):
                ok, logs, _ = run_harness(ctx, base + "/harness-ext-d.html", "D (rate limit)")
                results["D"] = ok
                if not ok:
                    for l in logs[-20:]:
                        print(l)

            ctx.close()
    finally:
        httpd.shutdown()
        if bridge_proc:
            bridge_proc.terminate()
            print("self-started bridge terminated")

    print("results:", json.dumps(results))
    want = [k for k in "ACDE" if (PHASE == "all" or k.lower() == PHASE or
                                  (PHASE == "ce" and k in "CE"))]
    ok = all(results.get(k, True) for k in want) and results
    print("VERDICT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
