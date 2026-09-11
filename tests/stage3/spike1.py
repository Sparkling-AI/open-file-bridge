#!/usr/bin/env python3
"""Spike 1: FS-handle backend through the real extension pipe.

Proves (or kills) the Stage-3 foundation (STAGE3-PLAN §7.1):
  1. showDirectoryPicker from a VISIBLE extension page (options.html),
     driven OS-level (Xvfb + XTEST — Playwright cannot drive the native
     picker).
  2. Handle persisted in IndexedDB, survives SW restart.
  3. /health /list /read /write round-trip through the REAL relay.js +
     sw.js pipe (transport core swapped to the fs-adapter).
  4. Permission re-check per op (queryPermission) → structured
     permission-needed error shape.
  5. SW-death-mid-chunk resume via the IndexedDB transfer record.

Usage: uv run --with playwright --with python-xlib --with pillow python3 stage3_spike1.py
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import functools
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
EXT = REPO / "extension"
SCRATCH = Path(os.environ.get("OFB_S3_DIR") or "/tmp/ofb-s3")
# Chromium REFUSES grants under /tmp ("contains system files") — the
# granted fixture dir must live under $HOME without dotfiles.
GRANT_DIR = Path(os.environ.get("OFB_S3_GRANT") or str(Path.home() / "ofb-stage3"))
CHROME = os.environ.get(
    "OFB_EXT_CHROME") or sorted(glob.glob(
    "~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome".replace("~", os.path.expanduser("~"))))[-1]
OWUI = os.environ.get("OFB_EXT_OWUI", "http://127.0.0.1:8788")
XDISPLAY = os.environ.get("OFB_S3_XDISPLAY", ":99")

# ---------------------------------------------------------------- fixtures
GRANT_DIR.mkdir(parents=True, exist_ok=True)
(GRANT_DIR / "notes").mkdir(exist_ok=True)
NOTE = GRANT_DIR / "notes" / "readme.txt"
if not NOTE.exists():
    NOTE.write_text("spike1 fixture line1: åäö ÅÄÖ 123 456\nline2: plain text\n")

# ---------------------------------------------------------------- X driver
class XDriver:
    """XTEST fake-input driver for the native directory picker.

    PROVEN session #2 (2026-09-06): XTEST ButtonPress/Release IGNORE the
    x/y arguments — the pointer must be WARPED to the target first with a
    MotionNotify event (which does carry root coords), then press/release
    without coordinates. Without this, every "click" lands wherever the
    pointer happened to be (session #1's dead-button mystery).
    """

    def __init__(self, display=XDISPLAY):
        from Xlib import X, XK
        from Xlib import display as xdisplay
        from Xlib.ext import xtest
        self.X = X
        self.XK = XK
        self.dpy = xdisplay.Display(display)
        self.root = self.dpy.screen().root
        self.xtest = xtest

    def screenshot(self, name):
        out = SCRATCH / f"x-{name}.xwd"
        subprocess.run(["xwd", "-root", "-display", XDISPLAY, "-out", str(out)],
                       check=True, capture_output=True)
        return out

    def find_windows(self):
        wins = []
        def rec(w, depth):
            try:
                attrs = w.get_attributes()
                if attrs.map_state == 2 and attrs.override_redirect:
                    wins.append(w)
                for i in range(100):
                    try: rec(w.children[i], depth + 1)
                    except Exception: break
            except Exception:
                pass
        rec(self.root, 0)
        return wins

    def mapped_toplevels(self):
        """All MAPPED toplevel windows (live QueryTree — python-xlib CACHES
        the .children attribute from first access, so a stale empty tree
        would hide every window created later)."""
        out = []
        try:
            tree = self.root.query_tree()
            kids = tree.children
        except Exception:
            return out
        for w in kids:
            try:
                attrs = w.get_attributes()
                ge = w.get_geometry()
                if attrs.map_state == 2 and ge.width > 50 and ge.height > 50:
                    out.append(w)
            except Exception:
                pass
        return out

    def focus(self, win):
        self.dpy.set_input_focus(win, self.X.RevertToParent, self.X.CurrentTime)

    def click(self, x, y):
        # XTEST: warp pointer via MotionNotify FIRST (button events carry
        # no coordinates) — see class docstring.
        X = self.X
        self.xtest.fake_input(self.dpy, X.MotionNotify, 0, 0, X.NONE, x, y)
        self.dpy.sync()
        time.sleep(0.05)
        self.xtest.fake_input(self.dpy, X.ButtonPress, 1)
        self.dpy.sync()
        time.sleep(0.05)
        self.xtest.fake_input(self.dpy, X.ButtonRelease, 1)
        self.dpy.sync()

    def type(self, s):
        X = self.X
        for ch in s:
            keysym = ord(ch)
            code = self.dpy.keysym_to_keycode(keysym)
            if code == 0:
                continue
            self.xtest.fake_input(self.dpy, X.KeyPress, code)
            self.dpy.sync()
            self.xtest.fake_input(self.dpy, X.KeyRelease, code)
            self.dpy.sync()
            time.sleep(0.01)

    def key(self, keysym):
        X = self.X
        code = self.dpy.keysym_to_keycode(keysym)
        self.xtest.fake_input(self.dpy, X.KeyPress, code)
        self.dpy.sync()
        self.xtest.fake_input(self.dpy, X.KeyRelease, code)
        self.dpy.sync()

    def enter(self):
        self.key(self.XK.XK_Return)


def picker_flow(driver, page, pick_win_id):
    """Confirm the Chromium directory picker — PROVEN session #2 (2026-09-06).

    Sequence (all warp-then-press XTEST clicks on :99):
      1. GTK bookmark row 'Granted' → GRANT_DIR  at screen (85, 373)
         (bookmark installed by ensure_bookmark(); the dialog paints at
         (0,0) because Xvfb :99 has no window manager, so screen coords
         == dialog coords)
      2. 'Open' button at (1077, 798)
      3. Chrome's native "Allow this site to edit files?" bubble →
         'Allow' — bubble anchors to the browser window spawned at
         (140,60); probe a fan of points until roots appear in IDB.

    Why not type the path: GTK's location entry re-completes on every
    Enter (session #1 blocker; space+backspace clears the completion but
    Enter still fails to navigate Chromium's chooser). Bookmarks
    navigate on a single click — no completion involved.

    Returns the number of roots in IndexedDB after the flow (0 = fail).
    """
    driver.screenshot("spike-b0-open")
    driver.click(85, 373)        # bookmark 'Granted' → GRANT_DIR
    time.sleep(1.2)
    driver.screenshot("spike-b1-bookmark")
    driver.click(1077, 798)      # Open
    time.sleep(1.6)
    driver.screenshot("spike-b2-after-open")
    # Allow-bubble probe fan: (790,254) is the PROVEN hit (session #2,
    # pick_drive.py); browser window spawns at (140,60). Order matters —
    # a missed click can DISMISS the bubble (click-outside), so start
    # at the proven coordinate.
    for attempt, (ax, ay) in enumerate(
            [(790, 254), (740, 254), (700, 254)]):
        driver.click(ax, ay)
        time.sleep(1.0)
        driver.screenshot(f"spike-b3-allow-{attempt}")
        try:
            n = page.evaluate(
                "new Promise((res) => {"
                "  const rq = indexedDB.open('ofb-ext', 1);"
                "  rq.onsuccess = () => {"
                "    try {"
                "      const tx = rq.result.transaction('roots', 'readonly');"
                "      const rq2 = tx.objectStore('roots').getAll();"
                "      rq2.onsuccess = () => res(rq2.result.length);"
                "      rq2.onerror = () => res(-1);"
                "    } catch (e) { res(-2); }"
                "  };"
                "  rq.onerror = () => res(-3);"
                "})")
            if isinstance(n, int) and n >= 1:
                return n
        except Exception:
            pass
    return 0


def ensure_bookmark():
    """Install the GTK bookmark the picker flow clicks (idempotent)."""
    bm = Path.home() / ".config/gtk-3.0/bookmarks"
    line = f"file://{GRANT_DIR} Granted"
    if bm.exists():
        if line in bm.read_text().splitlines():
            return
        txt = bm.read_text()
        txt = "\n".join(l for l in txt.splitlines() if l != line) + "\n" + line + "\n"
        bm.write_text(txt)
    else:
        bm.parent.mkdir(parents=True, exist_ok=True)
        bm.write_text(line + "\n")


# ---------------------------------------------------------------- harness
PYTHON_BOOTSTRAP = open(Path(__file__).parent / "assets_stage3_py.py").read() \
    if (Path(__file__).parent / "assets_stage3_py.py").exists() else None

def build_harness(scratch, cells_sel=None):
    """The sandboxed-Pyodide harness page (Stage-1 pattern, adapted).
    cells_sel: optional iterable of cell names to include (pass B/C run
    subsets; pass A runs everything)."""
    owui = OWUI
    py = '''import sys, json, base64, asyncio, random
from js import parent
from pyodide.ffi import create_proxy, to_js

_pending = {}
_next = [100]
_hwid = "h%08x" % random.getrandbits(32)  # session-unique ids (see skill 3.0.28-EXT)
_installed = [False]
_TOKEN = ["__OFB_TEST_TOKEN__"]  # sec tier-2: tests inject; skill sets from user paste

def ofb_set_token(t):
    _TOKEN[0] = str(t or "")

def _install():
    if _installed[0]:
        return
    import js
    def on_message(ev):
        try:
            d = getattr(ev, "data", None)
            dd = d.to_py()
            # only RESPONSES resolve futures (requests carry method) —
            # mirrors the skill's cross-worker collision guard
            if dd.get("ofb") is not True or dd.get("method") is not None or "ok" not in dd:
                return
            fut = _pending.pop(dd.get("id"), None)
            if fut is not None and not fut.done():
                fut.set_result(d)
        except Exception:
            pass
    js.addEventListener("message", create_proxy(on_message))
    _installed[0] = True

async def ofb_fetch(method, path, body=None, timeout=60.0):
    _install()
    fut = asyncio.get_event_loop().create_future()
    rid = _hwid + "-" + str(_next[0]); _next[0] += 1
    _pending[rid] = fut
    msg = {"ofb": True, "id": rid, "method": method, "path": path}
    if body is not None:
        msg["body"] = body
    if _TOKEN[0]:
        msg["token"] = _TOKEN[0]
    parent.postMessage(to_js(msg), "*")
    return await asyncio.wait_for(fut, timeout)

async def ofb_fetch_b64(path, timeout=120.0):
    _install()
    fut = asyncio.get_event_loop().create_future()
    rid = _hwid + "-" + str(_next[0]); _next[0] += 1
    _pending[rid] = fut
    parent.postMessage(to_js({"ofb": True, "id": rid, "method": "GET",
                              "path": path, "b64": True}), "*")
    ev = await asyncio.wait_for(fut, timeout)
    d = ev.to_py()
    if "bodyB64" not in d:
        raise RuntimeError("no bodyB64: " + str(d.get("error")) + " status=" + str(d.get("status")))
    if not d.get("ok"):
        raise RuntimeError("b64 failed: " + str(d.get("status")))
    return base64.b64decode(d["bodyB64"])

def notify_kill():
    # to_js REQUIRED: a raw Python dict reaches JS as a JsProxy, which
    # postMessage cannot structured-clone (DataCloneError — found in
    # session #4; ofb_fetch's to_js(msg) was already correct).
    parent.postMessage(to_js({"ofbHostKill": True}), "*")
'''
    py = py.replace("__OFB_TEST_TOKEN__", TEST_TOKEN)
    cells = {
        "s1_health": '''d = (await ofb_fetch("GET", "/health")).to_py()
h = json.loads(d["body"])
_r = "S1 /health ok=" + str(h.get("ok")) + " roots=" + str(h.get("roots"))
assert d.get("status") == 200 and h.get("ok") is True, "S1 raw: " + str(d)
print(_r); RESULT = _r
''',
        "s2_list": '''d = (await ofb_fetch("GET", "/list")).to_py()
try:
    data = json.loads(d["body"])
except Exception:
    raise AssertionError("S2 raw envelope: " + str(d))
if "entries" not in data:
    raise AssertionError("S2 no entries, status=" + str(d["status"]) + " body=" + str(d["body"])[:400])
files = sorted(e["path"] for e in data["entries"] if e["type"] == "file")
_r = "S2 /list files=" + str(files)
assert "notes/readme.txt" in files, _r
print(_r); RESULT = _r
''',
        "s3_read": '''d = (await ofb_fetch("GET", "/read?path=notes/readme.txt")).to_py()
if "body" not in d or not d["body"]:
    raise AssertionError("S3 no body: " + str(d)[:400])
body = json.loads(d["body"])
_r = "S3 /read status=" + str(d["status"]) + " total_lines=" + str(body.get("total_lines")) + " first=" + str(body.get("content", "").split("\\n")[0])[:60]
assert d["status"] == 200 and "spike1 fixture" in body.get("content", ""), _r
print(_r); RESULT = _r
''',
        "s4_write": '''stamp = __import__("time").strftime("%H%M%S")
fn = "spike1-write-%s.txt" % stamp
wr = (await ofb_fetch("POST", "/write", json.dumps({"path": fn, "content": "written via extension fs-adapter"}))).to_py()
back = (await ofb_fetch("GET", "/read?path=" + fn)).to_py()
_r = "S4 write=" + str(wr["status"]) + " readback=" + str(back["status"]) + " ok=" + str(json.loads(back["body"])["content"][:20])
assert wr["status"] == 200 and back["status"] == 200, _r
print(_r); RESULT = _r
''',
        "s5_perm_needed": '''d = (await ofb_fetch("GET", "/list")).to_py()
body5 = json.loads(d["body"]) if d.get("body") else {}
_r = "S5 /list status=" + str(d["status"]) + " perm_needed=" + str(body5.get("permission_needed"))
assert d["status"] == 403 and body5.get("permission_needed") is True, "S5 raw: " + str(d)[:400]
print(_r); RESULT = _r
''',
        "s6_chunk_resume": '''import os as _os
stamp = __import__("time").strftime("%H%M%S")
fn = "spike1-chunked-%s.bin" % stamp
CH = 1024 * 1024            # MUST match adapter CHUNK: finalize validates
                            # 1MB-aligned parts (last = remainder)
data = _os.urandom(int(3.5 * 1024 * 1024))  # 3.5 MB -> 4 parts; kill after
total = len(data)                           # seq2 lands MID-transfer — the
tid = None                                  # last part + finalize must run
sent = 0                                    # on the RELIFED SW
seq = 0
statuses = []
while sent < total:
    piece = data[sent:sent + CH]
    last = sent + len(piece) >= total
    payload = {"path": fn, "seq": seq, "total": total,
               "b64": __import__("base64").b64encode(piece).decode(), "last": last}
    if tid:
        payload["tid"] = tid
    wr = (await ofb_fetch("POST", "/write_b64_chunk", json.dumps(payload))).to_py()
    rb = json.loads(wr["body"]) if wr.get("body") else {}
    statuses.append((wr["status"], rb.get("last")))
    if wr["status"] != 200:
        raise AssertionError("S6 chunk seq=" + str(seq) + " failed: " + str(wr)[:300])
    if not tid:
        tid = rb.get("tid")
    sent += len(piece)
    seq += 1
    if seq == 2:
        notify_kill()               # host kills the SW between chunks 2 and 3
        import asyncio as _aio
        await _aio.sleep(4.0)       # SW dies + relife; chunk 3 wakes it
_r = "S6 chunks=" + str(len(statuses)) + " tid=" + str(tid) + " last=" + str(statuses[-1][1])
st = (await ofb_fetch("GET", "/stat?path=" + fn)).to_py()
stb = json.loads(st["body"]) if st.get("body") else {}
_r += " | stat=" + str(st["status"]) + " size=" + str(stb.get("size"))
assert st["status"] == 200 and stb.get("size") == total, _r + " raw: " + str(st)[:300]
rd = (await ofb_fetch("GET", "/read_b64?path=" + fn)).to_py()
rb = json.loads(rd["body"]) if rd.get("body") else {}
got = __import__("base64").b64decode(rb.get("b64", "")) if rd.get("ok") else b""
_r += " | readback_ok=" + str(len(got) == total and got == data)
assert len(got) == total and got == data, _r
print(_r); RESULT = _r
''',
    }
    srcdoc_body = (
        '<script>\n'
        'const _boot = async () => {\n'
        '  await import("' + owui + '/pyodide/pyodide.js");\n'
        '  const loadPyodide = globalThis.loadPyodide;\n'
        'const log = (...a) => parent.postMessage({harnessLog: a.map(String).join(" ")}, "*");\n'
        'const PYTHON = ' + json.dumps(py) + ';\n'
        'const CELLS = ' + json.dumps([cells[k] for k in sorted(cells)
                                       if not cells_sel or k in cells_sel]) + ';\n'
        '(async () => {\n'
        '  try {\n'
        '    log("loading pyodide…");\n'
        '    const py = await loadPyodide({ indexURL: "' + owui + '/pyodide/" });\n'
        '    log("pyodide loaded v" + py.version);\n'
        '    await py.runPythonAsync(PYTHON);\n'
        '    log("bootstrap done");\n'
        + ''.join('    await py.runPythonAsync(CELLS[%d]); log("CELL%d: " + py.globals.get("RESULT"));\n' % (i, i)
                  for i in range(len(cells if not cells_sel else
                                        [k for k in sorted(cells) if k in cells_sel])))
        + '    log("ALL-SANDBOX-TESTS-DONE");\n'
        '  } catch (e) {\n'
        '    log("HARNESS-ERROR: " + String(e && e.message || e));\n'
        '  }\n'
        '})();\n'
        '};\n'
        '_boot();\n'
    )
    page = (
        '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>stage3 spike1</title></head>\n<body>\n'
        '<pre id="log"></pre>\n'
        '<script>\n'
        'window.addEventListener("message", (ev) => {\n'
        '  const m = ev.data;\n'
        '  if (m && m.harnessLog) { document.getElementById("log").textContent += m.harnessLog + "\\n"; }\n'
        '  if (m && m.ofbHostKill) { document.title = "OFB-KILL-SW-NOW"; }\n'
        '}, false);\n'
        '</' + 'script>\n'
        '<script>\n'
        'const SRCDOC = ' + json.dumps(srcdoc_body) + ' + "</" + "script>";\n'
        'const iframe = document.createElement("iframe");\n'
        'iframe.srcdoc = SRCDOC;\n'
        'iframe.setAttribute("sandbox", "allow-scripts");\n'
        'iframe.style.width = "1px"; iframe.style.height = "1px"; iframe.style.border = "0";\n'
        'document.body.appendChild(iframe);\n'
        '</' + 'script>\n'
        '</body>\n</html>\n'
    )
    p = scratch / "harness-s1.html"
    p.write_text(page)
    return p


def build_test_extension(scratch):
    dest = scratch / "ext-test"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(EXT, dest)
    import json as _json
    mf = _json.loads((dest / "manifest.json").read_text())
    matches = mf["content_scripts"][0]["matches"]
    if "http://127.0.0.1/*" not in matches:
        matches.append("http://127.0.0.1/*")
    (dest / "manifest.json").write_text(_json.dumps(mf, indent=2) + "\n")
    return dest


# ---- security-gate plumbing (fs-sec, 2026-09-11) ----------------------------
# The sender gate denies everything until an origin is allowed; suites that
# exercise the pipe configure it through the options page's IDB (same store
# the SW reads). TEST_TOKEN rides in the harness bootstrap's _TOKEN default
# (cells can override via ofb_set_token, mirroring the skill's user paste).

TEST_TOKEN = "ofb-test-token-s3"


def find_ext(ctx):
    """(sw, ext_origin) — wait for the extension's service worker. The
    CDP fallback finds ext_origin without a worker HANDLE; after any
    extension page opens (its beat() pings wake the SW), retry briefly
    for the handle so callers can evaluate in SW context."""
    sw = None
    ext_origin = None
    deadline = time.time() + 15
    while time.time() < deadline and ext_origin is None:
        for worker in ctx.service_workers:
            if worker.url.startswith("chrome-extension://"):
                sw = worker
                ext_origin = "chrome-extension://" + sw.url.split("//")[1].split("/")[0]
                break
        if ext_origin:
            break
        try:
            pg0 = ctx.pages[0] if ctx.pages else ctx.new_page()
            cdp = ctx.new_cdp_session(pg0)
            for t in cdp.send("Target.getTargets")["targetInfos"]:
                if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://"):
                    ext_origin = "chrome-extension://" + t["url"].split("//")[1].split("/")[0]
            cdp.detach()
        except Exception:
            pass
        time.sleep(0.5)
    if ext_origin and sw is None:
        deadline = time.time() + 20
        while time.time() < deadline and sw is None:
            for worker in ctx.service_workers:
                if worker.url.startswith("chrome-extension://"):
                    sw = worker
                    break
            if sw is None:
                time.sleep(0.5)
    return sw, ext_origin


def sec_configure(opt, origin, token=TEST_TOKEN):
    """Set the ONE allowed site on the sender gate (+ bridge token when
    given). `opt` = an OPEN options.html page (any extension page context
    with OFBIDB works — the SW reads the same store per request)."""
    opt.evaluate(
        "async (a) => {"
        "  await OFBIDB.put('kv', a[0], 'allowed_site');"
        "  await OFBIDB.del('kv', 'allowed_origins');"
        "  if (a[1] !== null) await OFBIDB.put('kv', a[1], 'bridge_token');"
        "  else await OFBIDB.del('kv', 'bridge_token');"
        "}",
        [origin, token])


def run_harness_page(ctx, base, tag, cells_sel=None):
    """Open the harness page, wait for the sandbox run, handle the S6
    SW-kill request in-thread (title flip → terminate+relife the SW).
    Returns (page, ok). Caller closes the page."""
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    pg.goto(base + "/harness-s1.html")
    killed = False
    deadline = time.time() + 300
    text = ""
    while time.time() < deadline:
        try:
            text = pg.evaluate("document.getElementById('log').textContent")
        except Exception:
            text = ""
        if not killed:
            try:
                title = pg.title()
            except Exception:
                title = ""
            if title == "OFB-KILL-SW-NOW":
                # SW-death-mid-chunk: kill the service worker via CDP
                # (Playwright Worker has no terminate()); the next chunk
                # message relifes it. Handles+IDB survive (probe-proven).
                try:
                    cdp = ctx.new_cdp_session(pg)
                    infos = cdp.send("Target.getTargets")["targetInfos"]
                    n_closed = 0
                    for t in infos:
                        if (t["type"] == "service_worker" and
                                t["url"].startswith("chrome-extension://")):
                            cdp.send("Target.closeTarget",
                                     {"targetId": t["targetId"]})
                            n_closed += 1
                    cdp.detach()
                    killed = n_closed > 0
                    print(f"[{tag}] SW killed mid-chunk via CDP "
                          f"({n_closed} target(s) closed)")
                except Exception as e:
                    print(f"[{tag}] SW kill via CDP failed: {e}")
                if not killed:
                    print(f"[{tag}] WARNING: kill flag seen but SW not killed")
        if "ALL-SANDBOX-TESTS-DONE" in text or "HARNESS-ERROR" in text:
            break
        time.sleep(1)
    print(f"===== harness log (pass {tag}) =====")
    print(text.strip())
    if logs:
        keep = [l for l in logs if "favicon" not in l][-6:]
        print(f"----- console tail ({tag}) -----")
        for l in keep:
            print(" ", l)
    ok = "ALL-SANDBOX-TESTS-DONE" in text and "HARNESS-ERROR" not in text
    if tag == "A" and not killed:
        print("[A] WARNING: S6 kill flag never fired — SW-death not exercised")
    return pg, ok


# ---------------------------------------------------------------- main

def main():
    from playwright.sync_api import sync_playwright

    SCRATCH.mkdir(parents=True, exist_ok=True)
    harness = build_harness(SCRATCH)
    ext = build_test_extension(SCRATCH)
    print("scratch:", SCRATCH)
    print("granted dir:", GRANT_DIR)
    del harness

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(SCRATCH))
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    print("harness server:", base)

    drv = XDriver()
    print("X driver up on", XDISPLAY)

    verdicts = {}
    with sync_playwright() as p:
        profile = SCRATCH / "profile"
        if profile.exists():
            shutil.rmtree(profile)
        ctx = p.chromium.launch_persistent_context(
            str(profile),
            executable_path=CHROME,
            headless=False,
            args=[
                f"--disable-extensions-except={ext}",
                f"--load-extension={ext}",
                "--no-first-run", "--no-default-browser-check",
                "--window-size=1000,700",
                "--window-position=140,60",
                # NOTE: no --display flag (not a valid Chromium switch — it
                # silently killed extension loading in session #2); the
                # DISPLAY env var below is the correct channel.
            ],
            env={**os.environ, "DISPLAY": XDISPLAY},
            no_viewport=True,
        )
        print("browser up; pages:", [pg.url for pg in ctx.pages])

        # wait for the SW (ctx.service_workers is event-driven and can lag
        # in the sync API — fall back to the CDP target list every round)
        sw = None
        ext_origin = None
        deadline = time.time() + 15
        while time.time() < deadline and ext_origin is None:
            for worker in ctx.service_workers:
                if worker.url.startswith("chrome-extension://"):
                    sw = worker
                    ext_origin = "chrome-extension://" + sw.url.split("//")[1].split("/")[0]
                    break
            if ext_origin:
                break
            try:
                pg0 = ctx.pages[0] if ctx.pages else ctx.new_page()
                cdp = ctx.new_cdp_session(pg0)
                for t in cdp.send("Target.getTargets")["targetInfos"]:
                    if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://"):
                        ext_origin = "chrome-extension://" + t["url"].split("//")[1].split("/")[0]
                cdp.detach()
            except Exception:
                pass
            time.sleep(0.5)
        if not ext_origin:
            print("VERDICT: FAIL — no service worker")
            ctx.close(); return 1
        print("SW up:", ext_origin)

        # --- 1. open options.html and drive the picker ---
        ensure_bookmark()
        page = ctx.new_page()
        page.goto(ext_origin + "/options.html")
        page.wait_for_selector("#pick")
        time.sleep(0.5)
        before_ids = {w.id for w in drv.mapped_toplevels()}
        # The BUTTON is a DOM element: Playwright's click produces user
        # activation (CDP input is trusted) and returns after dispatch —
        # the native picker stays open for the X driver to handle.
        page.click("#pick", timeout=5000)
        print("button clicked; driving native picker…")
        pick_win_id = None
        deadline = time.time() + 6
        while time.time() < deadline and pick_win_id is None:
            for w in drv.mapped_toplevels():
                if w.id not in before_ids:
                    pick_win_id = w.id
                    drv.focus(w)
                    break
            if pick_win_id is None:
                time.sleep(0.4)
        if pick_win_id is None:
            drv.screenshot("spike-no-picker")
            print("VERDICT: FAIL — picker did not open")
            ctx.close(); return 1
        roots_len = picker_flow(drv, page, pick_win_id)
        time.sleep(1.0)
        # options.html (unified settings page, 758a834) names the folder
        # status element #folderstatus — the old setup.html #status is gone.
        status_text = (page.locator("#folderstatus").text_content()
                       if page.locator("#folderstatus").count() else "")
        print("setup status:", status_text)
        print("roots in IDB:", roots_len)
        verdicts["picker+idb"] = roots_len == 1
        page.screenshot(path=str(SCRATCH / "after-pick.png"))
        # sender gate: allow this harness origin + set the test token
        # (the harness bootstrap sends it by default)
        sec_configure(page, base)
        # NOTE: setup tab stays OPEN — the pick grant is session-scoped and
        # dies ~2s after the last extension tab closes (probe4/8); a
        # background tab keeps it (probe8 Q1). Pass A runs with it open.

        # --- 2. PASS A: round-trip through the real pipe (S1-S4 + S6),
        # setup tab OPEN (session grant holds; probe8 Q1). S5 is EXCLUDED —
        # it expects the 403 that only exists AFTER grant decay (pass B);
        # running it here aborts the cell chain before S6 fires.
        build_harness(SCRATCH, cells_sel=["s1_health", "s2_list", "s3_read",
                                          "s4_write", "s6_chunk_resume"])
        pg, ok_a = run_harness_page(ctx, base, "A")
        verdicts["pipe round-trip"] = ok_a

        # --- 3. PASS B: S5 permission-needed after session-grant decay ---
        page.close()          # close the LAST extension tab
        time.sleep(3.5)       # grant decays within ~2s (probe4)
        build_harness(SCRATCH, cells_sel=["s5_perm_needed"])
        pg5, ok_b = run_harness_page(ctx, base, "B")
        verdicts["perm-needed shape"] = ok_b
        pg5.close()

        # --- 4. PASS C: Reconnect "Allow on every visit" → pipe restored
        # AND persistent (survives the reconnect tab closing) ---
        def read_status_js(pg):
            # #folderstatus on the unified options.html page (758a834).
            # Careful with the check: "Permission not granted" also contains
            # "granted" — test the positive phrases explicitly.
            return pg.evaluate(
                "((document.getElementById('folderstatus')||{}).textContent)||''")

        def allow_bubble(pg, name):
            """Click whichever Chrome permission bubble is up.

            Bubble taxonomy DRIFS between sessions (2026-09-07 rerun): the
            in-session post-decay reconnect can raise EITHER the simple
            bubble ("Allow this site to edit files?", Allow ≈ (790,254))
            OR the 3-option variant ("Allow this time" ≈ (421,333) /
            "Allow on every visit" ≈ (421,381)). A miss DISMISSES the
            bubble, so each candidate gets a fresh raise (re-click
            Reconnect) before its click.
            """
            st = ""
            for attempt, (ax, ay) in enumerate([
                (790, 254), (421, 381), (421, 333),
            ]):
                if attempt > 0:  # re-raise: the last click dismissed it
                    try:
                        pg.click("button:has-text('Reconnect')", timeout=3000)
                    except Exception:
                        pass
                    time.sleep(1.5)
                drv.click(ax, ay)
                time.sleep(1.2)
                st = read_status_js(pg)
                if ("permission granted" in st.lower()
                        or "folder connected" in st.lower()
                        or st.lower().startswith("permission already")):
                    return True, st
            return False, st

        rec = ctx.new_page()
        rec.goto(ext_origin + "/options.html")
        rec.wait_for_selector("#pick")
        time.sleep(0.8)
        try:
            rec.click("button:has-text('Reconnect')", timeout=4000)
        except Exception as e:
            print("Reconnect click failed:", e)
            drv.screenshot("spike-no-reconnect")
        time.sleep(1.8)
        drv.screenshot("spike-reconnect-bubble")
        persistent, st = allow_bubble(rec, "C")
        print("reconnect status:", st if persistent else "MISSED")
        rec.close()
        time.sleep(2.5)   # session grant dies with the tab — that's fine;
                          # PASS D makes it persistent properly
        build_harness(SCRATCH, cells_sel=["s1_health"])
        pg7, ok_c = run_harness_page(ctx, base, "C")
        verdicts["reconnect restores pipe"] = persistent and ok_c
        pg7.close()

        # --- 5. PASS D: browser RESTART → 3-option bubble → "Allow on
        # every visit" → pipe works with NO extension tab open (probe9's
        # product-level persistent-grant proof, now in the spike harness) ---
        ctx.close()
        time.sleep(2.0)
        ctx2 = None
        with_lifecycle = p.chromium.launch_persistent_context  # same call
        ctx = with_lifecycle(
            str(profile),
            executable_path=CHROME,
            headless=False,
            args=[
                f"--disable-extensions-except={ext}",
                f"--load-extension={ext}",
                "--no-first-run", "--no-default-browser-check",
                "--window-size=1000,700", "--window-position=140,60",
            ],
            env={**os.environ, "DISPLAY": XDISPLAY},
            no_viewport=True,
        )
        # find SW origin again (fresh contexts drop old bindings)
        ext_origin = None
        deadline = time.time() + 15
        while time.time() < deadline and ext_origin is None:
            for worker in ctx.service_workers:
                if worker.url.startswith("chrome-extension://"):
                    ext_origin = "chrome-extension://" + worker.url.split("//")[1].split("/")[0]
                    break
            if ext_origin:
                break
            try:
                pg0 = ctx.pages[0] if ctx.pages else ctx.new_page()
                cdp = ctx.new_cdp_session(pg0)
                for t in cdp.send("Target.getTargets")["targetInfos"]:
                    if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://"):
                        ext_origin = "chrome-extension://" + t["url"].split("//")[1].split("/")[0]
                cdp.detach()
            except Exception:
                pass
            time.sleep(0.5)
        assert ext_origin, "no SW after restart"
        print("PASS D ext origin:", ext_origin)

        # Reconnect on the fresh session → the RESTART bubble offers
        # "Allow on every visit"; both variants are fanned (taxonomy
        # drifted 2026-09-07 — see allow_bubble).
        rec2 = ctx.new_page()
        rec2.goto(ext_origin + "/options.html")
        rec2.wait_for_selector("#pick")
        time.sleep(0.8)
        rec2.click("button:has-text('Reconnect')", timeout=4000)
        time.sleep(1.8)
        drv.screenshot("spike-everyvisit-bubble")
        every_visit = False
        for attempt, (ax, ay) in enumerate([
            (421, 381), (421, 333), (790, 254),
        ]):
            if attempt > 0:  # re-raise: the last click dismissed the bubble
                try:
                    rec2.click("button:has-text('Reconnect')", timeout=3000)
                except Exception:
                    pass
                time.sleep(1.5)
            drv.click(ax, ay)
            time.sleep(1.2)
            st = read_status_js(rec2)
            if ("permission granted" in st.lower()
                    or "folder connected" in st.lower()
                    or st.lower().startswith("permission already")):
                every_visit = True
                break
        print("every-visit status:", st if every_visit else "MISSED")
        rec2.close()
        time.sleep(2.5)   # grant must SURVIVE the tab close now
        build_harness(SCRATCH, cells_sel=["s1_health", "s2_list"])
        pg9, ok_d = run_harness_page(ctx, base, "D")
        verdicts["every-visit persistent"] = every_visit and ok_d
        pg9.close()

        ctx.close()

    httpd.shutdown()
    print("verdicts:", json.dumps(verdicts, indent=2))
    allok = all(verdicts.values()) and verdicts
    print("SPIKE-1 VERDICT:", "PASS" if allok else "FAIL")
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())
