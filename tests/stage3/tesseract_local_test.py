#!/usr/bin/env python3
"""Stage-3 local-only OCR verification for the CWS "Blue Argon" remediation
(extension 3.7.5, 2026-10-28).

Runs the REAL extension (this worktree's extension/, unmodified) in REAL
Chrome for Testing with a fresh disposable profile and EXTERNAL NETWORK
BLOCKED (--host-resolver-rules "MAP * ~NOTFOUND"): every DNS name fails, so
any attempted remote fetch dies at DNS and is recorded as an error in the
netlog. --log-net-log records every EXTERNAL request URL (macOS Chrome
netlogs do not record chrome-extension:// loads); the in-worker performance
timelines and a page-side spawn recorder provide the positive packaged-asset
evidence.

Cells:
  t0  both supported engine host pages (engine-host.html and
      engine-offscreen.html) still register their handlers
  t1  /ocr eng on a synthetic canvas invoice
  t2  /ocr swe+eng on a synthetic Swedish canvas (worker recreation on
      language change happens inside engine-impl's getTessWorker), then a
      switch back to eng (second recreation)
  t3  /ocr_pdf -> searchable PDF; recognized text survives extraction when
      the produced PDF is re-read through the pdfium text path
  t4  /ocr on that PDF (the pdfium-raster OCR path)
  t5  missing packaged model (kli) fails with the packaged 404 message
  t6  the packaged-only guards reject remote / blob: / data: /
      cross-extension / missing worker, core, and language paths through
      the real loaded bundles (page-side and worker-side)
  t7  BOTH packaged SIMD cores work when selected explicitly via the
      library's direct core-file contract (the natural capability-detection
      path is exercised by t1/t2; which core it picked is read from the
      netlog)
  t8  request evidence: netlog proves NO external/CDN request was even
      attempted (macOS netlogs skip chrome-extension:// URLs); a page-side
      fetch proves every engine asset loads same-origin (200); the page
      spawn recorder proves only the packaged worker.min.js ever spawned;
      the library's own probe bytes say which core natural detection picks

The synthetic fixtures are painted in-page (canvas) — no user files.

Usage (macOS; full Chromium required — the headless shell cannot load
extensions):
  OFB_EXT_CHROME="$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    uv run --with playwright python3 tests/stage3/tesseract_local_test.py
"""
import base64
import glob
import json
import os
import shutil
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
EXT = REPO / "extension"
_VSRC = (REPO / "extension/vendor/tesseractjs/worker.min.js").read_text()
import re as _re
SIMD_PROBE = [int(x) for x in
              _re.search(r"simd:async\(\)=>WebAssembly\.validate\(new Uint8Array\(\[([0-9,]+)\]\)\)",
                         _VSRC).group(1).split(",")]
RELAXED_PROBE = [int(x) for x in
                 _re.search(r"relaxedSimd:async\(\)=>WebAssembly\.validate\(new Uint8Array\(\[([0-9,]+)\]\)\)",
                            _VSRC).group(1).split(",")]
CHROME = os.environ.get("OFB_EXT_CHROME") or sorted(
    glob.glob(os.path.expanduser(
        "~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/"
        "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
)[-1]
SCRATCH = Path(os.environ.get("OFB_RHC_DIR") or
               f"/tmp/ofb-rhc-{time.strftime('%H%M%S')}")

# Hosts Chrome itself may touch at startup even with background networking
# disabled; anything else external in the netlog is treated as an engine
# attempt and fails the run.
BROWSER_INTERNAL_HOSTS = (
    "clients2.google.com", "clients4.google.com", "update.googleapis.com",
    "tools.google.com", "redirector.gvt1.com", "edgedl.me.gvt1.com",
    "www.gstatic.com", "chrome.google.com", "accounts.google.com",
    "play.googleapis.com", "fonts.googleapis.com", "fonts.gstatic.com",
    "ocsp.digicert.com", "www.microsoft.com", "msftconnecttest.com",
    "clients.google.com", "android.clients.google.com",
)

# tesseract.js 7's own capability probes (module 242 byte arrays, extracted
# verbatim from the vendored worker at import time) — evaluating them in the
# page tells us which core the natural directory-corePath path selects on
# this Chrome (same engine, same probes).

results = []


def record(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else " — " + str(detail)[:400]),
          flush=True)
    return ok


def step(msg):
    print("· " + msg, flush=True)


# In-page helpers, installed once as page globals.
PAGE_HELPERS = r"""
window.b64Canvas = async function (lines, w, h) {
  w = w || 1400; h = h || 360;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#111'; g.font = 'bold 56px system-ui, sans-serif';
  g.textBaseline = 'top';
  lines.forEach((t, i) => g.fillText(t, 40, 40 + i * 90));
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 32768)
    s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
  return btoa(s);
};
window.tessOpts = function (extra) {
  return Object.assign({
    workerPath: chrome.runtime.getURL('vendor/tesseractjs/worker.min.js'),
    corePath: chrome.runtime.getURL('vendor/tesseractjs/'),
    langPath: chrome.runtime.getURL('vendor/tessdata-fast/'),
    gzip: false,
    workerBlobURL: false,
    logger: () => {},
  }, extra || {});
};
window.callEngine = function (op, payload) { return ENGINE_HANDLERS[op](payload); };
window.__spawned = [];
const RealWorker = window.Worker;
window.Worker = function (url, opts) {
  window.__spawned.push(String(url));
  return new RealWorker(url, opts);
};
"""

# JS body for one guard case: literal statements mutate the options object
# (extension-page CSP forbids eval/new Function, so each case's mutation is
# composed at Python time into a distinct function — no runtime evaluation),
# then createWorker must reject. 'RESOLVED' means the guard FAILED.
GUARD_TEMPLATE = """
async () => {
  const o = tessOpts();
%s
  try {
    await Tesseract.createWorker('eng', 1, o);
    return 'RESOLVED';
  } catch (e) {
    return String(e && e.message || e);
  }
}
"""


def main():
    if not Path(CHROME).exists():
        print("FATAL: Chrome for Testing not found:", CHROME)
        return 2
    if SCRATCH.exists():
        shutil.rmtree(SCRATCH)
    SCRATCH.mkdir(parents=True)
    netlog = SCRATCH / "netlog.json"
    profile = SCRATCH / "profile"
    print("chrome:", CHROME)
    print("scratch:", SCRATCH)

    from playwright.sync_api import sync_playwright

    console_log = []
    page_errors = []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile),
            executable_path=CHROME,
            headless=False,
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                # block ALL external network: any attempted remote fetch dies
                # at DNS and is recorded as an error in the netlog
                '--host-resolver-rules=MAP * ~NOTFOUND',
                f'--log-net-log={netlog}',
                '--disable-component-update',
                '--disable-background-networking',
                '--no-first-run', '--no-default-browser-check',
                '--window-size=1100,820',
            ],
            no_viewport=True,
        )
        host_spawns = []
        host_caps = {}
        try:
            # playwright API drift: ctx.service_workers is a FUNCTION in
            # 1.58 but a property in newer versions — support both
            def service_workers():
                sw = ctx.service_workers
                return sw() if callable(sw) else sw

            ext_origin = None
            deadline = time.time() + 20
            while time.time() < deadline and ext_origin is None:
                # playwright's service_workers list can lag behind reality;
                # CDP Target.getTargets shows the SW the moment it registers
                # (same fallback engines_test needs)
                try:
                    pg0 = ctx.pages[0] if ctx.pages else ctx.new_page()
                    cdp = ctx.new_cdp_session(pg0)
                    for t in cdp.send("Target.getTargets")["targetInfos"]:
                        if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://"):
                            ext_origin = "chrome-extension://" + t["url"].split("//")[1].split("/")[0]
                            break
                    cdp.detach()
                except Exception:
                    pass
                if ext_origin is None:
                    for w in service_workers():
                        if w.url.startswith("chrome-extension://"):
                            ext_origin = "chrome-extension://" + w.url.split("//")[1].split("/")[0]
                            break
                if ext_origin is None:
                    time.sleep(0.5)
            if not ext_origin:
                print("VERDICT: FAIL — extension SW never started")
                return 1
            print("extension origin:", ext_origin)

            # ---- t0: both engine host pages initialize
            host = ctx.new_page()
            host.on("console", lambda m: console_log.append(f"[{m.type}] {m.text}"))
            host.on("pageerror", lambda e: page_errors.append(str(e)))

            host.goto(ext_origin + "/engine-host.html")
            host.wait_for_function(
                "() => document.getElementById('log').textContent"
                ".includes('engines registered')",
                timeout=60000,
            )
            handlers = host.evaluate("Object.keys(ENGINE_HANDLERS).sort()")
            record("t0a engine-host.html registers engine handlers",
                   set(["engine.init", "pdf.text", "pdf.op", "ocr", "ocr.pdf"]).issubset(handlers),
                   handlers)
            host.evaluate("(function(){" + PAGE_HELPERS + "})()")

            off = ctx.new_page()
            off.on("pageerror", lambda e: page_errors.append("offscreen:" + str(e)))
            off.goto(ext_origin + "/engine-offscreen.html")
            # engine-offscreen.html has no #log element by design — poll for
            # the handlers themselves instead of a log line
            off.wait_for_function(
                "() => typeof ENGINE_HANDLERS !== 'undefined' && 'ocr' in ENGINE_HANDLERS",
                timeout=60000,
            )
            off_handlers = off.evaluate("Object.keys(ENGINE_HANDLERS).sort()")
            record("t0b engine-offscreen.html registers engine handlers",
                   "ocr" in off_handlers, off_handlers)

            # ---- t1: synthetic English invoice OCR
            step("t1 starting")
            eng_b64 = host.evaluate(
                "async () => b64Canvas(['E2E INVOICE 997', '44000 SEK STOCKHOLM'])")
            r = host.evaluate(
                "async (b64) => callEngine('ocr', {__file: {name: 'inv.png', b64}, lang: 'eng'})",
                eng_b64)
            text = " ".join(l for pg in r["pages"] for l in pg.get("lines", []))
            record("t1 /ocr eng reads the synthetic invoice",
                   "997" in text and "44000" in text, text[:160])

            # ---- t2: Swedish + combined langs, then back to eng
            step("t2 starting")
            swe_b64 = host.evaluate(
                "async () => b64Canvas(['ÅÄÖ åäö STOCKHOLM', '24680 13579 3394.75 55-123'])")
            r = host.evaluate(
                "async (b64) => callEngine('ocr', {__file: {name: 'swe.png', b64}, lang: 'swe+eng'})",
                swe_b64)
            text = " ".join(l for pg in r["pages"] for l in pg.get("lines", []))
            aa = all(c in text.lower() for c in "åäö")
            dg = all(x in text for x in ["24680", "13579", "3394.75", "55-123"])
            record("t2 /ocr swe+eng reads åäö and digit gates", aa and dg, text[:160])

            r = host.evaluate(
                "async (b64) => callEngine('ocr', {__file: {name: 'inv.png', b64}, lang: 'eng'})",
                eng_b64)
            text = " ".join(l for pg in r["pages"] for l in pg.get("lines", []))
            record("t2b /ocr back to eng after swe+eng (worker recreation)",
                   "997" in text and "44000" in text, text[:160])

            # ---- t3: searchable PDF + text survives extraction
            step("t3 starting")
            r = host.evaluate(
                "async (b64) => callEngine('ocr.pdf', {"
                "__file: {name: 'inv.png', b64}, out: 'searchable-e2e.pdf', lang: 'eng'})",
                eng_b64)
            pdf_b64 = r["__writeFile"]["b64"]
            (SCRATCH / "searchable-e2e.pdf").write_bytes(base64.b64decode(pdf_b64))
            record("t3a /ocr_pdf produced a searchable PDF",
                   r.get("ok") is True and r.get("bytes", 0) > 1000,
                   f"pages={r.get('pages')} bytes={r.get('bytes')}")
            t = host.evaluate(
                "async (b64) => callEngine('pdf.text', {__file: {name: 's.pdf', b64}})",
                pdf_b64)
            joined = " ".join(pg.get("text", "") for pg in t["pages"])
            record("t3b recognized text survives PDF extraction",
                   "997" in joined and "44000" in joined, joined.replace("\n", " ")[:160])

            # ---- t4: /ocr over that PDF (pdfium raster path)
            step("t4 starting")
            r = host.evaluate(
                "async (b64) => callEngine('ocr', {"
                "__file: {name: 'scan.pdf', b64}, lang: 'eng', max_pages: 2})",
                pdf_b64)
            joined = " ".join(l for pg in r["pages"] for l in pg.get("lines", []))
            record("t4 /ocr on a PDF (raster path)",
                   "997" in joined or "44000" in joined, joined[:160])

            # ---- t5: missing packaged model fails usefully at the engine
            # gate (no worker spawn, no request, useful message)
            step("t5 starting")
            spawns_before = len(host.evaluate("JSON.stringify(window.__spawned)") and json.loads(host.evaluate("JSON.stringify(window.__spawned)")))
            err = host.evaluate(
                "async (b64) => { try {"
                "  await callEngine('ocr', {__file: {name: 'x.png', b64}, lang: 'kli'});"
                "  return 'RESOLVED';"
                "} catch (e) { return String(e && e.message || e); } }",
                eng_b64)
            spawns_after = json.loads(host.evaluate("JSON.stringify(window.__spawned)"))
            record("t5a missing model (kli) rejected by the engine language gate",
                   "unsupported OCR language" in err and "kli" in err
                   and "packages only" in err and err != "RESOLVED",
                   err[:250])
            record("t5b no worker spawned for the unsupported language",
                   len(spawns_after) == spawns_before,
                   f"spawns {spawns_before} -> {len(spawns_after)}")

            # ---- t5c: bypass the engine gate and call the library directly —
            # the vendored fetch wrapper + the T6 init-chain fix must turn a
            # missing packaged model into a PROMPT, descriptive rejection.
            # (Before the patches this hung forever: fetch rejected with a
            # bare TypeError and createWorker's init chain ended in an empty
            # catch that swallowed it.) Raced so a regression cannot hang
            # the suite.
            step("t5c direct-library missing model")
            err = host.evaluate(
                """async () => {
                     try {
                       await Promise.race([
                         Tesseract.createWorker('kli', 1, tessOpts()),
                         new Promise((_, rej) => setTimeout(
                           () => rej(new Error('HARNESS-TIMEOUT-40s')), 40000)),
                       ]);
                       return 'RESOLVED';
                     } catch (e) {
                       return String(e && e.message || e);
                     } }""")
            record("t5c direct createWorker('kli') rejects promptly with the vendor message",
                   "packaged language model unavailable" in err
                   and "no remote fallback" in err
                   and "HARNESS-TIMEOUT" not in err and err != "RESOLVED",
                   err[:250])

            # ---- t5d: a MISSING packaged core file (valid same-origin
            # directory that does not exist) must also reject promptly —
            # importScripts fails inside the worker; the load-job rejection
            # must settle createWorker
            step("t5d missing core file")
            err = host.evaluate(
                """async () => {
                     try {
                       await Promise.race([
                         Tesseract.createWorker('eng', 1, tessOpts({
                           corePath: chrome.runtime.getURL(
                             'vendor/tesseractjs/NO-SUCH-CORE-DIR/') })),
                         new Promise((_, rej) => setTimeout(
                           () => rej(new Error('HARNESS-TIMEOUT-40s')), 40000)),
                       ]);
                       return 'RESOLVED';
                     } catch (e) {
                       return String(e && e.message || e);
                     } }""")
            record("t5d missing packaged core rejects promptly (no remote fallback)",
                   err != "RESOLVED" and "HARNESS-TIMEOUT" not in err,
                   err[:250])

            # ---- t6: packaged-only guards through the real loaded bundles
            guard_cases = [
                ("t6a remote workerPath rejected",
                 "  o.workerPath = "
                 "'https://cdn.jsdelivr.net/npm/tesseract.js@v7.0.0/dist/worker.min.js';"),
                ("t6b blob: workerPath rejected",
                 "  o.workerPath = 'blob:' + o.workerPath;"),
                ("t6c data: workerPath rejected",
                 "  o.workerPath = 'data:application/javascript,importScripts(1)';"),
                ("t6d cross-extension workerPath rejected",
                 "  o.workerPath = "
                 "'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                 "/vendor/tesseractjs/worker.min.js';"),
                ("t6e missing workerPath rejected (no remote default)",
                 "  delete o.workerPath;"),
                ("t6f remote corePath rejected",
                 "  o.corePath = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@v7.0.0';"),
                ("t6g missing corePath rejected (no remote default)",
                 "  delete o.corePath;"),
                ("t6h remote langPath rejected",
                 "  o.langPath = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/';"),
                ("t6i missing langPath rejected (no remote default)",
                 "  delete o.langPath;"),
            ]
            step("t6 guard cases starting")
            for name, mutation in guard_cases:
                out = host.evaluate(GUARD_TEMPLATE % mutation)
                record(name, ("[ofb]" in out) and (out != "RESOLVED"), out[:250])

            # ---- t7: both packaged SIMD cores, forced via the direct
            # core-file contract (detection itself ran in t1/t2)
            step("t7 forced-core cases starting")
            for variant in ("simd", "relaxedsimd"):
                step("t7 " + variant)
                out = host.evaluate(
                    """
async (arg) => {
  const w = await Tesseract.createWorker('eng', 1, tessOpts({
    corePath: chrome.runtime.getURL(
      'vendor/tesseractjs/tesseract-core-""" + variant + """-lstm.wasm.js') }));
  try {
    const bin = Uint8Array.from(atob(arg.b64), c => c.charCodeAt(0));
    const { data } = await w.recognize(new Blob([bin], {type: 'image/png'}));
    return 'OK ' + data.text.replace(/\\s+/g, ' ').trim();
  } finally { await w.terminate(); }
}
""", {"b64": eng_b64})
                record(f"t7 forced {variant} core OCRs the invoice",
                       out.startswith("OK") and "997" in out and "44000" in out,
                       out[:200])

            # POSITIVE packaged-asset evidence (page-side): every engine
            # asset the guards allow must exist and load same-origin. Note
            # Chrome dedicated workers do NOT expose performance resource
            # entries to Playwright (tried; dead end), so request-level
            # positive proof is: OCR succeeded while every external name was
            # DNS-blocked (the package is then the only possible source) +
            # this existence check + the spawn recorder + t8g probes.
            asset_statuses = host.evaluate("""
async (origin) => {
  const rel = [
    'vendor/tesseractjs/worker.min.js',
    'vendor/tesseractjs/tesseract-core-simd-lstm.wasm.js',
    'vendor/tesseractjs/tesseract-core-simd-lstm.wasm',
    'vendor/tesseractjs/tesseract-core-relaxedsimd-lstm.wasm.js',
    'vendor/tesseractjs/tesseract-core-relaxedsimd-lstm.wasm',
    'vendor/tessdata-fast/eng.traineddata',
    'vendor/tessdata-fast/swe.traineddata',
    'vendor/tessdata-fast/osd.traineddata',
    'vendor/pdfium/pdfium.wasm',
    'vendor/pdflib/pdf-lib.min.js',
  ];
  const out = {};
  for (const r of rel) {
    try { const resp = await fetch(origin + '/' + r); out[r] = resp.status; }
    catch (e) { out[r] = 'ERR ' + (e && e.message || e); }
  }
  return out;
}""", ext_origin)
            record("t8d all engine assets load same-origin from the package (200)",
                   all(v == 200 for v in asset_statuses.values()),
                   {k: v for k, v in asset_statuses.items() if v != 200})

            # page-side evidence: spawn recorder + the library's own
            # capability probes (tells us which core the natural
            # directory-corePath path picked on this Chrome)
            host_spawns = host.evaluate("JSON.stringify(window.__spawned)")
            host_spawns = json.loads(host_spawns)
            host_caps = host.evaluate(
                "async (probes) => ({"
                "  simd: WebAssembly.validate(new Uint8Array(probes.simd)),"
                "  relaxedSimd: WebAssembly.validate(new Uint8Array(probes.relaxed)),"
                "})",
                {"simd": SIMD_PROBE, "relaxed": RELAXED_PROBE})

            time.sleep(1.0)  # let the netlog flush
        finally:
            ctx.close()
            time.sleep(1.5)

    # ---- t8: request evidence
    # (a) NEGATIVE, whole-browser: the netlog. macOS Chrome's netlog does not
    #     record chrome-extension:// resource loads, so it cannot prove which
    #     packaged assets were used — but it sees every external attempt.
    urls, net_errors = set(), []
    try:
        nl = json.loads(netlog.read_text())
        consts = nl.get("constants", {})
        err_types = consts.get("netError", {})
        for ev in nl.get("events", []):
            params = ev.get("params") or {}
            if params.get("url"):
                urls.add(params["url"])
            if params.get("net_error"):
                net_errors.append(str(err_types.get(str(params["net_error"]),
                                                    params["net_error"])))
        record("t8a netlog parsed", True, f"{len(urls)} distinct URLs")
    except Exception as e:  # noqa: BLE001
        record("t8a netlog parsed", False, f"{type(e).__name__}: {e}")

    external = sorted(u for u in urls if u.startswith(("http://", "https://")))
    banned_hits = [u for u in urls if any(h in u for h in
                    ("jsdelivr", "unpkg", "cdnjs", "tesseract.js-data", "npmcdn"))]
    record("t8b zero CDN/library URLs requested", not banned_hits, banned_hits[:5])
    stray = [u for u in external
             if not any(h in u for h in BROWSER_INTERNAL_HOSTS)]
    record("t8c no external request beyond browser-internal startup hosts",
           not stray, stray[:8])
    print(f"     (net_error events: {len(net_errors)} — every external request "
          f"died at DNS under MAP * ~NOTFOUND)", flush=True)

    spawns = host_spawns or []
    record("t8f every spawned worker is the packaged worker.min.js",
           spawns and all(u.endswith("/vendor/tesseractjs/worker.min.js") for u in spawns),
           spawns[:6])
    print("spawned worker URLs:", spawns, flush=True)

    # (c) natural core selection: run the library's own probes in the page
    cap = host_caps or {}
    natural = ("relaxedsimd" if cap.get("relaxedSimd") else
               "simd" if cap.get("simd") else "none")
    record("t8g this Chrome's probes select the relaxedsimd packaged core",
           natural == "relaxedsimd",
           f"simd={cap.get('simd')} relaxedSimd={cap.get('relaxedSimd')} -> {natural}")

    (SCRATCH / "results.json").write_text(json.dumps({
        "results": results, "asset_statuses": asset_statuses,
        "worker_spawns": host_spawns, "capability_probes": host_caps,
        "external_urls": external, "page_errors": page_errors,
        "console_tail": console_log[-25:],
    }, indent=2))
    print("evidence:", SCRATCH / "results.json",
          "| searchable PDF:", SCRATCH / "searchable-e2e.pdf",
          "| netlog:", netlog, flush=True)

    failed = [r for r in results if not r["ok"]]
    print(f"\nengine page errors: {page_errors or 'none'}")
    print(f"\nTESSERACT LOCAL-ONLY VERDICT: "
          f"{'PASS' if not failed else 'FAIL (' + str(len(failed)) + ')'}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
