#!/usr/bin/env python3
"""Stage 3 P3+P4 test: engine endpoints (/pdf_text /pdf_op /ocr /ocr_pdf)
through the REAL pipe (sandbox iframe -> relay -> SW -> engines) in a real
browser with a real granted folder. Reuses spike1.py machinery.

Cells (Python, run inside the sandboxed Pyodide iframe):
  e0  /health addons {pdf:true, ocr:true}
  e1  /pdf_text inv.pdf -> "E2E INVOICE 997" + "44000 SEK" (spike-3 corpus)
  e2  /pdf_text multi.pdf pages=2-3 -> exactly pages 2,3
  e3  /pdf_text?mode=images -> png_b64 PNG magic + size
  e4  /pdf_op split -> on-disk .p1.pdf, re-read via /pdf_text matches page 1
  e5  /pdf_op merge x2 -> 2 pages, 2 probe hits
  e6  /pdf_op rotate 90 -> written; text survives
  e7  /ocr inv.png eng -> 997 + 44000
  e8  /ocr swe.png swe+eng -> åäö AND spike-4 digit gates
  e9  /ocr multi.pdf (raster path) max_pages=2 -> 2 pages with lines
  e10 /ocr_pdf inv.png -> searchable pdf; /pdf_text on it finds probes
  e11 /ocr/lang POST -> /ocr/config reflects swe+eng
  e12 engine tab closed -> /pdf_text -> 409 engine_needed (host-driven, last)
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
FIXREL = "engines-" + RUN          # inside the granted root
FIX = GRANT / FIXREL

SCRATCH = Path("/tmp/ofb-s3/engines")
S3 = Path("/tmp/ofb-s3")


def prep_fixtures():
    GRANT.mkdir(parents=True, exist_ok=True)
    FIX.mkdir(parents=True, exist_ok=True)
    srcs = [
        (S3 / "spike3/inv.pdf", "inv.pdf"),
        (S3 / "spike3/multi.pdf", "multi.pdf"),
        (S3 / "spike3/inv-scan.pdf", "inv-scan.pdf"),
        (S3 / "spike4/inv.png", "inv.png"),
        (S3 / "spike4/swe.png", "swe.png"),
    ]
    for src, name in srcs:
        if not src.exists():
            print("FATAL missing fixture", src)
            sys.exit(2)
        (FIX / name).write_bytes(src.read_bytes())
    print("fixtures at", FIX)


def build_cells():
    """Python cell sources for the Pyodide harness (ofb_fetch from spike1)."""
    F = FIXREL
    return {
        "e0_health": f'''d = (await ofb_fetch("GET", "/health")).to_py()
h = json.loads(d["body"])
_r = "e0 addons=" + str(h.get("addons"))
assert d["status"] == 200 and h.get("addons", {{}}).get("pdf") is True and h["addons"].get("ocr") is True, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
        "e1_pdf_text": f'''d = (await ofb_fetch("GET", "/pdf_text?path={F}/inv.pdf")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
t = " | ".join(p.get("text", "") for p in b.get("pages", []))
_r = "e1 page_count=" + str(b.get("page_count")) + " text=" + t[:60]
assert d["status"] == 200 and "E2E INVOICE 997" in t and "44000 SEK" in t, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
        "e2_subset": f'''d = (await ofb_fetch("GET", "/pdf_text?path={F}/multi.pdf&pages=2-3")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
pages = b.get("pages", [])
_r = "e2 pages=" + str([p.get("page") for p in pages])
assert d["status"] == 200 and len(pages) == 2 and pages[0].get("page") == 2 and pages[1].get("page") == 3, _r + " raw: " + str(d)[:300]
joined = "|".join(p.get("text", "") for p in pages)
assert len(joined) > 20, "page texts too short"
print(_r); RESULT = _r
''',
        "e3_images": f'''d = (await ofb_fetch("GET", "/pdf_text?path={F}/inv.pdf&mode=images")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
p1 = (b.get("pages") or [{{}}])[0]
png_b64 = p1.get("png_b64", "")
head = __import__("base64").b64decode(png_b64[:8]) if png_b64 else b""
_r = "e3 png_head=" + str(head[:4]) + " size=" + str(p1.get("size"))
assert d["status"] == 200 and head[:4] == b"\\x89PNG" and (p1.get("size") or [0])[0] > 100, _r + " raw: " + str(d)[:200]
print(_r); RESULT = _r
''',
        "e4_split": f'''out = "{F}/split-{RUN}.pdf"
d = (await ofb_fetch("POST", "/pdf_op", json.dumps({{"op": "split", "path": "{F}/inv.pdf", "out": out, "pages": "1"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "e4 split status=" + str(d["status"]) + " files=" + str(b.get("files"))
assert d["status"] == 200 and b.get("pages_split") == 1, _r + " raw: " + str(d)[:300]
t = (await ofb_fetch("GET", "/pdf_text?path={F}/split-{RUN}.p1.pdf")).to_py()
tb = json.loads(t["body"]) if t.get("body") else {{}}
tt = " ".join(p.get("text", "") for p in tb.get("pages", []))
assert t["status"] == 200 and "E2E INVOICE 997" in tt, "retext: " + tt[:100] + " raw: " + str(t)[:200]
_r += " | retext_ok"
print(_r); RESULT = _r
''',
        "e5_merge": f'''out = "{F}/merge-{RUN}.pdf"
d = (await ofb_fetch("POST", "/pdf_op", json.dumps({{"op": "merge", "paths": ["{F}/inv.pdf", "{F}/inv.pdf"], "out": out}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "e5 merge pages=" + str(b.get("pages")) + " bytes=" + str(b.get("bytes"))
assert d["status"] == 200 and b.get("pages") == 2, _r + " raw: " + str(d)[:300]
t = (await ofb_fetch("GET", "/pdf_text?path=" + out)).to_py()
tb = json.loads(t["body"]) if t.get("body") else {{}}
joined = " ".join(p.get("text", "") for p in tb.get("pages", []))
hits = joined.count("E2E INVOICE 997")
assert t["status"] == 200 and hits == 2, "hits=" + str(hits)
_r += " | hits=2"
print(_r); RESULT = _r
''',
        "e6_rotate": f'''out = "{F}/rot-{RUN}.pdf"
d = (await ofb_fetch("POST", "/pdf_op", json.dumps({{"op": "rotate", "path": "{F}/inv.pdf", "out": out, "angle": 90}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "e6 rotate status=" + str(d["status"]) + " rotated=" + str(b.get("pages_rotated"))
assert d["status"] == 200 and b.get("pages_rotated") == 1, _r + " raw: " + str(d)[:300]
t = (await ofb_fetch("GET", "/pdf_text?path=" + out)).to_py()
tb = json.loads(t["body"]) if t.get("body") else {{}}
joined = " ".join(p.get("text", "") for p in tb.get("pages", []))
assert t["status"] == 200 and "E2E INVOICE 997" in joined, "text lost: " + joined[:80]
_r += " | text_ok"
print(_r); RESULT = _r
''',
        "e7_ocr_inv": f'''d = (await ofb_fetch("GET", "/ocr?path={F}/inv.png&lang=eng")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
pages = b.get("pages", [])
t = " ".join(" ".join(p.get("lines", [])) for p in pages)
_r = "e7 ocr status=" + str(d["status"]) + " t=" + t[:60]
assert d["status"] == 200 and "997" in t and "44000" in t, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
        "e8_ocr_swe": f'''d = (await ofb_fetch("GET", "/ocr?path={F}/swe.png&lang=swe+eng")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
pages = b.get("pages", [])
t = " ".join(" ".join(p.get("lines", [])) for p in pages)
aa = all(c in t for c in "\\u00e5\\u00e4\\u00f6")
dg = all(x in t for x in ["24680", "13579", "3394.75", "55-123"])
_r = "e8 aa=" + str(aa) + " digits=" + str(dg) + " t=" + t[:60]
assert d["status"] == 200 and aa and dg, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
        "e9_ocr_pdf_raster": f'''d = (await ofb_fetch("GET", "/ocr?path={F}/multi.pdf&lang=eng&max_pages=2")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
pages = [p for p in b.get("pages", []) if p.get("lines")]
_r = "e9 pages=" + str([(p.get("page"), len(p.get("lines", []))) for p in pages])
assert d["status"] == 200 and len(pages) == 2, _r + " raw: " + str(d)[:300]
assert any(len(" ".join(p.get("lines", []))) > 10 for p in pages), "no content"
print(_r); RESULT = _r
''',
        "e10_ocr_pdf": f'''out = "{F}/searchable-{RUN}.pdf"
d = (await ofb_fetch("POST", "/ocr_pdf", json.dumps({{"path": "{F}/inv.png", "out": out, "lang": "eng"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "e10 ocr_pdf status=" + str(d["status"]) + " pages=" + str(b.get("pages")) + " bytes=" + str(b.get("bytes"))
assert d["status"] == 200 and b.get("pages") == 1 and b.get("bytes", 0) > 1000, _r + " raw: " + str(d)[:400]
t = (await ofb_fetch("GET", "/pdf_text?path=" + out)).to_py()
tb = json.loads(t["body"]) if t.get("body") else {{}}
joined = " ".join(p.get("text", "") for p in tb.get("pages", []))
assert t["status"] == 200 and "997" in joined and "44000" in joined, "searchable text: " + joined[:120] + " raw: " + str(t)[:200]
_r += " | searchable=" + joined.replace(chr(10), " ")[:60]
print(_r); RESULT = _r
''',
        "e11_ocr_lang": f'''s = (await ofb_fetch("POST", "/ocr/lang", json.dumps({{"lang": "swe eng"}}))).to_py()
c = (await ofb_fetch("GET", "/ocr/config")).to_py()
cb = json.loads(c["body"]) if c.get("body") else {{}}
avail = cb.get("available", [])
_r = "e11 lang=" + str(cb.get("ocr_lang")) + " avail=" + str(len(avail))
assert s["status"] == 200 and cb.get("ocr_lang") == "swe+eng", _r
assert len(avail) == 21 and avail == sorted(avail), _r + " order=" + str(avail)
print(_r); RESULT = _r
''',
        # e14 (2026-09-09): method-as-contract on engine endpoints + the
        # /image_info header parser port (it 500'd "not defined" in a real
        # chat). POST /ocr must TEACH the method, not 404 "unknown". Round
        # 2: the ROUTER-wide 405 — POST /image_info and GET /link are
        # known endpoints with the wrong method.
        "e14_method_contract": f'''d = (await ofb_fetch("POST", "/ocr", json.dumps({{"path": "{F}/inv.png", "lang": "eng"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "e14 post_ocr=" + str(d["status"]) + " err=" + str(b.get("error", ""))[:50]
assert d["status"] == 405 and "GET-only" in str(b.get("error", "")), _r + " raw: " + str(d)[:300]
pi = (await ofb_fetch("POST", "/image_info", json.dumps({{"path": "{F}/inv.png"}}))).to_py()
pib = json.loads(pi["body"]) if pi.get("body") else {{}}
_r += " | post_image_info=" + str(pi["status"])
assert pi["status"] == 405 and "GET-only" in str(pib.get("error", "")), _r + " raw: " + str(pi)[:300]
lk = (await ofb_fetch("GET", "/link?path={F}/inv.png")).to_py()
lkb = json.loads(lk["body"]) if lk.get("body") else {{}}
_r += " | get_link=" + str(lk["status"])
assert lk["status"] == 405 and "POST-only" in str(lkb.get("error", "")), _r + " raw: " + str(lk)[:300]
i = (await ofb_fetch("GET", "/image_info?path={F}/inv.png")).to_py()
ib = json.loads(i["body"]) if i.get("body") else {{}}
_r += " | image_info=" + str(i["status"]) + " " + str(ib.get("format")) + " " + str(ib.get("width")) + "x" + str(ib.get("height"))
assert i["status"] == 200 and ib.get("format") and ib.get("width", 0) > 0 and ib.get("height", 0) > 0, _r + " raw: " + str(i)[:300]
print(_r); RESULT = _r
''',
        # e15 (2026-09-09): a PROPERLY URL-encoded lang (swe%2Beng — what a
        # correct client sends for '+') must decode before the engine; the
        # raw-parse bug silently fell back to eng (garbage Swedish OCR).
        "e15_lang_encoded": f'''d = (await ofb_fetch("GET", "/ocr?path={F}/swe.png&lang=swe%2Beng")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
pages = b.get("pages", [])
t = " ".join(" ".join(p.get("lines", [])) for p in pages)
aa = all(c in t for c in "\\u00e5\\u00e4\\u00f6")
dg = all(x in t for x in ["24680", "13579", "3394.75", "55-123"])
_r = "e15 lang=" + str(b.get("lang")) + " aa=" + str(aa) + " digits=" + str(dg)
assert d["status"] == 200 and b.get("lang") == "swe+eng" and aa and dg, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
''',
    }


ENGINE_TAB_CLOSED_CELL = '''
d = (await ofb_fetch("GET", "/pdf_text?path={F}/inv.pdf")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "e12 status=" + str(d["status"]) + " engine_needed=" + str(b.get("engine_needed"))
assert d["status"] == 409 and b.get("engine_needed") is True, _r + " raw: " + str(d)[:300]
print(_r); RESULT = _r
'''

# auto-start ON (the default since 2026-09-07): with the engine tab closed,
# the SW must start the engines itself (offscreen document since ext
# 3.0.3 — no tab appears; the driver asserts that separately) and the op
# must SUCCEED.
ENGINE_AUTO_OPEN_CELL = '''
d = (await ofb_fetch("GET", "/pdf_text?path={F}/inv.pdf")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
t = " ".join(str(p.get("text", "")) for p in b.get("pages", []))
_r = "e13 auto-open status=" + str(d["status"]) + " probe=" + str("E2E INVOICE 997" in t)
_r += " detail=" + str(b.get("detail"))[:200]
assert d["status"] == 200 and "E2E INVOICE 997" in t, _r + " raw: " + str(d)[:800]
print(_r); RESULT = _r
'''


def build_harness_engines(scratch, cells_sel=None):
    """spike1's build_harness with OUR cells — monkeypatch spike1's module-level
    cells by calling its builder with an injected cells dict (we re-implement
    the small wrapper: build page html around the same srcdoc pattern)."""
    # simplest robust approach: reuse spike1.build_harness via a temporary
    # monkeypatch of its internals is fragile; instead replicate the page
    # assembly (it is stable) with our cells.
    owui = spike1.OWUI
    py = spike1_cells_python()
    cells = build_cells()
    if cells_sel:
        cells = {k: v for k, v in cells.items() if k in cells_sel}
    import base64 as _b64  # noqa: F401
    page = assemble_harness_page(owui, py, cells)
    p = scratch / "harness-eng.html"
    p.write_text(page)
    return p


def spike1_cells_python():
    """The python bootstrap (ofb_fetch etc.) — extract from spike1 by
    rebuilding its py string the same way (read from its source)."""
    src = (Path(__file__).parent / "spike1.py").read_text()
    start = src.index("    py = '''") + len("    py = '''")
    end = src.index("'''\n    cells = {", start)
    return src[start:end]


def assemble_harness_page(owui, py, cells):
    NL = chr(10)
    body_lines = [
        "<script>",
        "const _boot = async () => {",
        '  await import("' + owui + '/pyodide/pyodide.js");',
        "  const loadPyodide = globalThis.loadPyodide;",
        'const log = (...a) => parent.postMessage({harnessLog: a.map(String).join(" ")}, "*");',
        "const PYTHON = " + json.dumps(py) + ";",
        "const CELLS = " + json.dumps([cells[k] for k in sorted(cells)]) + ";",
        "(async () => {",
        "  try {",
        '    log("loading pyodide…");',
        '    const py = await loadPyodide({ indexURL: "' + owui + '/pyodide/" });',
        '    log("pyodide loaded v" + py.version);',
        "    await py.runPythonAsync(PYTHON);",
        '    log("bootstrap done");',
    ]
    for i in range(len(cells)):
        body_lines.append(
            '    await py.runPythonAsync(CELLS[%d]); log("CELL%d: " + py.globals.get("RESULT"));' % (i, i))
    body_lines += [
        '    log("ALL-SANDBOX-TESTS-DONE");',
        "  } catch (e) {",
        '    log("HARNESS-ERROR: " + String(e && e.message || e));',
        "  }",
        "})();",
        "};",
        "_boot();",
    ]
    body = NL.join(body_lines)
    page_lines = [
        "<!DOCTYPE html>",
        "<html>",
        '<head><meta charset="utf-8"><title>stage3 engines</title></head>',
        "<body>",
        '<pre id="log"></pre>',
        "<script>",
        'window.addEventListener("message", (ev) => {',
        "  const m = ev.data;",
        '  if (m && m.harnessLog) { document.getElementById("log").textContent += m.harnessLog + "\\\\n"; }',
        "}, false);",
        "</" + "script>",
        "<script>",
        'const SRCDOC = ' + json.dumps(body) + ' + "</" + "script>";',
        "const iframe = document.createElement('iframe');",
        "iframe.srcdoc = SRCDOC;",
        'iframe.setAttribute("sandbox", "allow-scripts");',
        'iframe.style.width = "1px"; iframe.style.height = "1px"; iframe.style.border = "0";',
        "document.body.appendChild(iframe);",
        "</" + "script>",
        "</body>",
        "</html>",
    ]
    return NL.join(page_lines) + NL


def run_cells(ctx, base, tag, harness_path, timeout=420):
    """Open harness, wait for done, print log. Returns (page, ok)."""
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    pg.goto(base + "/" + harness_path.name)
    deadline = time.time() + timeout
    text = ""
    while time.time() < deadline:
        try:
            text = pg.evaluate("document.getElementById('log').textContent")
        except Exception:
            text = ""
        if "ALL-SANDBOX-TESTS-DONE" in text or "HARNESS-ERROR" in text:
            break
        time.sleep(1)
    print(f"===== harness log ({tag}) =====")
    print(text.strip())
    if logs:
        keep = [l for l in logs if "favicon" not in l][-8:]
        print(f"----- console tail ({tag}) -----")
        for l in keep:
            print(" ", l)
    ok = "ALL-SANDBOX-TESTS-DONE" in text and "HARNESS-ERROR" not in text
    # count pass/fail cells
    npass = text.count("RESULT") if False else None
    return pg, ok


def main():
    prep_fixtures()
    from playwright.sync_api import sync_playwright

    SCRATCH.mkdir(parents=True, exist_ok=True)
    ext = spike1.build_test_extension(SCRATCH)
    spike1.ensure_bookmark()

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(SCRATCH))
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    print("harness server:", base)

    drv = spike1.XDriver()

    with sync_playwright() as p:
        profile = SCRATCH / "profile"
        if profile.exists():
            shutil.rmtree(profile)
        ctx = p.chromium.launch_persistent_context(
            str(profile),
            executable_path=spike1.CHROME,
            headless=False,
            args=[
                f"--disable-extensions-except={ext}",
                f"--load-extension={ext}",
                "--no-first-run", "--no-default-browser-check",
                "--window-size=1000,700",
                "--window-position=140,60",
            ],
            env={**os.environ, "DISPLAY": spike1.XDISPLAY},
            no_viewport=True,
        )

        # find ext origin (spike1 pattern)
        ext_origin = None
        deadline = time.time() + 15
        while time.time() < deadline and ext_origin is None:
            for worker in ctx.service_workers:
                if worker.url.startswith("chrome-extension://"):
                    ext_origin = "chrome-extension://" + worker.url.split("//")[1].split("/")[0]
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
            print("VERDICT: FAIL — no service worker")
            ctx.close()
            return 1
        print("SW up:", ext_origin)

        # grant via picker (spike1 main() pattern)
        setup = ctx.new_page()
        setup.goto(ext_origin + "/options.html")
        setup.wait_for_selector("#pick")
        time.sleep(0.5)
        before_ids = {w.id for w in drv.mapped_toplevels()}
        setup.click("#pick", timeout=5000)
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
            print("VERDICT: FAIL — picker did not open")
            ctx.close()
            return 1
        nroots = spike1.picker_flow(drv, setup, pick_win_id)
        print("roots:", nroots)
        if not nroots:
            print("VERDICT: FAIL — grant failed")
            ctx.close()
            return 1
        spike1.sec_configure(setup, base)  # sender gate: origin + test token

        # engine tab (holds grant + engines)
        eng = ctx.new_page()
        eng.goto(ext_origin + "/engine-host.html")
        eng.wait_for_timeout(4000)
        handlers = eng.evaluate("Object.keys(ENGINE_HANDLERS)")
        print("engine handlers:", handlers)
        if not any("pdf" in h for h in handlers):
            eng_txt = eng.evaluate("document.getElementById('log').textContent")
            print("engine page log:", eng_txt)
            print("VERDICT: FAIL — engines did not register")
            ctx.close()
            return 1

        # main cells
        harness = build_harness_engines(SCRATCH)
        pg, ok = run_cells(ctx, base, "main", harness)
        pg.close()

        # e12: engine tab closed -> 409  (auto-open OFF — the legacy contract)
        eng.evaluate("OFBIDB.put('kv', false, 'engine_auto_open')")
        eng.close()
        time.sleep(1.5)
        cells12 = {"e12_engine_closed": ENGINE_TAB_CLOSED_CELL.replace("{F}", FIXREL).replace("{{", "{").replace("}}", "}")}
        h12 = SCRATCH / "harness-e12.html"
        h12.write_text(assemble_harness_page(spike1.OWUI, spike1_cells_python(), cells12))
        pg12, ok12 = run_cells(ctx, base, "e12", h12, timeout=120)
        pg12.close()

        # e13: engine tab closed + auto-start ON (default) -> SW starts the
        # engines itself and the op succeeds (2026-09-07 toggle). Since ext
        # 3.0.3 the start is an OFFSCREEN document: assert NO engine-host
        # tab appears in the context (a tab means the offscreen path failed
        # and fell back — the test must tell us).
        cells13 = {"e13_auto_open": ENGINE_AUTO_OPEN_CELL.replace("{F}", FIXREL).replace("{{", "{").replace("}}", "}")}
        h13 = SCRATCH / "harness-e13.html"
        h13.write_text(assemble_harness_page(spike1.OWUI, spike1_cells_python(), cells13))
        # kv write needs an EXTENSION page context (options.html) — the
        # harness page runs on the OWUI origin and has no OFBIDB.
        opt = ctx.new_page()
        opt.goto(ext_origin + "/options.html")
        opt.wait_for_selector("#engauto")
        opt.evaluate("OFBIDB.put('kv', true, 'engine_auto_open')")
        opt.close()
        pg13, ok13 = run_cells(ctx, base, "e13", h13, timeout=180)
        pg13.close()
        host_tabs = [p.url for p in ctx.pages if "engine-host.html" in p.url]
        offscreen_ok = not host_tabs
        print("engine-host tabs after e13:", host_tabs or "none (offscreen path ✓)")

        ctx.close()

    # disk evidence
    print("\n== disk evidence ==")
    for name in [f"split-{RUN}.p1.pdf", f"merge-{RUN}.pdf", f"rot-{RUN}.pdf", f"searchable-{RUN}.pdf"]:
        f = FIX / name
        print(f"{name}: {'OK ' + str(f.stat().st_size) + 'B' if f.exists() else 'MISSING'}")

    verdict = "PASS" if (ok and ok12 and ok13 and offscreen_ok) else "FAIL"
    print(f"\nENGINES P3+P4 VERDICT: {verdict}" +
          ("" if offscreen_ok else " (engine started via TAB, not offscreen)"))
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
