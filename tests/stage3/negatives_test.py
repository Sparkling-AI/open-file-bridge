#!/usr/bin/env python3
"""Stage 3 P1b: negative cells re-targeted at the FS backend + new cells
(plan §8): permission-revoked shape already proven (spike-1 pass B); here:
  n1  evil destination //evil.com/x -> no-such-path 404 (never a fetch)
  n2  foreign url/port fields in body dropped (write goes to root only)
  n3  PUT method refused (pipe shape gate)
  n4  path outside roots (../../etc/passwd) -> refused
  n5  sensitive file floor (.env, id_rsa) -> 403
  n6  zip-slip refusal (zip with ../evil.txt member) -> 400
  n7  snapshot-on-disk: overwrite existing file -> .ofb-snapshots/<ts>/ copy
  n8  readonly root write refusal -> 403 (host flips the root row readonly)
  n9  moved endpoint clean error (docx_read) -> 501 + recipe, no hang
  n10 /convert dropped -> 501 office-app wording
  n11 rate breaker: hammer writes -> 429 rate_limited
  n12 overwrite of a file via /write returns snapshot info
"""
import functools
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

REPO = spike1.REPO
GRANT = spike1.GRANT_DIR
RUN = time.strftime("%H%M%S")
FIXREL = "neg-" + RUN
FIX = GRANT / FIXREL
SCRATCH = Path("/tmp/ofb-s3/neg")


def prep_fixtures():
    FIX.mkdir(parents=True, exist_ok=True)
    # a zip with a zip-slip member (built with python zipfile)
    import zipfile
    zp = FIX / f"evil-{RUN}.zip"
    with zipfile.ZipFile(zp, "w") as z:
        z.writestr("ok.txt", "innocent")
        z.writestr("../slipped.txt", "should never land")
    # existing file for snapshot test
    (FIX / "target.txt").write_text("original content v1\n")
    print("fixtures at", FIX)


def build_cells():
    F = FIXREL
    return {
        "n1_evil_dest": f'''d = (await ofb_fetch("GET", "/read?path=//evil.com/x")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "n1 status=" + str(d["status"])
assert d["status"] in (400, 404) and "evil.com" not in str(d.get("body", "")), _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
        "n2_foreign_fields": f'''wr = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/n2-{RUN}.txt", "content": "x", "url": "http://evil.example/", "port": 9999, "host": "evil.example"}}))).to_py()
b = json.loads(wr["body"]) if wr.get("body") else {{}}
_r = "n2 status=" + str(wr["status"]) + " written=" + str(b.get("written"))
assert wr["status"] == 200 and b.get("written", "").startswith("/{F}/"), _r + " raw: " + str(wr)[:300]
rd = (await ofb_fetch("GET", "/read?path={F}/n2-{RUN}.txt")).to_py()
assert rd["status"] == 200, "readback failed"
print(_r); RESULT = _r
''',
        "n3_put_refused": f'''d = (await ofb_fetch("PUT", "/write", json.dumps({{"path": "x", "content": "y"}}))).to_py()
_r = "n3 status=" + str(d["status"])
assert d["status"] == 0, _r + " raw: " + str(d)[:200]
print(_r); RESULT = _r
''',
        "n4_outside_roots": f'''for p in ["../../etc/passwd", "/etc/passwd", "{F}/../../../etc/passwd"]:
    d = (await ofb_fetch("GET", "/read?path=" + p)).to_py()
    assert d["status"] in (0, 400, 403, 404), p + " -> " + str(d["status"]) + " " + str(d.get("body", ""))[:100]
_r = "n4 all refused"
print(_r); RESULT = _r
''',
        "n5_sensitive_floor": f'''for p in ["{F}/.env", "{F}/id_rsa", "{F}/secrets.json"]:
    d = (await ofb_fetch("GET", "/read?path=" + p)).to_py()
    b = json.loads(d["body"]) if d.get("body") else {{}}
    assert d["status"] == 403, p + " -> " + str(d["status"]) + " " + str(b)[:150]
_r = "n5 sensitive 403 x3"
print(_r); RESULT = _r
''',
        "n6_zip_slip": f'''wr = (await ofb_fetch("POST", "/unzip", json.dumps({{"path": "{F}/evil-{RUN}.zip", "dest": "{F}/unz-{RUN}"}}))).to_py()
b = json.loads(wr["body"]) if wr.get("body") else {{}}
_r = "n6 status=" + str(wr["status"]) + " err=" + str(b.get("error", ""))[:60]
assert wr["status"] == 400 and "zip-slip" in str(b.get("error", "")), _r + " raw: " + str(wr)[:300]
print(_r); RESULT = _r
''',
        "n7_snapshot_on_disk": f'''wr = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/target.txt", "content": "overwritten v2"}}))).to_py()
b = json.loads(wr["body"]) if wr.get("body") else {{}}
snap = b.get("snapshot")
_r = "n7 snapshot=" + json.dumps(snap)[:120] if snap else "n7 NO SNAPSHOT"
assert wr["status"] == 200 and snap and snap.get("ts"), _r + " raw: " + str(wr)[:300]
print(_r); RESULT = _r
''',
        "n9_moved_clean": f'''d = (await ofb_fetch("GET", "/docx_read?path=inv.docx")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "n9 status=" + str(d["status"]) + " moved=" + str(b.get("moved"))
assert d["status"] == 501 and ("extension mode" in str(b.get("error", "")) or b.get("moved") or "recipe" in str(b.get("hint", ""))), _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
        "n10_convert_dropped": f'''d = (await ofb_fetch("POST", "/convert", json.dumps({{"path": "x.doc", "to": "docx"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "n10 status=" + str(d["status"])
assert d["status"] == 501 and "office app" in str(b.get("hint", "")), _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
        "zz_rate_breaker": f'''hit = None
for i in range(30):
    wr = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/rate-{RUN}-" + str(i) + ".txt", "content": "x" * 1000}}))).to_py()
    if wr["status"] == 429:
        b = json.loads(wr["body"]) if wr.get("body") else {{}}
        hit = (i, b.get("rate_limited"))
        break
_r = "n11 breaker at i=" + str(hit[0]) if hit else "n11 NEVER (30 writes, limits raised?)"
assert hit is not None and hit[1] is True, _r
print(_r); RESULT = _r
''',
    }


def build_harness_file(path, cells):
    src = (Path(__file__).parent / "spike1.py").read_text()
    start = src.index("    py = '''") + len("    py = '''")
    end = src.index("'''\n    cells = {", start)
    py = src[start:end]
    from engines_test import assemble_harness_page  # reuse
    page = assemble_harness_page(spike1.OWUI, py, cells)
    path.write_text(page)
    return path


def main():
    prep_fixtures()
    from playwright.sync_api import sync_playwright
    from engines_test import assemble_harness_page

    SCRATCH.mkdir(parents=True, exist_ok=True)
    ext = spike1.build_test_extension(SCRATCH)
    spike1.ensure_bookmark()

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(SCRATCH))
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    print("harness server:", base)

    src = (Path(__file__).parent / "spike1.py").read_text()
    start = src.index("    py = '''") + len("    py = '''")
    end = src.index("'''\n    cells = {", start)
    py = src[start:end]

    drv = spike1.XDriver()

    with sync_playwright() as p:
        profile = SCRATCH / "profile"
        if profile.exists():
            shutil.rmtree(profile)
        ctx = p.chromium.launch_persistent_context(
            str(profile), executable_path=spike1.CHROME, headless=False,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}",
                  "--no-first-run", "--no-default-browser-check",
                  "--window-size=1000,700", "--window-position=140,60"],
            env={**os.environ, "DISPLAY": spike1.XDISPLAY}, no_viewport=True)

        ext_origin = None
        deadline = time.time() + 15
        while time.time() < deadline and not ext_origin:
            for w in ctx.service_workers:
                if w.url.startswith("chrome-extension://"):
                    ext_origin = "chrome-extension://" + w.url.split("//")[1].split("/")[0]
                    break
            if not ext_origin:
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
            print("VERDICT: FAIL — no SW")
            ctx.close()
            return 1
        print("SW up:", ext_origin)

        setup = ctx.new_page()
        setup.goto(ext_origin + "/options.html")
        setup.wait_for_selector("#pick")
        time.sleep(0.5)
        before = {w.id for w in drv.mapped_toplevels()}
        setup.click("#pick", timeout=5000)
        pick_id = None
        dl = time.time() + 6
        while time.time() < dl and not pick_id:
            for w in drv.mapped_toplevels():
                if w.id not in before:
                    pick_id = w.id
                    drv.focus(w)
            time.sleep(0.3)
        n = spike1.picker_flow(drv, setup, pick_id)
        print("roots:", n)
        if not n:
            ctx.close()
            return 1

        # The out-of-chat confirmation gate (2026-09-08) is OFF for this
        # suite: with the default scope "all", /unzip ALWAYS asks (n6's
        # zip-slip 400 would surface as 403 confirmation_required) and
        # n7's overwrite would gate. The gate itself has a dedicated
        # suite (confirm_test.py); this one tests the FS-backend guards.
        setup.evaluate("OFBIDB.put('kv', 'off', 'confirm_scope')")
        time.sleep(0.3)

        # main negative cells (grant live: setup tab open)
        cells = build_cells()
        hpath = SCRATCH / "harness-neg.html"
        hpath.write_text(assemble_harness_page(spike1.OWUI, py, cells))
        pg = ctx.new_page()
        logs = []
        pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:200]}"))
        pg.goto(base + "/harness-neg.html")
        deadline = time.time() + 300
        text = ""
        while time.time() < deadline:
            try:
                text = pg.evaluate("document.getElementById('log').textContent")
            except Exception:
                text = ""
            if "ALL-SANDBOX-TESTS-DONE" in text or "HARNESS-ERROR" in text:
                break
            time.sleep(1)
        print("===== harness log (negatives) =====")
        print(text.strip())
        ok_main = "ALL-SANDBOX-TESTS-DONE" in text and "HARNESS-ERROR" not in text

        # n8: flip the root readonly in IDB (extension page context), retry write
        setup.evaluate("""
        new Promise((res) => {
          const rq = indexedDB.open('ofb-ext', 1);
          rq.onsuccess = () => {
            const tx = rq.result.transaction('roots', 'readwrite');
            const store = tx.objectStore('roots');
            const getAll = store.getAll();
            getAll.onsuccess = () => {
              const row = getAll.result[0];
              row.mode = 'read';
              store.put(row);
              tx.oncomplete = () => res('flipped');
            };
          };
        })
        """)
        time.sleep(0.5)
        cells8 = {"n8_readonly_refusal": (
            'd = (await ofb_fetch("POST", "/write", json.dumps({"path": "%s/n8-%s.txt", "content": "no"}))).to_py()\n'
            'b = json.loads(d["body"]) if d.get("body") else {}\n'
            '_r = "n8 status=" + str(d["status"]) + " err=" + str(b.get("error", ""))[:60]\n'
            'assert d["status"] == 403 and "read-only" in str(b.get("error", "")), _r + " raw: " + str(d)[:300]\n'
            'print(_r); RESULT = _r\n') % (FIXREL, RUN)}
        h8 = SCRATCH / "harness-n8.html"
        h8.write_text(assemble_harness_page(spike1.OWUI, py, cells8))
        pg8 = ctx.new_page()
        pg8.goto(base + "/harness-n8.html")
        deadline = time.time() + 180
        text8 = ""
        while time.time() < deadline:
            try:
                text8 = pg8.evaluate("document.getElementById('log').textContent")
            except Exception:
                text8 = ""
            if "ALL-SANDBOX-TESTS-DONE" in text8 or "HARNESS-ERROR" in text8:
                break
            time.sleep(1)
        print("===== harness log (n8 readonly) =====")
        print(text8.strip())
        ok8 = "ALL-SANDBOX-TESTS-DONE" in text8 and "HARNESS-ERROR" not in text8

        # n13: trash auto-expiry (30-day TTL, ext 3.0.8). Craft one stale
        # (1999) and one fresh (yesterday) trash dir ON DISK, force the
        # sweep via the SW's ofbTrashSweep hook, assert stale swept +
        # fresh (and its file) untouched.
        import datetime
        trash_root = GRANT / ".ofb-trash"
        stale = trash_root / "19990101-000000-aa"
        fresh_ts = (datetime.datetime.now() - datetime.timedelta(days=1)).strftime("%Y%m%d-%H%M%S") + "-bb"
        fresh = trash_root / fresh_ts
        stale.mkdir(parents=True, exist_ok=True)
        (stale / "old.txt").write_text("stale")
        fresh.mkdir(parents=True, exist_ok=True)
        (fresh / "new.txt").write_text("fresh")
        setup.evaluate(
            "chrome.runtime.sendMessage({ofbTrashSweep: true, force: true},"
            " (r) => { window.__sweep = JSON.stringify(r); })")
        time.sleep(1.5)
        sweep_res = setup.evaluate("window.__sweep")
        ok13 = ('"removed":1' in (sweep_res or "")
                and not stale.exists() and fresh.exists() and (fresh / "new.txt").exists())
        print("n13 trash expiry:", sweep_res,
              "| stale exists:", stale.exists(),
              "| fresh exists:", fresh.exists())
        # restore readwrite for any later phases (n8 flipped it)
        setup.evaluate("""
        new Promise((res) => {
          const rq = indexedDB.open('ofb-ext', 2);
          rq.onsuccess = () => {
            const tx = rq.result.transaction('roots', 'readwrite');
            const getAll = tx.objectStore('roots').getAll();
            getAll.onsuccess = () => {
              const row = getAll.result[0];
              row.mode = 'readwrite';
              tx.objectStore('roots').put(row);
              tx.oncomplete = () => res('restored');
            };
          };
        })
        """)
        time.sleep(0.3)

        pg.close()
        pg8.close()
        ctx.close()

    # disk evidence: snapshot dir on disk, slipped.txt absent
    print("\n== disk evidence ==")
    snaproot = GRANT / ".ofb-snapshots"
    snaps = list(snaproot.rglob("target.txt")) if snaproot.exists() else []
    print("snapshot copies of target.txt:", len(snaps), [str(s.relative_to(GRANT)) for s in snaps[:3]])
    slipped = (GRANT / "slipped.txt").exists() or (FIX / ".." / "slipped.txt").exists()
    print("slipped.txt outside:", "LEAKED" if slipped else "absent (good)")
    unz = FIX / f"unz-{RUN}" / "ok.txt"
    print("unzip partial extraction (must be False):", unz.exists())

    verdict = "PASS" if (ok_main and ok8 and ok13 and snaps and not slipped and not unz.exists()) else "FAIL"
    print(f"\nP1b NEGATIVES VERDICT: {verdict}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
