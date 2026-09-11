#!/usr/bin/env python3
"""Stage-3 out-of-band confirmation e2e (2026-09-07).

Real browser, real extension, real pipe (sandbox iframe → relay → SW →
fs-confirm gate). confirm.js loads in the harness page (content script);
its popup card is closed-shadow so the host cannot click it — verdicts
are delivered through the SAME code path the popup uses
(confirmVerdict in the SW), and the card's rendering is verified
separately by the UI screenshot pass.

Cells:
  A (SW-context, Worker evaluate):
     scope default "all"; gate raises 403+confirm_id for /delete
  B (real pipe, Pyodide):
     c1 delete → 403 confirmation_required (+confirm_id captured)
     c2 overwrite gated / brand-new file NOT gated
     c3 approve(c1) → retry delete → 200 + trash path
     c4 grant is single-use → new delete re-asks
     c5 denied shape: raise, deny, retry → 403 denied=true
     c6 scope=off → overwrite sails through
     c7 confirm.js loaded in page (window.__ofbConfirmHost)
"""
import json
import os
import re
import sys
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import spike1  # noqa: E402
import engines_test  # assemble_harness_page + spike1_cells_python
from spike1 import build_test_extension, ensure_bookmark  # noqa: E402

GRANT = spike1.GRANT_DIR
SCRATCH = Path("/tmp/ofb-s3/confirm")
RUN = time.strftime("%H%M%S")
FIXREL = f"conf-{RUN}"
FIX = GRANT / FIXREL

CELLS = {
  # 2026-09-09 blocking design: the gate WAITS ~20 s for the click.
  # c0 proves the headline behavior — the driver approves MID-WAIT, so
  # the SAME call returns 200 (no retry round trip).
  "c0_blocking_approve": '''
d = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/target.txt", "content": "blocked-v1"}}))).to_py()
_r = "c0 status=" + str(d["status"])
assert d["status"] == 200, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
  "c1_delete_gated": '''
d = (await ofb_fetch("POST", "/delete", json.dumps({{"path": "{F}/delme.txt"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "c1 status=" + str(d["status"]) + " conf=" + str(b.get("confirmation_required")) + " timed_out=" + str(b.get("timed_out")) + " id=" + str(b.get("confirm_id"))
assert d["status"] == 403 and b.get("confirmation_required") is True and b.get("timed_out") is True and b.get("confirm_id"), _r + " raw: " + str(d)[:400]
print(_r); RESULT = _r
''',
  "c2_overwrite_vs_new": '''
d1 = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/target.txt", "content": "v2"}}))).to_py()
d2 = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/brandnew-{R}.txt", "content": "new"}}))).to_py()
b1 = json.loads(d1.get("body") or "{{}}")
_r = "c2 overwrite=" + str(d1["status"]) + "/" + str(b1.get("confirmation_required")) + " newfile=" + str(d2["status"])
assert d1["status"] == 403 and b1.get("confirmation_required") is True, _r + " raw1: " + str(d1)[:300]
assert d2["status"] == 200, _r + " raw2: " + str(d2)[:300]
print(_r); RESULT = _r
''',
  "c3_retry_after_approve": '''
d = (await ofb_fetch("POST", "/delete", json.dumps({{"path": "{F}/delme.txt"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
t = b.get("trash") or ""
_r = "c3 status=" + str(d["status"]) + " deleted=" + str(b.get("deleted")) + " trash=" + str(bool(t))
assert d["status"] == 200 and b.get("deleted") and t, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
  "c4_single_use": '''
d = (await ofb_fetch("POST", "/delete", json.dumps({{"path": "{F}/target.txt"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "c4 status=" + str(d["status"]) + " conf=" + str(b.get("confirmation_required")) + " id=" + str(b.get("confirm_id"))
assert d["status"] == 403 and b.get("confirmation_required") is True, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
  "c5_denied": '''
d = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/target.txt", "content": "nope"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "c5 status=" + str(d["status"]) + " denied=" + str(b.get("denied"))
assert d["status"] == 403 and b.get("denied") is True, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
  "c6_scope_off": '''
d = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/target.txt", "content": "v3"}}))).to_py()
_r = "c6 status=" + str(d["status"])
assert d["status"] == 200, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
  # c7 (2026-09-09): /versions/read returns the OLD content without a
  # popup and without touching the live file (the driver approves the
  # overwrite mid-wait so a snapshot exists).
  "c7_versions_read": '''
f = "{F}/vread-{R}.txt"
w1 = (await ofb_fetch("POST", "/write", json.dumps({{"path": f, "content": "ver1-original"}}))).to_py()
w2 = (await ofb_fetch("POST", "/write", json.dumps({{"path": f, "content": "ver2-later"}}))).to_py()
v = (await ofb_fetch("POST", "/versions/list", json.dumps({{"path": f}}))).to_py()
vb = json.loads(v["body"]) if v.get("body") else {{}}
ts = (vb.get("versions") or [{{}}])[0].get("ts", "")
r = (await ofb_fetch("POST", "/versions/read", json.dumps({{"path": f, "ts": ts}}))).to_py()
rb = json.loads(r["body"]) if r.get("body") else {{}}
cur = (await ofb_fetch("GET", "/read?path=" + f)).to_py()
cb = json.loads(cur["body"]) if cur.get("body") else {{}}
_r = "c7 w1=" + str(w1["status"]) + " w2=" + str(w2["status"]) + " ts=" + str(ts) + " read=" + str(rb.get("content")) + " live=" + str(cb.get("content"))
assert w1["status"] == 200 and w2["status"] == 200, _r
assert ts and r["status"] == 200 and rb.get("content") == "ver1-original", _r + " raw: " + str(r)[:300]
assert cb.get("content") == "ver2-later", _r + " live file must be untouched by /versions/read"
print(_r); RESULT = _r
''',
  # c8 (2026-09-09): a timed-out ask must NOT leave a dead card behind —
  # the driver checks data-ofb-cards mid-wait (>0) and after expiry (0).
  "c8_card_lifecycle": '''
d = (await ofb_fetch("POST", "/delete", json.dumps({{"path": "{F}/delme2.txt"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "c8 status=" + str(d["status"]) + " timed_out=" + str(b.get("timed_out"))
assert d["status"] == 403 and b.get("timed_out") is True, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
}


def prep():
    FIX.mkdir(parents=True, exist_ok=True)
    (FIX / "target.txt").write_text("v1 original\n")
    (FIX / "delme.txt").write_text("delete me\n")
    (FIX / "delme2.txt").write_text("delete me too\n")
    print("fixtures at", FIX)


def main():
    prep()
    SCRATCH.mkdir(parents=True, exist_ok=True)
    os.chdir(SCRATCH)

    class H(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    httpd = HTTPServer(("127.0.0.1", 0), H)
    port = httpd.server_address[1]
    base = f"http://127.0.0.1:{port}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    from playwright.sync_api import sync_playwright
    ext = build_test_extension(SCRATCH)
    profile = SCRATCH / "profile"
    if profile.exists():
        import shutil
        shutil.rmtree(profile)  # fresh every run (stale roots confuse gate paths)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile), executable_path=spike1.CHROME, headless=False,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}",
                  "--no-first-run", "--no-default-browser-check",
                  "--window-size=1000,700", "--window-position=140,60"],
            env={**os.environ, "DISPLAY": spike1.XDISPLAY}, no_viewport=True)

        ext_origin = None
        deadline = time.time() + 20
        while time.time() < deadline and ext_origin is None:
            for worker in ctx.service_workers:
                if worker.url.startswith("chrome-extension://"):
                    ext_origin = "chrome-extension://" + worker.url.split("//")[1].split("/")[0]
                    break
            if not ext_origin:
                try:
                    pg0 = ctx.pages[0] if ctx.pages else ctx.new_page()
                    pg0.goto("about:blank")
                    cdp = ctx.new_cdp_session(pg0)
                    for t in cdp.send("Target.getTargets")["targetInfos"]:
                        if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://"):
                            ext_origin = "chrome-extension://" + t["url"].split("//")[1].split("/")[0]
                    cdp.detach()
                except Exception:
                    pass
            time.sleep(0.5)
        assert ext_origin, "no SW"
        print("SW:", ext_origin)
        sw = None
        for _ in range(24):
            for worker in ctx.service_workers:
                if worker.url.startswith("chrome-extension://"):
                    sw = worker
                    break
            if sw:
                break
            try:
                (ctx.pages[0] if ctx.pages else ctx.new_page()).goto(ext_origin + "/options.html")
            except Exception:
                pass
            time.sleep(0.5)
        assert sw, "no SW worker handle"

        # grant via the proven picker flow
        drv = spike1.XDriver()
        ensure_bookmark()
        opt = ctx.new_page()
        opt.goto(ext_origin + "/options.html")
        opt.wait_for_selector("#pick")
        before = {w.id for w in drv.mapped_toplevels()}
        opt.click("#pick", timeout=5000)
        time.sleep(1.2)
        new = [w for w in drv.mapped_toplevels() if w.id not in before]
        assert new, "picker did not open"
        roots_len = spike1.picker_flow(drv, opt, new[-1].id)
        print("roots:", roots_len)
        assert roots_len >= 1
        time.sleep(1.0)

        # clean slate: scope "all" (the default) + sender gate open
        # (origin allowlist + test token; the harness bootstrap sends it)
        opt.evaluate("OFBIDB.put('kv', 'all', 'confirm_scope')")
        spike1.sec_configure(opt, base)
        time.sleep(0.3)

        verdicts = {}

        # ---- A. SW-context unit checks ----
        a1 = sw.evaluate("() => confirmScope().then(s => s)")
        verdicts["A_scope_default_all"] = a1 == "all"
        a2 = sw.evaluate(
            "() => confirmGate('POST','/delete', JSON.stringify({path:'%s/delme.txt'}), null)"
            ".then(g => g ? g.confirmation_required === true : false)" % FIXREL)
        verdicts["A_gate_raises"] = bool(a2)
        # A3 (2026-09-09 regression): /ocr_pdf with NO out must NOT ask —
        # the old b.out||b.path fallback asked to "overwrite" the INPUT
        # image (Dandan denied a false-alarm popup). With out set to an
        # existing target it still asks, about `out`, never the input.
        a3 = sw.evaluate("""() => {
            const real = confirmTargetExists;
            let asked = null;
            globalThis.confirmTargetExists = async (p) => { asked = p; return !!p; };
            // ^ real one resolves the path: empty/unresolvable -> false
            return confirmRequiredFor('POST', '/ocr_pdf', JSON.stringify({path: 'input.jpg'}))
              .then((noOut) => confirmRequiredFor('POST', '/ocr_pdf',
                  JSON.stringify({path: 'input.jpg', out: 'out.pdf'}))
              .then((withOut) => {
                  globalThis.confirmTargetExists = real;
                  return { noOut: noOut, withOut: withOut, asked: asked };
              }));
        }""")
        verdicts["A_ocrpdf_no_out_no_ask"] = a3["noOut"] is None
        verdicts["A_ocrpdf_out_asks_overwrite"] = a3["withOut"] == "overwrite"
        verdicts["A_ocrpdf_asks_out_not_input"] = a3["asked"] == "out.pdf"
        # A4 (2026-09-09): restores get their own op tag + wording — the
        # popup must say RESTORE, not "overwrite notes.md"
        a4 = sw.evaluate("""() => {
            const real = confirmTargetExists;
            globalThis.confirmTargetExists = async () => true;
            return confirmRequiredFor('POST', '/versions/restore',
                JSON.stringify({path: 'notes.md', ts: '20260909-101010-aa'}))
              .then((op) => {
                  globalThis.confirmTargetExists = real;
                  return { op: op, summary: describeOp(op, '/versions/restore',
                      JSON.stringify({path: 'notes.md', ts: '20260909-101010-aa'})) };
              });
        }""")
        verdicts["A_restore_op_tag"] = a4["op"] == "restore"
        verdicts["A_restore_wording"] = ("restore old version of notes.md" in a4["summary"])

        # ---- B. real-pipe cells ----
        def cell(name):
            return CELLS[name].replace("{F}", FIXREL).replace("{R}", RUN) \
                              .replace("{{", "{").replace("}}", "}")

        def run_cell_page(tag, src, keep_open=False):
            hp = SCRATCH / f"harness-{tag}.html"
            hp.write_text(engines_test.assemble_harness_page(
                spike1.OWUI, engines_test.spike1_cells_python(), {tag: src}))
            pg = ctx.new_page()
            pg.goto(base + f"/harness-{tag}.html")
            t0 = time.time()
            txt = ""
            while time.time() - t0 < 120:
                try:
                    txt = pg.evaluate(
                        "document.getElementById('log').textContent") or ""
                except Exception:
                    txt = ""
                if "ALL-SANDBOX-TESTS-DONE" in txt or "HARNESS-ERROR" in txt:
                    break
                time.sleep(1)
            print(f"--- harness ({tag}) ---")
            print(txt.strip()[:700])
            if keep_open:
                return pg, txt
            pg.close()
            return None, txt

        # c0: launch the cell, approve the ask MID-WAIT from the SW
        # (same entry point the popup's click uses) -> same call = 200
        hp0 = SCRATCH / "harness-c0.html"
        hp0.write_text(engines_test.assemble_harness_page(
            spike1.OWUI, engines_test.spike1_cells_python(),
            {"c0": cell("c0_blocking_approve")}))
        pg0 = ctx.new_page()
        pg0.goto(base + "/harness-c0.html")
        appr_id = None
        t0 = time.time()
        while time.time() - t0 < 15 and not appr_id:
            pend = sw.evaluate(
                "() => JSON.stringify(Array.from(CONFIRM_PENDING.entries())"
                ".map(e => [e[0], e[1].verdict, e[1].pathKey]))")
            try:
                for eid, v, pk in json.loads(pend):
                    if v is None and "target.txt" in pk:
                        appr_id = eid
            except Exception as e:
                print("parse err", e)
            if not appr_id:
                time.sleep(0.5)
        print("approve target:", appr_id)
        if appr_id:
            sw.evaluate(
                f"() => JSON.stringify(confirmVerdict('{appr_id}', 'approved'))")
        txt0 = ""
        t0 = time.time()
        while time.time() - t0 < 120:
            try:
                txt0 = pg0.evaluate(
                    "document.getElementById('log').textContent") or ""
            except Exception:
                txt0 = ""
            if "ALL-SANDBOX-TESTS-DONE" in txt0 or "HARNESS-ERROR" in txt0:
                break
            time.sleep(1)
        print("--- harness (c0) ---")
        print(txt0.strip()[:700])
        pg0.close()
        verdicts["B_c0_blocking_approve_same_call"] = ("c0 status=200" in txt0
                                                       and "HARNESS-ERROR" not in txt0)

        _txt1, txt1 = run_cell_page("c1", cell("c1_delete_gated"))
        verdicts["B_c1_delete_gated"] = ("c1 status=403" in txt1
                                         and "HARNESS-ERROR" not in txt1)
        cid = None
        m = re.search(r"c1 status=403[^\n]*id=([a-f0-9]+)", txt1)
        if m:
            cid = m.group(1)
        print("confirm_id:", cid)

        txt2 = run_cell_page("c2", cell("c2_overwrite_vs_new"))[1]
        verdicts["B_c2_overwrite_gated_new_not"] = (
            "overwrite=403/True" in txt2 and "newfile=200" in txt2
            and "HARNESS-ERROR" not in txt2)

        if cid:
            vr = sw.evaluate(
                f"() => JSON.stringify(confirmVerdict('{cid}', 'approved'))")
            print("verdict resp:", vr)
            verdicts["B_verdict_ok"] = '"ok":true' in vr
        else:
            verdicts["B_verdict_ok"] = False

        txt3 = run_cell_page("c3", cell("c3_retry_after_approve"))[1]
        verdicts["B_c3_retry_deletes"] = ("c3 status=200" in txt3
                                          and "HARNESS-ERROR" not in txt3)

        txt4 = run_cell_page("c4", cell("c4_single_use"))[1]
        verdicts["B_c4_single_use"] = ("c4 status=403" in txt4
                                       and "HARNESS-ERROR" not in txt4)

        # c5 (2026-09-09): the ask is raised BY the cell's own blocking
        # call — deny it mid-wait so the SAME call returns 403 denied
        hp5 = SCRATCH / "harness-c5.html"
        hp5.write_text(engines_test.assemble_harness_page(
            spike1.OWUI, engines_test.spike1_cells_python(),
            {"c5": cell("c5_denied")}))
        pg5 = ctx.new_page()
        pg5.goto(base + "/harness-c5.html")
        deny_id = None
        t0 = time.time()
        while time.time() - t0 < 15 and not deny_id:
            pend = sw.evaluate(
                "() => JSON.stringify(Array.from(CONFIRM_PENDING.entries())"
                ".map(e => [e[0], e[1].verdict, e[1].pathKey]))")
            try:
                for eid, v, pk in json.loads(pend):
                    if v is None and "target.txt" in pk:
                        deny_id = eid
            except Exception as e:
                print("parse err", e)
            if not deny_id:
                time.sleep(0.5)
        print("deny target:", deny_id)
        if deny_id:
            sw.evaluate(
                f"() => JSON.stringify(confirmVerdict('{deny_id}', 'denied'))")
        txt5 = ""
        t0 = time.time()
        while time.time() - t0 < 120:
            try:
                txt5 = pg5.evaluate(
                    "document.getElementById('log').textContent") or ""
            except Exception:
                txt5 = ""
            if "ALL-SANDBOX-TESTS-DONE" in txt5 or "HARNESS-ERROR" in txt5:
                break
            time.sleep(1)
        print("--- harness (c5) ---")
        print(txt5.strip()[:700])
        pg5.close()
        verdicts["B_c5_denied_shape"] = ("c5 status=403 denied=True" in txt5
                                         and "HARNESS-ERROR" not in txt5)

        opt.evaluate("OFBIDB.put('kv', 'off', 'confirm_scope')")
        time.sleep(0.3)
        txt6 = run_cell_page("c6", cell("c6_scope_off"))[1]
        verdicts["B_c6_scope_off"] = ("c6 status=200" in txt6
                                      and "HARNESS-ERROR" not in txt6)
        opt.evaluate("OFBIDB.put('kv', 'all', 'confirm_scope')")
        time.sleep(0.3)

        # c7 (2026-09-09): /versions/read — the w2 overwrite ASKS (scope
        # back to "all"), approve it mid-wait like c0 so a snapshot exists;
        # then the cell proves reading the old version needs no approval
        # and leaves the live file untouched.
        hp7 = SCRATCH / "harness-c7.html"
        hp7.write_text(engines_test.assemble_harness_page(
            spike1.OWUI, engines_test.spike1_cells_python(),
            {"c7": cell("c7_versions_read")}))
        pg7 = ctx.new_page()
        pg7.goto(base + "/harness-c7.html")
        appr7 = None
        t0 = time.time()
        vname = f"vread-{RUN}"
        while time.time() - t0 < 25 and not appr7:
            pend = sw.evaluate(
                "() => JSON.stringify(Array.from(CONFIRM_PENDING.entries())"
                ".map(e => [e[0], e[1].verdict, e[1].pathKey]))")
            try:
                for eid, v, pk in json.loads(pend):
                    if v is None and vname in pk:
                        appr7 = eid
            except Exception as e:
                print("parse err", e)
            if not appr7:
                time.sleep(0.5)
        print("c7 approve target:", appr7)
        if appr7:
            sw.evaluate(f"() => JSON.stringify(confirmVerdict('{appr7}', 'approved'))")
        txt7 = ""
        t0 = time.time()
        while time.time() - t0 < 120:
            try:
                txt7 = pg7.evaluate(
                    "document.getElementById('log').textContent") or ""
            except Exception:
                txt7 = ""
            if "ALL-SANDBOX-TESTS-DONE" in txt7 or "HARNESS-ERROR" in txt7:
                break
            time.sleep(1)
        print("--- harness (c7) ---")
        print(txt7.strip()[:700])
        pg7.close()
        verdicts["B_c7_versions_read"] = ("read=ver1-original" in txt7
                                         and "live=ver2-later" in txt7
                                         and "HARNESS-ERROR" not in txt7)

        # c8 (2026-09-09): card lifecycle — present mid-wait, AUTO-CLOSED
        # after expiry (no dead buttons squatting in the corner). The
        # content-script world is isolated; the DOM host element + its
        # data-ofb-cards attribute are the observable surface.
        hp8 = SCRATCH / "harness-c8.html"
        hp8.write_text(engines_test.assemble_harness_page(
            spike1.OWUI, engines_test.spike1_cells_python,
            {"c8": cell("c8_card_lifecycle")}))
        pg8 = ctx.new_page()
        pg8.goto(base + "/harness-c8.html")
        dom_ok = False
        card_ok = False
        t0 = time.time()
        while time.time() - t0 < 15 and not card_ok:
            try:
                dom_ok = bool(pg8.evaluate(
                    "() => !!document.getElementById('ofb-confirm-root')"))
                card_ok = dom_ok and bool(pg8.evaluate(
                    "() => { const h = document.getElementById('ofb-confirm-root');"
                    " if (!h) return false;"
                    " const c = h.getAttribute('data-ofb-cards');"
                    " return c ? parseInt(c, 10) > 0 : false; }"))
            except Exception as e:
                print("probe err", e)
            if not card_ok:
                time.sleep(0.6)
        print("card check: dom_ok=", dom_ok, "card_ok=", card_ok)
        try:
            pg8.screenshot(path=str(SCRATCH / "confirm-popup.png"))
        except Exception:
            pass
        # wait out the 20 s window + the 1.6 s auto-close grace
        txt8 = ""
        t0 = time.time()
        while time.time() - t0 < 60:
            try:
                txt8 = pg8.evaluate(
                    "document.getElementById('log').textContent") or ""
            except Exception:
                txt8 = ""
            if "ALL-SANDBOX-TESTS-DONE" in txt8 or "HARNESS-ERROR" in txt8:
                break
            time.sleep(1)
        time.sleep(3.5)
        autoclosed = False
        try:
            autoclosed = bool(pg8.evaluate(
                "() => { const h = document.getElementById('ofb-confirm-root');"
                " if (!h) return false;"
                " const c = h.getAttribute('data-ofb-cards');"
                " return c ? parseInt(c, 10) === 0 : false; }"))
        except Exception as e:
            print("probe err", e)
        print("autoclose check:", autoclosed, "| harness:", txt8.strip()[:120])
        pg8.close()
        verdicts["B_confirmjs_loaded"] = bool(dom_ok)
        verdicts["B_popup_card_rendered"] = bool(card_ok)
        verdicts["B_popup_autoclose_after_expiry"] = bool(autoclosed)
        verdicts["B_c8_timed_out_shape"] = ("c8 status=403 timed_out=True" in txt8
                                            and "HARNESS-ERROR" not in txt8)

        ctx.close()
    httpd.shutdown()

    print("\nverdicts:")
    allok = True
    for k, v in verdicts.items():
        print(f"  {k}: {'PASS' if v else 'FAIL'}")
        allok = allok and v
    print("\nCONFIRM E2E VERDICT:", "PASS" if allok else "FAIL")
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())
