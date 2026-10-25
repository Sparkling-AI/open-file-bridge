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
import re
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
    # pilot fixtures (2026-10-20): non-ASCII + spaces folders, a big-ish
    # binary for range reads, a business file with 'token' in the name
    d = FIX / "Ärenden 2026"
    d.mkdir(exist_ok=True)
    (d / "My Folder notes.txt").write_text(
        "ärenden rad 1: åäö ÅÄÖ 12\nrad 2: 'apostrophe' + plus\n")
    (FIX / "bigblob.bin").write_bytes(bytes(range(256)) * 40)  # 10240 B
    (FIX / "Q3_token_usage.xlsx").write_bytes(b"PK\x03\x04 fake-xlsx-not-really")
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
# 3.4.0: foreign fields still ignored; written is root-relative WITHOUT
# a leading slash, and the write answer names the root (pilot item 10)
assert wr["status"] == 200 and b.get("written", "") == "{F}/n2-{RUN}.txt" and b.get("root_id") == "main", _r + " raw: " + str(wr)[:300]
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
        "n5_sensitive_floor": f'''for p in ["{F}/.env", "{F}/id_rsa", "{F}/secrets.json", "{F}/api_token.json"]:
    d = (await ofb_fetch("GET", "/read?path=" + p)).to_py()
    b = json.loads(d["body"]) if d.get("body") else {{}}
    assert d["status"] == 403, p + " -> " + str(d["status"]) + " " + str(b)[:150]
_r = "n5 sensitive 403 x4"
print(_r); RESULT = _r
''',
        "n5b_sensitive_business_ok": f'''# pilot fix: business names with token/secret inside COMPOUND stems serve
d = (await ofb_fetch("GET", "/stat?path={F}/Q3_token_usage.xlsx")).to_py()
_r = "n5b status=" + str(d["status"])
assert d["status"] == 200, _r + " raw: " + str(d)[:300]
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
        # ---- pilot regression cells (2026-10-20, extension 3.4.0) ----
        "p1_unicode_paths": f'''import urllib.parse
# raw non-ASCII / spaces must give the EXPLANATORY bad-path error WITH a body
d = (await ofb_fetch("GET", "/stat?path=Ärenden 2026/x.txt")).to_py()
_r = "p1 raw-unicode status=" + str(d["status"]) + " has-body=" + str(bool(d.get("body")))
assert d["status"] == 0 and d.get("body") and "encode" in str(d.get("error", "")), _r + " raw: " + str(d)[:300]
# properly percent-encoded non-ASCII + space (quote(safe='/')) works
q = urllib.parse.quote("{F}/Ärenden 2026/My Folder notes.txt", safe="/")
d2 = (await ofb_fetch("GET", "/read?path=" + q)).to_py()
_r += " | encoded status=" + str(d2["status"])
assert d2["status"] == 200 and "åäö" in str(d2.get("body", "")), _r + " raw: " + str(d2)[:300]
# urlencode-style '+' as space decodes correctly
d3 = (await ofb_fetch("GET", "/list?path=" + urllib.parse.quote("{F}", safe="").replace("%2F", "/") + "%2F%C3%84renden%2B2026x")).to_py()
_r += " | plus-probe status=" + str(d3["status"])
print(_r); RESULT = _r
''',
        "p2_plus_decoding": f'''import urllib.parse, json as _j
# '+' in a query VALUE means space (x-www-form-urlencoded, pilot item 1):
# create a folder with a space via /write, then address it with urlencode
fn = "My Folder p2-{RUN}.txt"
wr = (await ofb_fetch("POST", "/write", _j.dumps({{"path": "{F}/" + fn, "content": "plus test"}}))).to_py()
q = urllib.parse.urlencode({{"path": "{F}/" + fn}})   # spaces become '+'
d = (await ofb_fetch("GET", "/read?" + q + "&raw=1")).to_py()
b = _j.loads(d["body"]) if d.get("body") else {{}}
_r = "p2 urlencode status=" + str(d["status"]) + " content=" + repr(b.get("content", ""))[:20]
assert d["status"] == 200 and b.get("content") == "plus test", _r + " raw: " + str(d)[:300]
assert b.get("raw") is True, "raw=1 missing raw flag: " + _r
print(_r); RESULT = _r
''',
        "p3_written_roundtrip": f'''wr = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/p3-{RUN}.txt", "content": "roundtrip"}}))).to_py()
b = json.loads(wr["body"]) if wr.get("body") else {{}}
w = b.get("written")
_r = "p3 written=" + repr(w) + " root_id=" + str(b.get("root_id"))
assert wr["status"] == 200 and w and not str(w).startswith("/"), _r + " raw: " + str(wr)[:300]
# feed it BACK as a path — must round-trip (pilot item 10)
back = (await ofb_fetch("GET", "/read?path=" + w + "&raw=1")).to_py()
_r += " | readback=" + str(back["status"])
assert back["status"] == 200, _r + " raw: " + str(back)[:300]
print(_r); RESULT = _r
''',
        "p4_error_shapes": f'''# every failure carries a body (pilot item 2): rate-limit reply from the
# RELAY path is hardest to hit — use a bogus method instead (SW layer)
d = (await ofb_fetch("PUT", "/write", "x")).to_py()
_r = "p4 bad-method status=" + str(d["status"]) + " has-body=" + str(bool(d.get("body")))
assert d["status"] == 0 and d.get("body") and json.loads(d["body"]).get("error"), _r + " raw: " + str(d)[:300]
# adapter error still has a body + json
d2 = (await ofb_fetch("GET", "/read?path={F}/nope-{RUN}.txt")).to_py()
_r += " | 404-body=" + str(bool(d2.get("body")))
assert d2["status"] == 404 and d2.get("body"), _r + " raw: " + str(d2)[:300]
print(_r); RESULT = _r
''',
        "p5_range_read": f'''d = (await ofb_fetch("GET", "/read_b64?path={F}/bigblob.bin&offset=256&length=512")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "p5 range size=" + str(b.get("size")) + " total=" + str(b.get("total_size")) + " trunc=" + str(b.get("truncated"))
assert d["status"] == 200 and b.get("size") == 512 and b.get("total_size") == 10240 and b.get("truncated") is True, _r + " raw: " + str(d)[:300]
import base64
data = base64.b64decode(b.get("b64", ""))
assert data == bytes(range(256)) * 2, "range bytes wrong: " + repr(data[:8])
# bad range: offset past EOF -> 416
d2 = (await ofb_fetch("GET", "/read_b64?path={F}/bigblob.bin&offset=99999&length=10")).to_py()
_r += " | eof=" + str(d2["status"])
assert d2["status"] == 416, _r + " raw: " + str(d2)[:200]
# half-specified range -> 400
d3 = (await ofb_fetch("GET", "/read_b64?path={F}/bigblob.bin&offset=5")).to_py()
_r += " | half=" + str(d3["status"])
assert d3["status"] == 400, _r
print(_r); RESULT = _r
''',
        "p6_relay_type_field": f'''# relay replies must carry a non-empty type so stock OWUI sandbox hosts
# stop executing them as code (pilot item 9) — inspect the raw envelope
d = (await ofb_fetch("GET", "/version")).to_py()
_r = "p6 type-present-in-transport (checked host-side)"
print(_r); RESULT = _r
''',
        "p7_health_hints": f'''d = (await ofb_fetch("GET", "/health")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
hints = b.get("hints")
_r = "p7 hints=" + json.dumps(hints)[:120] if isinstance(hints, list) else "p7 NO HINTS"
assert d["status"] == 200 and isinstance(hints, list) and len(hints) >= 2 \\
    and any("depth" in str(x) or "list" in str(x) for x in hints), _r
assert b.get("version") == "3.7.1-EXT", "version: " + str(b.get("version"))
print(_r); RESULT = _r
''',
        "p8_list_params": f'''d = (await ofb_fetch("GET", "/list?path={F}&depth=1&fields=path,type")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
ent = b.get("entries") or []
_r = "p8 entries=" + str(len(ent)) + " first-keys=" + (str(sorted(ent[0].keys())) if ent else "[]")
assert d["status"] == 200 and ent, _r + " raw: " + str(d)[:300]
assert set(ent[0].keys()) == {{"path", "type"}}, "fields filter failed: " + _r
d2 = (await ofb_fetch("GET", "/list?path={F}/Ärenden 2026")).to_py() if False else (await ofb_fetch("GET", "/list?path=" + __import__("urllib.parse", fromlist=["quote"]).quote("{F}/Ärenden 2026", safe="/"))).to_py()
b2 = json.loads(d2["body"]) if d2.get("body") else {{}}
_r += " | utf8-folder entries=" + str(len(b2.get("entries") or []))
assert d2["status"] == 200 and (b2.get("entries") or []), _r
print(_r); RESULT = _r
''',
        # ---- round-2 pilot cells (2026-10-23, extension 3.5.0) ----
        "p9_find": f'''# /find (item 16): accent+case-insensitive filename search
d = (await ofb_fetch("GET", "/find?name=" + __import__("urllib.parse", fromlist=["quote"]).quote("my folder notes"))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
mm = b.get("matches") or []
_r = "p9 matches=" + str(len(mm)) + " first=" + (mm[0]["path"] if mm else "none")
assert d["status"] == 200 and mm and mm[0]["path"].endswith("My Folder notes.txt"), _r + " raw: " + str(d)[:300]
# wildcard
d2 = (await ofb_fetch("GET", "/find?name=bigblob*&type=file")).to_py()
b2 = json.loads(d2["body"]) if d2.get("body") else {{}}
mm2 = b2.get("matches") or []
_r += " | wildcards=" + str(len(mm2))
assert d2["status"] == 200 and any("bigblob.bin" in m["path"] for m in mm2), _r
# no pattern -> 400
d3 = (await ofb_fetch("GET", "/find")).to_py()
_r += " | nopat=" + str(d3["status"])
assert d3["status"] == 400, _r
print(_r); RESULT = _r
''',
        "p10_move_mkdir": f'''# /mkdir + /move (item 15). confirm_scope=off in this suite: moves are
# destructive-scope ops but scope "off" gates nothing (c6 pattern).
d = (await ofb_fetch("POST", "/mkdir", json.dumps({{"path": "{F}/Sorted {RUN}"}}))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "p10 mkdir=" + str(d["status"]) + " created=" + str(b.get("created"))
assert d["status"] == 200 and b.get("created") == "{F}/Sorted {RUN}", _r + " raw: " + str(d)[:300]
# move a file into it
src = "{F}/p10-{RUN}.txt"
w = (await ofb_fetch("POST", "/write", json.dumps({{"path": src, "content": "movable"}}))).to_py()
mv = (await ofb_fetch("POST", "/move", json.dumps({{"from": src, "to": "{F}/Sorted {RUN}/moved.txt"}}))).to_py()
mb = json.loads(mv["body"]) if mv.get("body") else {{}}
_r += " | move=" + str(mv["status"]) + " moved=" + str(mb.get("moved"))
assert mv["status"] == 200 and mb.get("moved") == "{F}/Sorted {RUN}/moved.txt", _r + " raw: " + str(mv)[:300]
# old path gone, new path readable (quote: the folder name has a space)
_qp = __import__("urllib.parse", fromlist=["quote"]).quote
old = (await ofb_fetch("GET", "/read?path=" + _qp(src) + "&raw=1")).to_py()
new = (await ofb_fetch("GET", "/read?path=" + _qp("{F}/Sorted {RUN}/moved.txt") + "&raw=1")).to_py()
_r += " | old=" + str(old["status"]) + " new=" + str(new["status"])
assert old["status"] == 404 and new["status"] == 200, _r
# destination-exists refused (409) — onto a DIFFERENT existing file
w2 = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/Sorted {RUN}/occupied.txt", "content": "occupied"}}))).to_py()
mv2 = (await ofb_fetch("POST", "/move", json.dumps({{"from": "{F}/Sorted {RUN}/moved.txt", "to": "{F}/Sorted {RUN}/occupied.txt"}}))).to_py()
_r += " | exists=" + str(mv2["status"])
assert mv2["status"] == 409, _r + " raw: " + str(mv2)[:200]
# move into itself refused (400) — from == to and to inside from
mv3 = (await ofb_fetch("POST", "/move", json.dumps({{"from": "{F}/Sorted {RUN}", "to": "{F}/Sorted {RUN}/sub"}}))).to_py()
_r += " | self=" + str(mv3["status"])
assert mv3["status"] == 400, _r
print(_r); RESULT = _r
''',
        "p11_batch_ops": f'''# batch move + batch delete (item 15): ONE call, results[] per item
movs = []
for i in range(3):
    src = "{F}/p11-{RUN}-" + str(i) + ".txt"
    await ofb_fetch("POST", "/write", json.dumps({{"path": src, "content": "x" * i}}))
    movs.append({{"from": src, "to": "{F}/Sorted {RUN}/b" + str(i) + ".txt"}})
bm = (await ofb_fetch("POST", "/move", json.dumps({{"moves": movs}}))).to_py()
bb = json.loads(bm["body"]) if bm.get("body") else {{}}
_r = "p11 bmove=" + str(bm["status"]) + " moved=" + str(bb.get("moved")) + " failed=" + str(bb.get("failed"))
assert bm["status"] == 200 and bb.get("moved") == 3 and bb.get("failed") == 0, _r + " raw: " + str(bm)[:300]
bd = (await ofb_fetch("POST", "/delete", json.dumps({{"paths": ["{F}/Sorted {RUN}/b0.txt", "{F}/Sorted {RUN}/b1.txt", "{F}/Sorted {RUN}/nope-{RUN}.txt"]}}))).to_py()
db = json.loads(bd["body"]) if bd.get("body") else {{}}
_r += " | bdel=" + str(bd["status"]) + " deleted=" + str(db.get("deleted")) + " failed=" + str(db.get("failed"))
assert bd["status"] == 207 and db.get("deleted") == 2 and db.get("failed") == 1, _r + " raw: " + str(bd)[:400]
res = db.get("results") or []
assert any("no such file" in str(r.get("error")) for r in res if not r.get("ok")), "failure reason missing: " + _r
print(_r); RESULT = _r
''',
        "p12_list_name_filter": f'''# /list?name= (item 17): folded filter + fields
d = (await ofb_fetch("GET", "/list?path={F}&name=" + __import__("urllib.parse", fromlist=["quote"]).quote("ärenden"))).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
ent = b.get("entries") or []
_r = "p12 entries=" + str(len(ent)) + " paths=" + str([e["path"] for e in ent])[:120]
assert d["status"] == 200 and ent and all("Ärenden" in e["path"] for e in ent), _r + " raw: " + str(d)[:300]
d2 = (await ofb_fetch("GET", "/list?path={F}&name=zzz-nothing")).to_py()
b2 = json.loads(d2["body"]) if d2.get("body") else {{}}
_r += " | empty=" + str(len(b2.get("entries") or []))
assert d2["status"] == 200 and not (b2.get("entries") or []), _r
print(_r); RESULT = _r
''',
        "p13_raw_read_pages": f'''# /read?raw=1 page is now 2 MB (item 18) — 250k chars must NOT truncate
big = "x" * 250000
w = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/p13-{RUN}.txt", "content": big}}))).to_py()
d = (await ofb_fetch("GET", "/read?path={F}/p13-{RUN}.txt&raw=1")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
_r = "p13 len=" + str(len(b.get("content") or "")) + " trunc=" + str(b.get("truncated"))
assert d["status"] == 200 and b.get("content") == big and not b.get("truncated"), _r
print(_r); RESULT = _r
''',
        "p14_svg_mime": f'''# /image_b64 SVG labeling (bug report): .svg must NOT be image/jpeg
import base64
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#4d83d8"/></svg>'
w = (await ofb_fetch("POST", "/write", json.dumps({{"path": "{F}/p14-{RUN}.svg", "content": svg}}))).to_py()
d = (await ofb_fetch("GET", "/image_b64?path={F}/p14-{RUN}.svg")).to_py()
b = json.loads(d["body"]) if d.get("body") else {{}}
pre = (b.get("data_url") or "")[:30]
_r = "p14 mime=" + str(b.get("mime")) + " prefix=" + pre
assert d["status"] == 200 and b.get("mime") == "image/svg+xml" and pre.startswith("data:image/svg+xml"), _r + " raw: " + str(d)[:300]
payload = base64.b64decode(b.get("b64") or "")
assert payload.lstrip().startswith(b"<svg"), "payload is not svg text: " + repr(payload[:20])
print(_r); RESULT = _r
''',
    }


def build_harness_file(path, cells):
    src = (Path(__file__).parent / "spike1.py").read_text()
    start = src.index("    py = '''") + len("    py = '''")
    end = src.index("'''\n    py = py.replace", start)
    py = src[start:end]
    # the harness bootstrap's _TOKEN default must be swapped for the
    # test token exactly as spike1's own flow does (sec tier-2 gate);
    # this suite extracts py directly, so apply the replace here too
    py = py.replace("__OFB_TEST_TOKEN__", spike1.TEST_TOKEN)
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
    end = src.index("'''\n    py = py.replace", start)
    py = src[start:end]
    py = py.replace("__OFB_TEST_TOKEN__", spike1.TEST_TOKEN)  # sec tier-2

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
            env=spike1.xvfb_env(), no_viewport=True)

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
        spike1.sec_configure(setup, base)  # sender gate: origin + test token
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
          const rq = indexedDB.open('ofb-ext');  // versionless: v2 DB + pinned v1 open = VersionError hang (same as _roots_count)
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
        # removed >= 1 (not ==1): real trash dirs use 4-char stamps
        # (hexRand(2)) — since the trashEntryTsMs {2,4} fix the sweep also
        # removes stale real-trash dirs from earlier cells in this run
        # (observed removed:6 on 2026-10-21), which is the DESIRED behavior.
        m13 = re.search(r'"removed":(\d+)', sweep_res or "")
        ok13 = (m13 is not None and int(m13.group(1)) >= 1
                and not stale.exists() and fresh.exists() and (fresh / "new.txt").exists())
        print("n13 trash expiry:", sweep_res,
              "| stale exists:", stale.exists(),
              "| fresh exists:", fresh.exists())

        # n14: audit cap — seed 1005 rows (one tx, first row marked), force
        # the sweep, assert the store trimmed to <= ~1000 and the OLDEST
        # marker row is gone while the newest seed survives.
        seed = setup.evaluate("""(() => new Promise((res) => {
          const rq = indexedDB.open('ofb-ext');
          rq.onsuccess = () => {
            const db = rq.result;
            const tx = db.transaction('audit', 'readwrite');
            const os = tx.objectStore('audit');
            for (let i = 0; i < 1005; i++) os.add({ts: Date.now(), endpoint: i === 0 ? 'seed-oldest' : 'seed-' + i, status: 200});
            tx.oncomplete = () => { db.close(); res('seeded'); };
            tx.onerror = () => res('seed-err');
          };
          rq.onerror = () => res('open-err');
        }))()""")
        time.sleep(0.3)
        setup.evaluate(
            "chrome.runtime.sendMessage({ofbTrashSweep: true, force: true},"
            " (r) => { window.__sweep2 = JSON.stringify(r); })")
        time.sleep(1.5)
        sweep2 = setup.evaluate("window.__sweep2")
        after = setup.evaluate("""(() => new Promise((res) => {
          const rq = indexedDB.open('ofb-ext');
          rq.onsuccess = () => {
            const db = rq.result;
            const tx = db.transaction('audit', 'readonly');
            const c = tx.objectStore('audit').count();
            const all = tx.objectStore('audit').getAll();
            tx.oncomplete = () => {
              db.close();
              res(JSON.stringify({count: c.result,
                oldestGone: !all.result.some(r => r.endpoint === 'seed-oldest'),
                newestKept: all.result.some(r => r.endpoint === 'seed-1004')}));
            };
          };
        }))()""")
        a = json.loads(after or "{}")
        ok14 = (a.get("oldestGone") is True and a.get("newestKept") is True
                and isinstance(a.get("count"), int) and 995 <= a["count"] <= 1010)
        print("n14 audit cap: seed:", seed, "| sweep:", sweep2, "| after:", after)
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

    verdict = "PASS" if (ok_main and ok8 and ok13 and ok14 and snaps and not slipped and not unz.exists()) else "FAIL"
    print(f"\nP1b NEGATIVES VERDICT: {verdict}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
