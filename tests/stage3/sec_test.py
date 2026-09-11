#!/usr/bin/env python3
"""Stage-3 sender-security-gate e2e (2026-09-11).

Real extension, real pipe (page self-postMessage → relay → SW → fs-sec
gate → fsRoute), no folder grant needed — /health answers 200 with
ok:false when no root exists, so every PASS/FAIL below is about the
GATE, not the filesystem. No X driver, no picker: this suite runs
anywhere the others' native-picker steps cannot.

The gate under test (extension/fs-sec.js, sw.js handleOfbRequest):
  tier 1  origin allowlist on browser-set sender metadata
  tier 2  optional bridge token carried per request
  UNLOCKED (neither configured) → denied outright (app parity)

Cells (driven from Python via page.evaluate — the page self-post is a
legit relay client; isDescendantIframe trivially matches the page
itself, which is exactly the any-website exposure the gate closes):
  P0  UNLOCKED          → 403 security_locked (+ self-named origin)
  P0b options page      → trusted sender: /health 200 even UNLOCKED
  P1  origin allowed    → 200
  P2  token set, none   → 403 token_required
  P3  token set, right  → 200
  P4  /state            → security "token+origin", allowed_origins, token_required
  U1  evil sender (SW)  → 403 origin_blocked + denied-ring row
  U2  no-origin sender  → 403 security_blocked
  U3  own-id sender     → null (trusted, app pages)
"""
import json
import os
import shutil
import sys
import threading
import time
import functools
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import spike1  # noqa: E402
from spike1 import build_test_extension, find_ext, sec_configure, TEST_TOKEN

SCRATCH = Path(os.environ.get("OFB_SEC_DIR", "/tmp/ofb-s3/sec"))
results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (" — " + detail if detail else ""))


PAGE_JS = """
window.__ofbPending = {};
window.__ofbSeq = 0;
window.addEventListener("message", (ev) => {
  const m = ev.data;
  // responses never carry `method`; the page's own self-posted REQUEST
  // also lands here and must not resolve anything
  if (m && m.ofb === true && m.method === undefined && __ofbPending[m.id]) {
    __ofbPending[m.id](m);
    delete __ofbPending[m.id];
  }
});
window.ofbReq = (method, path, token) => new Promise((resolve) => {
  const id = "p" + (++__ofbSeq);
  const msg = { ofb: true, id, method, path };
  if (token) msg.token = token;
  __ofbPending[id] = resolve;
  window.postMessage(msg, "*");   // self-post: the relay's own page client
  setTimeout(() => { if (__ofbPending[id]) {
    resolve({ ofb: true, id, ok: false, status: 0, error: "timeout" });
    delete __ofbPending[id]; } }, 20000);
});
"""

PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>sec gate</title></head>
<body><pre id="log">sec harness</pre>
<script>""" + PAGE_JS + """</script>
</body></html>"""


def main():
    from playwright.sync_api import sync_playwright

    if SCRATCH.exists():
        shutil.rmtree(SCRATCH)
    SCRATCH.mkdir(parents=True)
    ext = build_test_extension(SCRATCH)
    (SCRATCH / "sec-page.html").write_text(PAGE)

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(SCRATCH))
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    print("harness server:", base)

    headed = os.environ.get("OFB_SEC_HEADED") == "1"
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(SCRATCH / "profile"), headless=not headed,
            args=["--disable-extensions-except=" + str(ext),
                  "--load-extension=" + str(ext)])
        sw, ext_origin = find_ext(ctx)
        if not ext_origin:
            print("VERDICT: FAIL — no service worker (try OFB_SEC_HEADED=1)")
            ctx.close()
            return 1
        print("SW up:", ext_origin)

        opt = ctx.new_page()
        opt.goto(ext_origin + "/options.html")
        opt.wait_for_selector("#pick", timeout=10000)

        page = ctx.new_page()
        page.goto(base + "/sec-page.html")
        page.wait_for_function("typeof window.ofbReq === 'function'")

        def req(token=None, path="/health"):
            return page.evaluate(
                "([t, p]) => ofbReq('GET', p, t).then(d => "
                "  ({ status: d.status, ok: d.ok, body: d.body }))",
                [token, path])

        def body_of(r):
            try:
                return json.loads(r.get("body") or "{}")
            except Exception:
                return {}

        # ---- P0: UNLOCKED → denied, self-explaining ----
        r = req()
        b = body_of(r)
        check("P0 unlocked denied (403 security_locked)",
              r["status"] == 403 and b.get("security_locked") is True,
              json.dumps(b)[:180])
        check("P0b body names the requesting origin",
              b.get("origin") == base, str(b.get("origin")))

        # ---- P0c: extension's own options page is trusted even UNLOCKED ----
        trusted = opt.evaluate(
            "() => pipe('GET', '/health').then(r => r.status)")
        check("P0c options page trusted while UNLOCKED", trusted == 200,
              str(trusted))

        # ---- P1: origin allowed (no token tier yet) ----
        sec_configure(opt, base, token=None)
        r = req()
        check("P1 allowed origin served (200, no-folder body)", r["status"] == 200,
              json.dumps(body_of(r))[:120])

        # ---- P2/P3: token tier ----
        sec_configure(opt, base, token=TEST_TOKEN)
        r = req()
        b = body_of(r)
        check("P2 missing token denied (403 token_required)",
              r["status"] == 403 and b.get("token_required") is True,
              json.dumps(b)[:160])
        r = req(token=TEST_TOKEN)
        check("P3 right token served (200)", r["status"] == 200, "")
        r = req(token="wrong-token")
        check("P3b wrong token denied", r["status"] == 403 and
              body_of(r).get("token_required") is True, "")

        # ---- P4: /state reports the tier model (single site) ----
        r = req(token=TEST_TOKEN, path="/state")
        s = body_of(r)
        check("P4 /state security mode site+token",
              s.get("security") == "site+token", str(s.get("security")))
        check("P4b /state allowed_origin + token_required",
              s.get("allowed_origin") == base and s.get("token_required") is True,
              str(s.get("allowed_origin")))
        # single-site semantics: a SECOND origin must NOT be servable even
        # if it somehow landed in the legacy 3.0.18 list key
        opt.evaluate(
            "async () => { await OFBIDB.put('kv', ['https://other.example'], 'allowed_origins'); }")
        r = opt.evaluate(
            "() => pipe('GET', '/state').then(r => r.data)")
        check("P4c legacy list ignored once allowed_site is set",
              r and r.get("allowed_origin") == base, str(r and r.get("allowed_origin")))

        # ---- U1-U3: SW-context units (fabricated senders) ----
        u1 = sw.evaluate(
            "async () => { const g = await secGate("
            "  {ofb:true, id:1, method:'GET', path:'/health'},"
            "  {url: 'https://evil.example/owui'});"
            "  return JSON.parse(g.body); }")
        check("U1 evil origin blocked",
              u1.get("origin_blocked") is True and
              u1.get("origin") == "https://evil.example", json.dumps(u1)[:160])
        ring = sw.evaluate(
            "async () => (await kvGet('denied_origins', [])) || []")
        check("U1b denied ring recorded evil origin",
              any(x.get("o") == "https://evil.example" for x in ring), "")
        u2 = sw.evaluate(
            "async () => { const g = await secGate("
            "  {ofb:true, id:2, method:'GET', path:'/health'}, {});"
            "  return g ? JSON.parse(g.body).security_blocked === true : false; }")
        check("U2 originless sender blocked", bool(u2), "")
        u3 = sw.evaluate(
            "async () => secGate({ofb:true, id:3, method:'GET', path:'/health'},"
            "  {url: (chrome.runtime.getURL('x'))})")
        check("U3 own-extension sender trusted (null)", u3 is None, str(u3))

        ctx.close()
    httpd.shutdown()

    print()
    failed = [r for r in results if not r[1]]
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
