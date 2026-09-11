#!/usr/bin/env python3
"""Stage 3 worker-transport test (Mac-safe: no Xvfb, no folder grant).

Background (DEVNOTES stage-3 session #7, 2026-09-09): OWUI >= 0.11 can
execute python cells in a pyodide WORKER (shared-worker executor) where
no parent window exists — the skill's iframe postMessage transport is
impossible there and chats hung to OWUI's 60s "Execution Time Limit
Exceeded". Fix under test:

  1. relay.js also listens on BroadcastChannel("ofb-pipe"); each worker
     elects ONE relay (smallest tag that answers its ofbHello) so N open
     OWUI tabs never forward the same request twice.
  2. SKILL-EXT.md's bootstrap guards `from js import parent` and picks
     postMessage (iframe executor) or BroadcastChannel (worker executor).

Checks (W = worker transport, F = iframe regression):
  W1 the skill bootstrap (extracted VERBATIM from SKILL-EXT.md) runs in
     a module worker and /health returns 200 (ok:false — this scratch
     profile has no granted folder, which is exactly what we assert).
  W2 with TWO pages open (two relays on the channel) each request gets
     exactly ONE reply envelope (election; no duplicate forwards).
  W3 hello/election traffic observed; relay tags are r-prefixed hex.
  F1 the same bootstrap inside a srcdoc+allow-scripts iframe (the OWUI
     iframe-executor shape) still answers via parent.postMessage.

Usage: uv run --with playwright python3 tests/stage3/worker_transport_test.py
  (needs the local OWUI at 127.0.0.1:8788 for the pyodide dist, like spike1;
   override with OFB_EXT_OWUI)
"""
import json
import os
import re
import shutil
import sys
import threading
import functools
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
EXT = REPO / "extension"
SKILL = REPO / "skill" / "open-file-bridge" / "SKILL-EXT.md"
SCRATCH = Path(os.environ.get("OFB_WT_DIR", "/tmp/ofb-wt"))
PORT = int(os.environ.get("OFB_WT_PORT", "8898"))
OWUI = os.environ.get("OFB_EXT_OWUI", "http://127.0.0.1:8788")

PYODIDE_FILES = ["pyodide.js", "pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm",
                 "python_stdlib.zip", "pyodide-lock.json"]

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (" — " + detail if detail else ""))


def skill_bootstrap():
    """Extract the first python block after '## Bootstrap' from SKILL-EXT.md."""
    text = SKILL.read_text()
    m = re.search(r"## Bootstrap.*?```python\n(.*?)```", text, re.S)
    if not m:
        raise SystemExit("cannot extract bootstrap block from SKILL-EXT.md")
    return m.group(1)


def fetch_pyodide():
    pyd = SCRATCH / "pyodide"
    pyd.mkdir(parents=True, exist_ok=True)
    for f in PYODIDE_FILES:
        dest = pyd / f
        if dest.exists() and dest.stat().st_size > 0:
            continue
        urllib.request.urlretrieve(OWUI + "/pyodide/" + f, dest)
    return pyd


WORKER_CELL = '''
import json, time
from js import hlog
t0 = time.time()
try:
    d = await ofb_fetch("GET", "/health")
    try:
        _b = json.loads(d.get("body") or ""); _bok = _b.get("ok")
    except Exception:
        _bok = None
    hlog(json.dumps({"kind": "health", "dt": round(time.time() - t0, 2),
                     "status": d.get("status"), "ok": d.get("ok"),
                     "body_ok": _bok}))
except Exception as e:
    hlog(json.dumps({"kind": "health", "dt": round(time.time() - t0, 2),
                     "error": repr(e)[:300]}))
# a second request on the SAME elected relay (id increments; no re-election)
try:
    d2 = await ofb_fetch("GET", "/version")
    hlog(json.dumps({"kind": "version", "status": d2.get("status"),
                     "body": str(d2.get("body"))[:120]}))
except Exception as e:
    hlog(json.dumps({"kind": "version", "error": repr(e)[:300]}))
'''

IFRAME_CELL = '''
import json, time
from js import hlog
t0 = time.time()
try:
    d = await ofb_fetch("GET", "/health")
    hlog(json.dumps({"kind": "iframe_health", "dt": round(time.time() - t0, 2),
                     "status": d.get("status"), "ok": d.get("ok"),
                     "transport": "parent" if parent is not None else "bc"}))
except Exception as e:
    hlog(json.dumps({"kind": "iframe_health", "error": repr(e)[:300]}))
'''

# W5 (2026-09-11): TWO WORKERS, overlapping requests, ONE shared relay — the
# cross-worker id-collision regression. "ofb-pipe" is a broadcast channel:
# with bare integer ids (both workers count 0,1,2…) worker B's REQUEST
# lands while worker A is pending on the same id and the old _on_msg
# resolved A's future with B's REQUEST (live incident: ofb_fetch "returned"
# the request; bridge_get died with KeyError 'status'). The fixed bootstrap
# gives every worker session-unique ids (_wid prefix) and only lets
# RESPONSES (messages with ok, never method) resolve futures.
TWO_WORKER_CELL = '''
import json
from js import hlog
d = await ofb_fetch("GET", "/version")
hlog(json.dumps({"kind": "ver2w", "wid": _wid, "id": d.get("id"),
                 "ok": d.get("ok"), "status": d.get("status"),
                 "method": d.get("method")}))
'''


def sandbox_srcdoc(cell):
    return """<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script>
window.hlog = (s) => window.top.postMessage({harnessLog: String(s)}, "*");
(async () => {
  try {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = PYODIDE_INDEX_URL + "pyodide.js";
      s.onload = res; s.onerror = () => rej(new Error("pyodide.js failed"));
      document.head.appendChild(s);
    });
    const py = await loadPyodide({ indexURL: PYODIDE_INDEX_URL,
      stdout: (t) => window.top.postMessage({harnessLog: "[py] " + t}, "*") });
    await py.runPythonAsync(BOOTSTRAP_SRC);
    await py.runPythonAsync(CELL_SRC);
  } catch (e) {
    hlog("HARNESS-ERROR: " + String(e && e.message || e));
  }
})();
</script></body></html>""".replace("BOOTSTRAP_SRC", json.dumps(skill_bootstrap())) \
        .replace("CELL_SRC", json.dumps(cell)) \
        .replace("PYODIDE_INDEX_URL", json.dumps(f"http://127.0.0.1:{PORT}/pyodide/"))


def module_worker_js():
    return """
import { loadPyodide } from "/pyodide/pyodide.mjs";
self.hlog = (s) => self.postMessage({workerLog: String(s)});
self.onmessage = async (ev) => {
  const t = ev.data;
  if (!t || t.run !== true) return;
  try {
    const py = await loadPyodide({ indexURL: "/pyodide/",
      stdout: (x) => self.postMessage({workerLog: x}) });
    await py.runPythonAsync(BOOTSTRAP_SRC);
    await py.runPythonAsync(CELL_SRC);
  } catch (e) {
    self.postMessage({workerLog: "HARNESS-ERROR: " + String(e && e.message || e)});
  }
};
""".replace("BOOTSTRAP_SRC", json.dumps(skill_bootstrap())) \
        .replace("CELL_SRC", json.dumps(WORKER_CELL))


IDLE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>OFB-WT-idle</title></head>
<body><p>idle relay host (content script only)</p></body></html>"""

PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>OFB-WT</title></head>
<body style="font-family: system-ui; margin: 18px; font-size: 14px;">
<pre id="log" style="background:#f2f2f2; padding:10px; font-size:12px;"></pre>
<script>
window.__bcSeen = [];   // page-world sniffer: sees ALL ofb-pipe traffic
const __sbc = new BroadcastChannel("ofb-pipe");
__sbc.onmessage = (ev) => {
  const m = ev.data;
  if (!m || typeof m !== "object") return;
  if (m.ofbHello === true || m.ofbRelay === true) { window.__bcSeen.push({t: m.ofbHello ? "hello" : "relay", tag: m.tag}); return; }
  if (m.ofb === true) window.__bcSeen.push({t: m.method ? "req" : "resp", id: m.id, to: m.to || null});
  document.getElementById("log").textContent += JSON.stringify(m).slice(0, 120) + "\\n";
};
</script>
<script>
const W = new Worker("/wt-worker.js", { type: "module" });
W.onmessage = (ev) => { if (ev.data && ev.data.workerLog)
  document.getElementById("log").textContent += "[worker] " + ev.data.workerLog + "\\n"; };
W.onerror = (e) => document.getElementById("log").textContent += "[worker error] " + e.message + "\\n";
setTimeout(() => W.postMessage({run: true}), 300);
</script>
</body></html>"""


def run():
    if SCRATCH.exists():
        shutil.rmtree(SCRATCH)
    SCRATCH.mkdir(parents=True)
    fetch_pyodide()
    (SCRATCH / "wt-worker.js").write_text(module_worker_js())
    (SCRATCH / "wt2-worker.js").write_text(
        module_worker_js().replace(json.dumps(WORKER_CELL), json.dumps(TWO_WORKER_CELL)))
    (SCRATCH / "wt2-page.html").write_text("""<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>OFB-WT two workers</title></head>
<body><pre id="log" style="background:#f2f2f2; padding:10px; font-size:12px;"></pre>
<script>
const mk = () => new Worker("/wt2-worker.js", { type: "module" });
const wire = (W, tag) => {
  W.onmessage = (ev) => { if (ev.data && ev.data.workerLog)
    document.getElementById("log").textContent += "[" + tag + "] " + ev.data.workerLog + "\\n"; };
  W.onerror = (e) => document.getElementById("log").textContent += "[" + tag + " error] " + e.message + "\\n";
};
const A = mk(), B = mk();
wire(A, "A"); wire(B, "B");
setTimeout(() => A.postMessage({run: true}), 300);   // A fires first…
setTimeout(() => B.postMessage({run: true}), 450);   // …B's request lands inside A's pending window
</script></body></html>""")
    (SCRATCH / "wt-page.html").write_text(PAGE)
    (SCRATCH / "wt-idle.html").write_text(IDLE)
    (SCRATCH / "wt-iframe.html").write_text("""<!DOCTYPE html><html><head>
<meta charset="utf-8"></head><body style="font-family: system-ui; margin: 18px;">
<pre id="log" style="background:#f2f2f2; padding:10px; font-size:12px;"></pre>
<script>
window.addEventListener("message", (ev) => {
  if (ev.data && ev.data.harnessLog)
    document.getElementById("log").textContent += ev.data.harnessLog + "\\n";
}, false);
const SB = SB_SRC;
const f = document.createElement("iframe");
f.srcdoc = SB; f.setAttribute("sandbox", "allow-scripts");
f.style.width = "1px"; f.style.height = "1px";
document.body.appendChild(f);
</script></body></html>""".replace("SB_SRC", json.dumps(sandbox_srcdoc(IFRAME_CELL)).replace("</", "<\\/")))

    class CorsHandler(SimpleHTTPRequestHandler):
        # OWUI serves /pyodide with access-control-allow-origin: null so its
        # opaque-origin sandbox iframe can load it — mirror that here
        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            super().end_headers()

    handler = functools.partial(CorsHandler, directory=str(SCRATCH))
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(SCRATCH / "profile"), headless=False,
            args=["--disable-extensions-except=" + str(EXT),
                  "--load-extension=" + str(EXT)])
        base = f"http://127.0.0.1:{PORT}"
        # sender gate: allow the harness origin, NO token tier — the skill
        # bootstrap runs verbatim here (it sends a token only when the user
        # pasted one, which this suite never simulates)
        sys.path.insert(0, str(Path(__file__).parent))
        import spike1  # noqa: E402
        _sw, ext_origin = spike1.find_ext(ctx)
        assert ext_origin, "no service worker"
        opt = ctx.new_page()
        opt.goto(ext_origin + "/options.html")
        opt.wait_for_selector("#pick", timeout=10000)
        spike1.sec_configure(opt, base, token=None)
        page = ctx.new_page()          # relay #1
        page.goto(base + "/wt-page.html")
        page2 = ctx.new_page()         # relay #2 (election must pick ONE);
        page2.goto(base + "/wt-idle.html")  # idle host — no second worker
        page.wait_for_timeout(30000)   # pyodide load + election (250ms) + calls
        log = page.eval_on_selector("#log", "el => el.textContent")
        seen = page.evaluate("window.__bcSeen")

        # iframe regression (same page world as relay #1)
        page3 = ctx.new_page()
        page3.goto(base + "/wt-iframe.html")
        page3.wait_for_timeout(25000)
        ilog = page3.eval_on_selector("#log", "el => el.textContent")

        # two-worker collision regression (same relay, overlapping requests)
        page4 = ctx.new_page()
        page4.goto(base + "/wt2-page.html")
        page4.wait_for_timeout(30000)
        w2log = page4.eval_on_selector("#log", "el => el.textContent")
        ctx.close()
    httpd.shutdown()

    print("---- worker page log ----")
    print(log)
    print("---- bc traffic (page 1) ----")
    print(json.dumps(seen[:20], indent=None))

    def find_obj(text, marker):
        for l in text.splitlines():
            i = l.find("{")
            if i < 0 or marker not in l:
                continue
            try:
                return json.loads(l[i:])
            except Exception:
                continue
        return None
    health = find_obj(log, '"health"')
    version = find_obj(log, '"version"')

    check("W1 worker /health 200 (skill bootstrap verbatim)",
          bool(health and health.get("status") == 200),
          json.dumps(health)[:220] if health else "no health line")
    check("W1b no-folder honesty (body ok:false)",
          health is not None and health.get("body_ok") is False,
          str(health and health.get("body_ok")))
    check("W1c fast (< 3s incl. election)",
          bool(health and isinstance(health.get("dt"), (int, float)) and health["dt"] < 3.0),
          str(health and health.get("dt")))
    check("W2 second request on elected relay",
          bool(version and version.get("status") == 200), "")
    resps = [s for s in seen if s.get("t") == "resp"]
    reqs = [s for s in seen if s.get("t") == "req"]
    dup = [r for r in reqs if sum(1 for x in resps if x.get("id") == r.get("id")) > 1]
    check("W3 election: no duplicate replies (2 relays open)",
          len(resps) >= 2 and not dup, f"reqs={len(reqs)} resps={len(resps)} dup={len(dup)}")
    check("W4 hello/relay handshake observed",
          any(s.get("t") == "hello" for s in seen) and any(s.get("t") == "relay" for s in seen), "")

    print("---- iframe page log ----")
    print(ilog)
    ih = find_obj(ilog, '"iframe_health"')
    check("F1 iframe transport still works (parent.postMessage)",
          bool(ih and ih.get("status") == 200 and ih.get("transport") == "parent"),
          json.dumps(ih)[:220] if ih else "no iframe health line")

    print("---- two-worker page log ----")
    print(w2log)
    vers = []
    for l in w2log.splitlines():
        i = l.find("{")
        if i >= 0 and '"ver2w"' in l:
            try: vers.append(json.loads(l[i:]))
            except Exception: pass
    check("W5 two workers: both answered (2 results)", len(vers) == 2, str(len(vers)))
    check("W5 each got its OWN response (ok, no request-steal, own id prefix)",
          all(v.get("ok") is True and v.get("status") == 200 and
              v.get("method") is None and
              isinstance(v.get("id"), str) and v["id"].startswith(v.get("wid", "~"))
              for v in vers),
          json.dumps(vers)[:260])

    print()
    failed = [r for r in results if not r[1]]
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    run()
