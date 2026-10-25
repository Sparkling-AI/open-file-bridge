#!/usr/bin/env python3
"""Spike: runtime-registered sandbox injection (2026-10-23).

THE untested core of the pilot org's design (b): can a DYNAMICALLY
registered content script (chrome.scripting.registerContentScripts,
matchOriginAsFallback, world MAIN, document_start) reach Open WebUI's
sandbox="allow-scripts" srcdoc iframe at the right moment, on the ONE
origin the user allowed — with no static https match in the manifest?

Cells:
  R1 registration happens via the options "Set site" click (the real
     user path incl. the permissions.request gesture) — SW reports
     registered:true + the pattern
  R2 a page on the ALLOWED origin builds the OWUI-shaped sandbox
     iframe (srcdoc, allow-scripts, pyodide from the local OWUI dist):
     js.ofb and js.OFB_CLIENT_PY exist INSIDE the frame, are undefined
     in the top page (scope guard), and are frozen
  R3 the one-liner works end-to-end through the REAL pipe:
     exec(js.OFB_CLIENT_PY); await ofb_init(token) → /health 200 via
     js.ofb.fetch, roots visible (harness profile has the grant)
  R4 stdout survives: print("BEFORE") + bridge call + print("AFTER")
     all visible (the stock-OWUI clobber fix)
  R5 a page on a DIFFERENT origin (not allowed): NO injection (ofb
     undefined in its sandbox frame)
  R6 permission revoked → registration gone (getRegisteredContentScripts
     view) — graceful degradation only

Usage: uv run --with playwright --with python-xlib --with pillow \
    python3 tests/stage3/injection_test.py
"""
import json
import os
import shutil
import sys
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import spike1  # noqa: E402
from spike1 import build_test_extension, ensure_bookmark, xvfb_env  # noqa: E402

GRANT = spike1.GRANT_DIR
SCRATCH = Path("/tmp/ofb-s3/inject")
RUN = time.strftime("%H%M%S")
results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name + (" — " + detail if detail else ""))


# sandbox-host replica: the exact iframe shape OWUI's
# pyodideSandboxHost.ts builds. Proven mechanics from the Stage-1 spike
# (references/extension-spike.md):
#   - OWUI-served pyodide has NO ESM named export: dynamic import() in
#     a CLASSIC script, then globalThis.loadPyodide (a <script
#     type=module> inside the srcdoc NEVER executes)
#   - set iframe.srcdoc BEFORE appendChild
#   - </script> inside any JS string literal terminates the block —
#     always split it as "<\" + \"script>"
HARNESS = """<!doctype html><html><head><meta charset="utf-8">
<title>ofb-inject-spike</title></head><body>
<p>spike host page</p>
<script>
(async () => {
  const mod = await import("__PYODIDE__pyodide.mjs");
  globalThis.loadPyodide = mod.loadPyodide;
  const FRAME_PY = `
    parent.postMessage({ pyReady: true }, "*");
    self.onmessage = async (ev) => {
      const d = ev.data;
      if (d && d.ofbProbeReq) {
        parent.postMessage({ ofbProbe: {
          ofb: typeof ofb,
          ver: (typeof ofb !== "undefined" && ofb) ? ofb.version : null,
          py: typeof OFB_CLIENT_PY,
          len: (typeof OFB_CLIENT_PY !== "undefined") ? OFB_CLIENT_PY.length : 0,
          frozen: (() => { try { return (typeof ofb !== "undefined") &&
            Object.isFrozen(ofb); } catch (e) { return null; } })(),
          origin: self.origin, href: location.href,
        } }, "*");
        return;
      }
      if (!d || d.id === undefined || d.code === undefined) return;
      const OUT = [], ERR = [];
      try {
        if (!self.pyodide) {
          self.pyodide = await loadPyodide({ indexURL: "__PYODIDE__" });
        }
        // (re)bind per-cell so stdout lands in THIS cell's OUT array
        self.pyodide.setStdout({ batched: (s) => OUT.push(s) });
        self.pyodide.setStderr({ batched: (s) => ERR.push(s) });
        let RESULT = null;
        await self.pyodide.runPythonAsync(
          d.code + "\\\\n\\\\nimport json as _j\\\\nRESULT = _j.dumps(RESULT)");
        const r = self.pyodide.globals.get("RESULT");
        parent.postMessage({ id: d.id, stdout: OUT.join("\\\\n"), stderr: ERR.join("\\\\n"), result: (r === null || r === undefined) ? null : String(r) }, "*");
      } catch (e) {
        parent.postMessage({ id: d.id, stdout: OUT.join("\\\\n"), stderr: String(e) + "\\\\n" + ERR.join("\\\\n") }, "*");
      }
    };
  `;
  const FRAME_HTML = "<scr" + "ipt>" + FRAME_PY +
    "import('" + "__PYODIDE__pyodide.mjs" + "').then((m) => { globalThis.loadPyodide = m.loadPyodide; parent.postMessage({ frameLib: true }, '*'); });" +
    "</scr" + "ipt>";
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.srcdoc = FRAME_HTML;      // BEFORE appendChild (spike gotcha e)
  document.body.appendChild(iframe);
  window.__frame = iframe;
  window.runCell = (code) => new Promise((res) => {
    const id = "cell-" + Math.random().toString(36).slice(2);
    const onMsg = (ev) => {
      if (ev.source !== iframe.contentWindow) return;
      if (ev.data && ev.data.id === id) {
        removeEventListener("message", onMsg);
        res(ev.data);
      }
    };
    addEventListener("message", onMsg);
    iframe.contentWindow.postMessage({ id, code }, "*");
  });
})();
</script></body></html>
"""

CELL_ONE_LINER = r'''
import js
res = {}
res["has_client_py"] = hasattr(js, "OFB_CLIENT_PY")
res["client_len"] = len(getattr(js, "OFB_CLIENT_PY", ""))
exec(js.OFB_CLIENT_PY)
ofb_set_token(__TOKEN__)          # token BEFORE the first call
h = await ofb_init(quiet=True)
res["health_version"] = h.get("version")
res["roots"] = [r.get("id") for r in (h.get("roots") or [])]
res["transport_js"] = _S.get("transport") is None  # auto mode used js pipe
RESULT = res
'''
CELL_STDOUT = r'''
import js
exec(js.OFB_CLIENT_PY)
ofb_set_token(__TOKEN__)
print("BEFORE")
h = await ofb_init(quiet=True)
w = await bridge_get("/version")
print("AFTER")
RESULT = {"before_after": True, "version": w.get("bridge")}
'''


def main():
    SCRATCH.mkdir(parents=True, exist_ok=True)
    ext = spike1.build_test_extension(SCRATCH)
    spike1.ensure_bookmark()

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(SCRATCH))
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    print("harness server:", base)

    drv = spike1.XDriver()

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        profile = SCRATCH / "profile"
        if profile.exists():
            shutil.rmtree(profile)
        ctx = p.chromium.launch_persistent_context(
            str(profile), executable_path=spike1.CHROME, headless=False,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}",
                  "--no-first-run", "--no-default-browser-check",
                  "--window-size=1000,700", "--window-position=140,60"],
            env=xvfb_env(), no_viewport=True)

        sw = None
        ext_origin = None
        deadline = time.time() + 15
        while time.time() < deadline and not (sw or ext_origin):
            for w in ctx.service_workers:
                if w.url.startswith("chrome-extension://"):
                    sw = w
                    ext_origin = "chrome-extension://" + w.url.split("//")[1].split("/")[0]
            time.sleep(0.5)
        if not sw:
            # CDP fallback — also HANDLES the case where the SW handle
            # binding is stale: re-collect workers each round
            try:
                pg0 = ctx.pages[0] if ctx.pages else ctx.new_page()
                cdp = ctx.new_cdp_session(pg0)
                for t in cdp.send("Target.getTargets")["targetInfos"]:
                    if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://"):
                        ext_origin = "chrome-extension://" + t["url"].split("//")[1].split("/")[0]
                cdp.detach()
            except Exception:
                pass
        print("SW up:", ext_origin)
        if not ext_origin:
            ctx.close(); return 1
        if sw is None:
            # rebind after any SW restart (options-page interactions can
            # relaunch the worker between bindings)
            for _ in range(20):
                for w in ctx.service_workers:
                    if w.url.startswith("chrome-extension://"):
                        sw = w
                        break
                if sw:
                    break
                time.sleep(0.5)

        # options page: grant folder via the picker (bookmark flow), then
        # "Set site" -> permission + registration (R1)
        opt = ctx.new_page()
        opt.goto(ext_origin + "/options.html")
        opt.wait_for_selector("#pick", timeout=10000)

        # folder grant via the proven X driver flow
        n = spike1.picker_flow(drv, opt, None)
        print("roots after pick:", n)
        check("R0a folder granted via picker", isinstance(n, int) and n >= 1, f"roots={n}")

        # sender gate for the harness origin + token (spike1 helper)
        spike1.sec_configure(opt, base)
        # NOW the injection wiring: type the site, click Set site.
        # The click IS a user gesture → Chrome shows the native
        # "Allow extension to read data on…" bubble; answer it with the
        # X driver (same technique as the FS-grant bubble).
        opt.fill("#siteadd", base)
        opt.click("#siteaddbtn")
        time.sleep(1.2)
        drv.screenshot("inj-bubble")
        # fan-click candidate Allow positions — vision-measured 2026-10-23:
        # the optional-permission bubble anchors ~y331 under the omnibox,
        # Allow (right button) at (810,331); fan around it
        granted_ui = False
        for bx, by in ((810, 331), (790, 331), (830, 331), (810, 310), (810, 350), (734, 331)):
            drv.click(bx, by)
            time.sleep(0.8)
            reg = sw.evaluate("() => chrome.scripting.getRegisteredContentScripts()"
                              ".then((s) => s.map((x) => ({id: x.id, matches: x.matches})))")
            if any(r["id"] == "ofb-inject" for r in reg):
                granted_ui = True
                drv.screenshot("inj-bubble-hit")
                break
            time.sleep(0.4)
        print("ui-path granted:", granted_ui)
        stat = opt.text_content("#sitestat") or ""
        print("sitestat after Set site:", stat)
        reg = sw.evaluate("() => chrome.scripting.getRegisteredContentScripts()"
                          ".then((s) => s.map((x) => ({id: x.id, matches: x.matches})))")
        print("registered scripts:", reg)
        if not any(r["id"] == "ofb-inject" for r in reg):
            # Playwright auto-dismisses permission prompts; grant via the
            # extension's own permission API from the SW context instead
            js_req = ("() => chrome.permissions.request({origins: ['%s/*']})"
                      ".then(() => chrome.runtime.sendMessage({ofbInjectSync: true, register: true}))") % base
            try:
                gr = sw.evaluate(js_req)
            except Exception as e:
                # permissions.request needs a user gesture; grant the OPTIONAL
                # host permission via the extension's own permission API and
                # then sync registration (the SW evaluates with extension
                # privileges, so contains() sees the grant)
                gr = None
                print("sw-side request rejected (expected, no gesture):", str(e)[:120])
            if not (gr and gr.get("registered")):
                js_req2 = ("() => (chrome.permissions.contains({origins: ['%s/*']})"
                           ".then((has) => has ? chrome.runtime.sendMessage({ofbInjectSync: true, register: true})"
                           " : {ok: false, reason: 'no permission'}))") % base
                gr2 = sw.evaluate(js_req2)
                print("contains+register:", gr2)
                if not (gr2 and gr2.get("registered")):
                    # LAST resort, test-env only: write the permission via CDP
                    # is impossible — instead pre-grant through the options
                    # page click WITH Playwright's dialog auto-accept... which
                    # doesn't exist. The honest path: mark R1 skipped.
                    print("NOTE: could not grant host permission headlessly")
            reg = sw.evaluate("() => chrome.scripting.getRegisteredContentScripts()"
                              ".then((s) => s.map((x) => ({id: x.id, matches: x.matches})))")
        hit = [r for r in reg if r["id"] == "ofb-inject"]
        check("R1 injector registered for the allowed origin",
              bool(hit) and hit[0]["matches"] == [base + "/*"],
              json.dumps(reg))

        # static manifest must NOT declare broad content scripts
        static_cs = sw.evaluate("() => fetch(chrome.runtime.getURL('manifest.json'))"
                                ".then((r) => r.json()).then((m) => m.content_scripts || [])")
        check("R1b manifest has NO static injector entry",
              not any("inject-main" in json.dumps(cs) for cs in static_cs),
              json.dumps(static_cs)[:200])

        # harness page on the ALLOWED origin
        hp = SCRATCH / "spike-host.html"
        hp.write_text(HARNESS.replace("__PYODIDE__", spike1.OWUI + "/pyodide/"))
        pg = ctx.new_page()
        console = []
        pg.on("console", lambda m: console.append(f"[{m.type}] {m.text[:200]}"))
        pg.on("pageerror", lambda e: console.append(f"[pageerror] {str(e)[:300]}"))
        pg.goto(base + "/spike-host.html")
        # wait for the frame + pyodide
        time.sleep(12)
        print("harness console:", console[:10])
        frame_ready = pg.evaluate("() => new Promise((res) => {"
                                  "  if (window.__frame) res(!!window.__frame); else setTimeout(() => res(!!window.__frame), 3000);"
                                  "})")
        check("R2a sandbox iframe built", bool(frame_ready))
        # scope guard: top page must NOT see ofb
        top_ofb = pg.evaluate("() => typeof ofb")
        check("R2b top page has NO ofb (scope guard)", top_ofb == "undefined", f"typeof ofb = {top_ofb}")
        # the frame is OPAQUE (cross-origin to the parent): a parent eval
        # into it is impossible — ask the frame to report itself (the
        # same postMessage channel the cells use). The frame's reply to
        # a probe message is the ONLY way to see inside it.
        probe = pg.evaluate("""() => new Promise((res) => {
          const t0 = Date.now();
          const onMsg = (ev) => {
            if (ev.source === window.__frame.contentWindow && ev.data && ev.data.ofbProbe) {
              removeEventListener("message", onMsg);
              res(JSON.stringify(ev.data.ofbProbe));
            } else if (Date.now() - t0 > 8000) {
              removeEventListener("message", onMsg);
              res(null);
            }
          };
          addEventListener("message", onMsg);
          window.__frame.contentWindow.postMessage({ ofbProbeReq: true }, "*");
          const tick = () => {
            if (Date.now() - t0 > 8000) { removeEventListener("message", onMsg); res(null); }
          };
          setTimeout(tick, 8100);
        })""")
        # the harness frame answers ofbProbeReq (added to FRAME_PY below)
        print("frame probe:", probe)
        try:
            pr = json.loads(probe) if probe else {}
        except Exception:
            pr = {}
        check("R2c ofb + OFB_CLIENT_PY inside the sandbox frame",
              pr.get("ofb") == "object" and pr.get("py") == "string" and pr.get("len", 0) > 5000,
              str(pr))
        check("R2d frame is opaque-origin srcdoc",
              pr.get("origin") == "null" and pr.get("href") == "about:srcdoc", str(pr))

        # R3/R4: run the one-liner through the real pipe
        tok = spike1.TEST_TOKEN
        cell = CELL_ONE_LINER.replace("__TOKEN__", repr(tok))
        out = pg.evaluate("(c) => window.runCell(c)", cell)
        print("one-liner result:", out)
        try:
            r3 = json.loads((out or {}).get("result") or "{}")
        except Exception:
            r3 = {}
        ok3 = (r3.get("health_version") == "3.7.1-EXT" and
               isinstance(r3.get("roots"), list) and len(r3["roots"]) >= 1 and
               r3.get("has_client_py") is True and r3.get("client_len", 0) > 5000)
        check("R3 one-liner exec + ofb_init via js pipe", bool(ok3),
              str(r3)[:200] or str(out)[:200])
        cell2 = CELL_STDOUT.replace("__TOKEN__", repr(tok))
        out2 = pg.evaluate("(c) => window.runCell(c)", cell2)
        print("stdout cell:", out2)
        lines = (out2 or {}).get("stdout", "")
        check("R4 stdout survives bridge calls (BEFORE+AFTER)",
              "BEFORE" in lines and "AFTER" in lines, lines[:200])
        check("R4b no bogus 'includes' stderr",
              "includes" not in (out2 or {}).get("stderr", ""),
              (out2 or {}).get("stderr", "")[:200])

        # R5: second origin — NOT allowed, NO injection
        httpd2 = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=httpd2.serve_forever, daemon=True).start()
        base2 = f"http://127.0.0.1:{httpd2.server_address[1]}"
        pg2 = ctx.new_page()
        pg2.goto(base2 + "/spike-host.html")
        time.sleep(10)
        # same postMessage probe (cross-origin eval is impossible)
        probe2 = pg2.evaluate("""() => new Promise((res) => {
          const t0 = Date.now();
          const onMsg = (ev) => {
            if (ev.source === window.__frame.contentWindow && ev.data && ev.data.ofbProbe) {
              removeEventListener("message", onMsg); res(JSON.stringify(ev.data.ofbProbe));
            }};
          addEventListener("message", onMsg);
          window.__frame.contentWindow.postMessage({ ofbProbeReq: true }, "*");
          setTimeout(() => { removeEventListener("message", onMsg); res(null); }, 6000);
        })""")
        check("R5 other origin: NO injection",
              bool(probe2) and json.loads(probe2).get("ofb") == "undefined", str(probe2))

        # R6: site cleared → registration gone + permission dropped
        # (Edit and Remove are both button.secondary inside #siteview —
        # target Remove by its text)
        opt.click('#siteview button:has-text("Remove")')
        time.sleep(1.0)
        reg_after = sw.evaluate("() => chrome.scripting.getRegisteredContentScripts()"
                                ".then((s) => s.some((x) => x.id === 'ofb-inject'))")
        check("R6 clearing the site removes the registration",
              reg_after is False, str(reg_after))

        ctx.close()

    ok = all(v for _, v in results)
    print()
    for name, v in results:
        print(("PASS " if v else "FAIL ") + name)
    print("INJECTION SPIKE VERDICT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    import functools
    sys.exit(main())
