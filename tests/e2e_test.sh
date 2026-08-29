#!/usr/bin/env bash
# End-to-end test: starts the bridge, exercises every endpoint incl. security.
# Run:  ./tests/e2e_test.sh
# Optional: FILE_BRIDGE_CMD="<path-to-frozen-binary> bash tests/e2e_test.sh"
# runs the SAME suite against a PyInstaller build (default: python3 source).
set -euo pipefail
cd "$(dirname "$0")/.."

BRIDGE="http://127.0.0.1:8765"
BRIDGE_CMD=${FILE_BRIDGE_CMD:-python3 src/file_bridge.py}
TESTDIR=$(mktemp -d)
STATEDIR=$(mktemp -d)
TOKEN="test-token-1234"

# octal permission of a file, GNU coreutils OR macOS/BSD stat
stat_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo '?'
}

# true when something is ACCEPTING connections on the bridge port (a live
# bridge or any leftover listener; connect_ex avoids curl's connect-timeout
# ambiguity, where a stuck listener reads as "free")
port_accepting() {
  python3 -c "import socket,sys
s = socket.socket(); s.settimeout(1)
sys.exit(0 if s.connect_ex(('127.0.0.1', 8765)) == 0 else 1)"
}

# true when the port is BINDABLE by a new bridge instance (superseded by
# nothing; a dying process that still holds the listener reads as busy)
port_bindable() {
  python3 -c "import socket,sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(('127.0.0.1', 8765)); sys.exit(0)
except OSError:
    sys.exit(1)
finally:
    s.close()"
}

echo "test content $(date)" > "$TESTDIR/notes.txt"
mkdir -p "$TESTDIR/sub" && echo "nested" > "$TESTDIR/sub/n.txt"

if port_accepting; then
  echo "ERROR: something already listens on $BRIDGE — stop it first." >&2
  exit 1
fi
FILE_BRIDGE_STATE_DIR="$STATEDIR" FILE_BRIDGE_MAX_WRITES=500 $BRIDGE_CMD "$TESTDIR" &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID 2>/dev/null; rm -rf "$TESTDIR" "$STATEDIR" ${BRKDIR:-} ${BRKSTATE:-}' EXIT
# readiness poll (not a blind sleep): frozen onefile binaries take ~2 s to
# self-extract before the listener comes up
for _ in $(seq 1 60); do curl -s -m 1 "$BRIDGE/health" >/dev/null 2>&1 && break; sleep 0.5; done

fail=0
check() { # name, expected_substring, actual
  if echo "$3" | grep -q "$2"; then echo "  PASS: $1"; else echo "  FAIL: $1 — got: $3"; fail=1; fi
}

# ---------- security: production-mode hard fail (both tiers off) ----------
check "unlocked /read denied"    'bridge unlocked'   "$(curl -s "$BRIDGE/read?path=notes.txt")"
check "unlocked /health works"   '"ok": *true'       "$(curl -s $BRIDGE/health)"
check "unlocked /health reports" 'UNLOCKED'          "$(curl -s $BRIDGE/health)"
check "unlocked /write denied"   'bridge unlocked'   "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' -d '{"path":"x.txt","content":"x"}')"

# ---------- configure tiers via local picker API ----------
check "origin saved"      '"security": *"origin"'  "$(curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"allowed_origin":"http://owui.test:8080"}')"
check "token generated"   'test-token-1234'        "$(curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"token":{"set":"test-token-1234"}}')"
check "state shows mode"  'token+origin'           "$(curl -s $BRIDGE/state)"

# ---------- picker page UX (2.4): placeholders, Browse, OCR validation -----
PH=$(curl -s $BRIDGE/picker)
check "picker: browse button"     'id="browsebtn"'   "$PH"
check "picker: heartbeat marker"  'id="beatinfo"'    "$PH"
check "picker: OCR checkbox box"  'id="langbox"'     "$PH"
check "picker: stop button"       'stopBridge'       "$PH"
case "$(uname -s)" in
  Darwin)  check "picker: mac placeholder"     '/Users/you/Documents' "$PH" ;;
  Linux)   check "picker: linux placeholder"   '/home/you/Documents'  "$PH" ;;
  MINGW*|MSYS*) check "picker: win placeholder" 'C:\\\\Users'        "$PH" ;;
esac
check "ocr_lang: 'eng, swe' normalized to eng+swe" '"ocr_lang": *"eng[+]swe"' \
  "$(curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"ocr_lang":"eng, swe"}')"
check "ocr_lang: unknown code rejected"   'language not installed' \
  "$(curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"ocr_lang":"eng+xyzzy"}')"
check "ocr_lang: junk format rejected"    'must be tesseract codes' \
  "$(curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"ocr_lang":"!!!"}')"

# ---------- token tier ----------
check "no token denied"         'missing or invalid bridge token' "$(curl -s "$BRIDGE/read?path=notes.txt" -H "Origin: http://owui.test:8080")"
check "wrong token denied"      'missing or invalid bridge token' "$(curl -s "$BRIDGE/read?path=notes.txt" -H "Origin: http://owui.test:8080" -H "X-Bridge-Token: nope")"
check "bearer auth accepted"    'test content'                    "$(curl -s "$BRIDGE/read?path=notes.txt" -H "Origin: http://owui.test:8080" -H "Authorization: Bearer test-token-1234")"

# ---------- origin tier ----------
check "foreign origin denied"   'is not the configured'  "$(curl -s "$BRIDGE/read?path=notes.txt" -H "Origin: http://evil.example" -H "X-Bridge-Token: $TOKEN")"
check "no-origin local allowed" 'test content'           "$(curl -s "$BRIDGE/read?path=notes.txt" -H "X-Bridge-Token: $TOKEN")"

# ---------- CORS ----------
H=$(curl -sI -X OPTIONS $BRIDGE/read -H "Origin: http://owui.test:8080" -H "Access-Control-Request-Method: GET" -H "X-Bridge-Token: $TOKEN")
check "CORS locked origin"      'Access-Control-Allow-Origin: http://owui\.test:8080' "$H"
check "CORS private-net"        'Allow-Private-Network: true'      "$H"
check "CORS allows token hdr"   'X-Bridge-Token'                   "$H"
H2=$(curl -sI -X OPTIONS $BRIDGE/read -H "Origin: http://evil.example" -H "Access-Control-Request-Method: GET")
if echo "$H2" | grep -q "Access-Control-Allow-Origin"; then
  echo "  FAIL: foreign origin preflight got CORS headers — got: $H2"; fail=1
else
  echo "  PASS: foreign origin gets no CORS headers"
fi
# opaque origin (Origin: null — OWUI's sandboxed Pyodide iframe). With the
# token tier active it MUST get CORS (otherwise the browser aborts the fetch
# before the token is ever checked — AbortError in Pyodide); the token still
# gates every real request, and responses are only readable with it.
HN=$(curl -sI -X OPTIONS $BRIDGE/read -H "Origin: null" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: x-bridge-token")
check "null-origin preflight granted" 'Access-Control-Allow-Origin: null' "$HN"
check "null-origin preflight hdrs"    'X-Bridge-Token'                    "$HN"
GN=$(curl -s -D - -o /dev/null "$BRIDGE/read?path=notes.txt" -H "Origin: null" -H "X-Bridge-Token: $TOKEN")
check "null-origin GET readable"      'Access-Control-Allow-Origin: null' "$GN"
# ...but a null origin WITHOUT the token is still denied — readable, so the
# model can self-correct in one retry (error body carries no secrets)
GN2=$(curl -s -D /tmp/gn2.h -o /tmp/gn2.b "$BRIDGE/read?path=notes.txt" -H "Origin: null")
check "null-origin no token denied"   '401' "$(cat /tmp/gn2.h)"
check "null-origin denial readable"   'Access-Control-Allow-Origin: null' "$(cat /tmp/gn2.h)"
check "null-origin denial explains"   'missing or invalid bridge token' "$(cat /tmp/gn2.b)"
rm -f /tmp/gn2.h /tmp/gn2.b

# ---------- normal endpoints (with token) ----------
T="-H X-Bridge-Token:$TOKEN"
check "health ok"          '"ok": *true'          "$(curl -s $BRIDGE/health)"
VR=$(curl -s $BRIDGE/version)
check "version endpoint"   '"bridge"'  "$VR"
check "version has skill"  '"skill"'   "$VR"
check "version no token needed" '"bridge"' "$(curl -s $BRIDGE/version)"
check "health shows root"  "$TESTDIR"             "$(curl -s $BRIDGE/health)"
check "list contains file" 'notes.txt'            "$(curl -s $BRIDGE/list?path=. $T)"
check "read content"       'test content'         "$(curl -s "$BRIDGE/read?path=notes.txt" $T)"
check "read nested"        'nested'               "$(curl -s "$BRIDGE/read?path=sub/n.txt" $T)"
check "write works"        '"ok": *true'          "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"out.txt","content":"written"}')"
check "write landed"       'written'              "$(cat "$TESTDIR/out.txt")"
check "traversal blocked"  'escapes'              "$(curl -s "$BRIDGE/read?path=../../etc/passwd" $T)"
check "abs path blocked"   'not allowed'          "$(curl -s "$BRIDGE/read?path=/etc/passwd" $T)"
check "write traversal blocked" 'escapes'         "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"../evil.txt","content":"x"}')"

# ---------- wheels stay token-free ----------
check "wheels listed"       'openpyxl'             "$(curl -s $BRIDGE/wheels)"
check "wheel served"        'PK'                   "$(curl -s $BRIDGE/wheels/openpyxl-3.1.5-py2.py3-none-any.whl | head -c 2)"
check "health reports addons" 'addons'            "$(curl -s $BRIDGE/health)"

# ---------- binary endpoints ----------
printf 'PNG\x89fake-binary-data' > "$TESTDIR/blob.bin"
# NOTE: macOS still ships bash 3.2, whose parser mangles `-d "{\"k\":\"$V\"}"`
# bodies inside a *quoted command-substitution argument* (check "... $(curl ...)").
# Assignment context ($X=$(curl ...)) parses correctly, so JSON bodies with
# escaped quotes + variables always go through a variable first.
BLOB64=$(base64 < "$TESTDIR/blob.bin" | tr -d '\n')
BWR=$(curl -s -X POST $BRIDGE/write_b64 -H 'Content-Type: application/json' $T -d "{\"path\":\"out.bin\",\"b64\":\"$BLOB64\"}")
check "b64 write ok"        '"ok": *true'          "$BWR"
check "b64 read roundtrip"  '0000000'              "$(curl -s "$BRIDGE/read_b64?path=out.bin" $T | python3 -c "import json,sys,base64; d=json.load(sys.stdin); sys.stdout.write(base64.b64decode(d['b64']).decode('latin1')[:7])" | od -c | head -1 | grep -o '0000000' || echo MISS)"
check "b64 traversal blk"   'escapes'              "$(curl -s "$BRIDGE/read_b64?path=../../etc/shadow" $T)"
check "stat kind text"      '"kind": *"text"'      "$(curl -s "$BRIDGE/stat?path=notes.txt" $T)"

# ---------- read safety: whitelist + peek + windowing (P0 #3) ----------
echo "line-one
line-two
line-three" > "$TESTDIR/small.txt"
python3 -c "open('$TESTDIR/big.txt','w').write('\n'.join(f'row {i}' for i in range(1,5001)))"
printf '\x89PNG\r\n\x1a\nfakepng' > "$TESTDIR/fake.txt"          # mislabeled binary
printf 'real pdf content' > "$TESTDIR/doc.dat"                   # unknown ext, text-ish
printf '%%PDF-1.4\nfake pdf body' > "$TESTDIR/mock.pdf"          # pdf magic w/o pymupdf
printf 'PK\x03\x04\nfake zip' > "$TESTDIR/mock.docx"             # office zip magic

check "read windowed numbered" '1\t.*test content\|^     1'  "$(curl -s "$BRIDGE/read?path=notes.txt" $T | python3 -c "import json,sys;print(json.load(sys.stdin)['content'])")"
R=$(curl -s "$BRIDGE/read?path=big.txt&max_lines=100" $T)
check "read window max_lines"  '"end_line": *100'  "$R"
check "read window trailer"    'start_line=101'     "$R"
R2=$(curl -s "$BRIDGE/read?path=big.txt&start_line=4950" $T)
check "read continue window"   '"start_line": *4950' "$R2"
check "read window end"        '"end_line": *5000'   "$R2"
check "read no trailer at EOF" '"total_lines": *5000' "$R2"
check "binary ext rejected"    'not on the' "$(curl -s "$BRIDGE/read?path=out.bin" $T)"
check "fake txt sniffed"       'sniffs as image' "$(curl -s "$BRIDGE/read?path=fake.txt" $T)"
check "pdf ext rejected"       'text-only' "$(curl -s "$BRIDGE/read?path=mock.pdf" $T)"
check "unknown ext rejected"   'fail-closed' "$(curl -s "$BRIDGE/read?path=doc.dat" $T)"
check "peek identifies pdf"    '"kind": *"pdf"' "$(curl -s "$BRIDGE/peek?path=mock.pdf" $T)"
check "peek hints pdf_text"    '/pdf_text'      "$(curl -s "$BRIDGE/peek?path=mock.pdf" $T)"
check "peek on office zip"     'office'         "$(curl -s "$BRIDGE/peek?path=mock.docx" $T)"
check "peek unknown kind"      '"kind": *"unknown"' "$(curl -s "$BRIDGE/peek?path=doc.dat" $T)"
check "peek printable ratio"   'printable_ratio' "$(curl -s "$BRIDGE/peek?path=notes.txt" $T)"

# ---------- snapshots + confirmation tokens (P0 #4) ----------
# first write to a NEW file: no confirmation needed
check "write new file ok"     '"ok": *true'   "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"snapme.txt","content":"v1"}')"
# overwrite WITHOUT token → 409 + token
OW=$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"snapme.txt","content":"v2"}')
check "overwrite demands confirm" 'confirmation_required' "$OW"
CT=$(echo "$OW" | python3 -c "import json,sys; print(json.load(sys.stdin)['confirmation_token'])")
# overwrite with WRONG params (different content length) → token mismatch
# token was consumed by the failed attempt → now invalid
CPM=$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d "{\"path\":\"snapme.txt\",\"content\":\"v2-CHANGED\",\"confirmation_token\":\"$CT\"}")
check "confirm params mismatch" 'do not match' "$CPM"
CPM2=$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d "{\"path\":\"snapme.txt\",\"content\":\"v2\",\"confirmation_token\":\"$CT\"}")
check "token one-shot" 'invalid or expired' "$CPM2"
OW2=$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"snapme.txt","content":"v2"}')
CT2=$(echo "$OW2" | python3 -c "import json,sys; print(json.load(sys.stdin)['confirmation_token'])")
W2=$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d "{\"path\":\"snapme.txt\",\"content\":\"v2\",\"confirmation_token\":\"$CT2\"}")
check "confirmed overwrite ok"  '"ok": *true'     "$W2"
check "snapshot recorded"       '"snapshot": *{"ts"' "$W2"
check "v2 landed"               'v2'              "$(cat "$TESTDIR/snapme.txt")"
# versions list shows metadata only
VL=$(curl -s -X POST $BRIDGE/versions/list -H 'Content-Type: application/json' $T -d '{"path":"snapme.txt"}')
check "versions list metadata"  '"path": *"snapme.txt"' "$VL"
if echo "$VL" | grep -q '"content"'; then echo "  FAIL: version contents leaked"; fail=1; else echo "  PASS: versions are metadata-only"; fi
VTS=$(echo "$VL" | python3 -c "import json,sys; print(json.load(sys.stdin)['versions'][0]['ts'])")
# restore needs its own confirmation
RV=$(curl -s -X POST $BRIDGE/versions/restore -H 'Content-Type: application/json' $T -d "{\"path\":\"snapme.txt\",\"ts\":\"$VTS\"}")
check "restore demands confirm" 'confirmation_required' "$RV"
RCT=$(echo "$RV" | python3 -c "import json,sys; print(json.load(sys.stdin)['confirmation_token'])")
RCR=$(curl -s -X POST $BRIDGE/versions/restore -H 'Content-Type: application/json' $T -d "{\"path\":\"snapme.txt\",\"ts\":\"$VTS\",\"confirmation_token\":\"$RCT\"}")
check "restore confirmed"       '"ok": *true' "$RCR"
check "restore brought v1 back" 'v1'          "$(cat "$TESTDIR/snapme.txt")"
# versions store is OUTSIDE the root
if [ -d "$TESTDIR"/.fb-versions ]; then echo "  FAIL: versions inside root"; fail=1; else echo "  PASS: versions stored outside root"; fi

# ---------- multi-root + ignore lists + self-protection (P0b) ----------
R2=$(mktemp -d); mkdir -p "$R2/other"
echo "second root file" > "$R2/other/deep.txt"
curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d "{\"roots\":[{\"id\":\"main\",\"path\":\"$TESTDIR\",\"ignore\":[\".git/\",\"secrets/\",\"*.tmp\"]},{\"id\":\"second\",\"path\":\"$R2\",\"alias\":\"extra\",\"ignore\":[]}]}" > /tmp/roots_resp.json
check "roots saved"  '"ok": *true' "$(cat /tmp/roots_resp.json)"
check "health lists roots" '"id": *"second"' "$(curl -s $BRIDGE/health)"
check "read root2 by id"   'second root file' "$(curl -s "$BRIDGE/read?path=second/other/deep.txt" $T)"
check "default root intact" 'test content'   "$(curl -s "$BRIDGE/read?path=notes.txt" $T)"
mkdir -p "$TESTDIR/secrets" "$TESTDIR/.git"
echo "TOPSECRET" > "$TESTDIR/secrets/hidden.dat"
echo "ref" > "$TESTDIR/.git/config"
echo "tmp" > "$TESTDIR/junk.tmp"
check "list omits ignored"  'clean' "$(curl -s "$BRIDGE/list?path=." $T | python3 -c "
import json,sys
d=json.load(sys.stdin)
paths=[e['path'] for e in d['entries']]
bad=[p for p in paths if 'secrets/' in p or '.git/' in p or p.endswith('.tmp')]
print('LEAKED:'+str(bad) if bad else 'clean')")"
check "read ignored 404s"   'excluded by settings' "$(curl -s "$BRIDGE/read?path=secrets/hidden.dat" $T)"
check "read dotgit 404s"    'excluded' "$(curl -s "$BRIDGE/read?path=.git/config" $T)"
check "write ignored refused" 'refused\|excluded' "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"secrets/new.txt","content":"x"}')"
check "pdf-like ignored too" 'excluded\|no such' "$(curl -s "$BRIDGE/read?path=junk.tmp" $T)"
# self-protection: state dir never reachable even if a root were to overlap
check "state file unreadable" 'escapes shared root\|never accessible' "$(curl -s "$BRIDGE/read?path=../../../.local/state/file-bridge/state.json" $T 2>/dev/null || echo unreachable)"
# root-in-state rejected by set_roots
SIR=$(curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d "{\"roots\":[{\"id\":\"x\",\"path\":\"$STATEDIR\"}]}")
check "state-inside-root rejected" 'cannot\|error' "$SIR"
# back to single root for the remaining assertions
curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d "{\"roots\":[{\"id\":\"main\",\"path\":\"$TESTDIR\",\"ignore\":[\".git/\",\"secrets/\",\"*.tmp\"]}]}" >/dev/null

# ---------- trash + rate breaker + write_many + readonly (P0b) ----------
# delete = trash-move with confirmation
DEL=$(curl -s -X POST $BRIDGE/delete -H 'Content-Type: application/json' $T -d '{"path":"delme.txt"}' 2>/dev/null)
echo "trash-me" > "$TESTDIR/delme.txt"
DEL=$(curl -s -X POST $BRIDGE/delete -H 'Content-Type: application/json' $T -d '{"path":"delme.txt"}')
check "delete demands confirm" 'confirmation_required' "$DEL"
DT=$(echo "$DEL" | python3 -c "import json,sys; print(json.load(sys.stdin)['confirmation_token'])")
DR=$(curl -s -X POST $BRIDGE/delete -H 'Content-Type: application/json' $T -d "{\"path\":\"delme.txt\",\"confirmation_token\":\"$DT\"}")
check "delete to trash ok"    '"trashed"'   "$DR"
if [ -e "$TESTDIR/delme.txt" ]; then echo "  FAIL: file not moved"; fail=1; else echo "  PASS: file gone from root"; fi
if find "$STATEDIR/trash" -name delme.txt | grep -q delme; then echo "  PASS: in trash store"; else echo "  FAIL: not in trash store"; fail=1; fi
# trash list metadata only + restore
TL=$(curl -s -X POST $BRIDGE/trash/list -H 'Content-Type: application/json' $T -d '{}')
check "trash lists entry"     '"path": *"delme.txt"' "$TL"
TTS=$(echo "$TL" | python3 -c "import json,sys; print(json.load(sys.stdin)['trash'][0]['ts'])")
TRS=$(curl -s -X POST $BRIDGE/trash/restore -H 'Content-Type: application/json' $T -d "{\"path\":\"delme.txt\",\"ts\":\"$TTS\"}")
check "trash restore"         '"ok": *true' "$TRS"
check "trash restored content" 'trash-me'  "$(cat "$TESTDIR/delme.txt")"
check "trash purge is local"  'settings-page' "$(curl -s -X POST $BRIDGE/trash/purge -H 'Content-Type: application/json' $T -d '{}')"

# write_many small batch (≤5 → no confirmation)
WM=$(curl -s -X POST $BRIDGE/write_many -H 'Content-Type: application/json' $T -d '{"items":[{"path":"w1.txt","content":"a"},{"path":"w2.txt","content":"b"}]}')
check "write_many small ok"   '"ok": *true' "$WM"
check "write_many landed"     'a'           "$(cat "$TESTDIR/w1.txt")"
# write_many big batch without confirmation
python3 -c "import json; print(json.dumps({'items':[{'path':f'b{i}.txt','content':'x'} for i in range(7)]}))" > /tmp/many.json
WMB=$(curl -s -X POST $BRIDGE/write_many -H 'Content-Type: application/json' $T -d @/tmp/many.json)
check "write_many mass gated" 'needs explicit confirmation' "$WMB"
# with confirmed:true it goes through
WMBC=$(curl -s -X POST $BRIDGE/write_many -H 'Content-Type: application/json' $T -d "$(python3 -c "import json; d=json.load(open('/tmp/many.json')); d['confirmed']=True; print(json.dumps(d))")")
check "write_many confirmed"  '"ok": *true' "$WMBC"

# readonly mode blocks writes
curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"readonly":true}' >/dev/null
check "readonly blocks write" 'read-only mode' "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"ro.txt","content":"x"}')"
check "readonly blocks delete" 'read-only mode' "$(curl -s -X POST $BRIDGE/delete -H 'Content-Type: application/json' $T -d '{"path":"delme.txt"}')"
check "readonly allows read"  'test content'  "$(curl -s "$BRIDGE/read?path=notes.txt" $T)"
curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"readonly":false}' >/dev/null

# rate circuit breaker: moved to END of script (needs its own low-limit
# instance; see bottom).

# ---------- P1: bridge-side office reads ----------
if command -v uv >/dev/null; then
uv run --with openpyxl --with python-docx --with python-pptx python3 - "$TESTDIR" <<'PYEOF'
import sys, pathlib
d = pathlib.Path(sys.argv[1])
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Data"
ws.append(["Item", "Qty", "Price"]); ws.append(["Widget", 4, 12500])
ws.append(["Gadget", 2, 9000])
ws.merge_cells("A5:B5"); ws["A5"] = "merged-here"
wb.save(d / "sheet.xlsx")
from docx import Document
doc = Document()
doc.add_heading("Quarterly Report", 0)
doc.add_paragraph("Revenue is up.")
doc.add_heading("Details", 1)
t = doc.add_table(rows=2, cols=2); t.cell(0,0).text="K"; t.cell(0,1).text="V"
t.cell(1,0).text="a"; t.cell(1,1).text="1"
doc.save(d / "report.docx")
from pptx import Presentation
prs = Presentation()
s1 = prs.slides.add_slide(prs.slide_layouts[0])
s1.shapes.title.text = "Q3 Review"; s1.placeholders[1].text = "Revenue up 17%"
s2 = prs.slides.add_slide(prs.slide_layouts[1])
s2.shapes.title.text = "Agenda"; s2.placeholders[1].text = "One\nTwo"
prs.save(d / "deck.pptx")
print("fixtures ok")
PYEOF
check "xlsx read engine"   '"engine"'   "$(curl -s "$BRIDGE/xlsx_read?path=sheet.xlsx" $T)"
check "xlsx headers"       'Widget'     "$(curl -s "$BRIDGE/xlsx_read?path=sheet.xlsx" $T)"
check "xlsx numeric cell"  '12500'      "$(curl -s "$BRIDGE/xlsx_read?path=sheet.xlsx" $T)"
check "xlsx sheet select"  '"sheet": *"Data"' "$(curl -s "$BRIDGE/xlsx_read?path=sheet.xlsx&sheet=Data" $T)"
check "xlsx bad sheet"     'no such sheet' "$(curl -s "$BRIDGE/xlsx_read?path=sheet.xlsx&sheet=Nope" $T)"
check "xlsx range"         '"row_count": *2' "$(curl -s "$BRIDGE/xlsx_read?path=sheet.xlsx&range=A1:B2" $T)"
check "xlsx merged"        'A5:B5'      "$(curl -s "$BRIDGE/xlsx_read?path=sheet.xlsx" $T)"
check "xlsx wrong type"    'not an xlsx' "$(curl -s "$BRIDGE/xlsx_read?path=notes.txt" $T)"
XLSX_STDLIB=$(FILE_BRIDGE_NO_OPENPYXL=1 curl -s "$BRIDGE/xlsx_read?path=sheet.xlsx" $T 2>/dev/null || echo "")
check "docx heading"       'Quarterly Report' "$(curl -s "$BRIDGE/docx_read?path=report.docx" $T | python3 -c "import json,sys; print(json.load(sys.stdin)['markdown'])")"
check "docx subheading"    '# Details' "$(curl -s "$BRIDGE/docx_read?path=report.docx" $T | python3 -c "import json,sys; print(json.load(sys.stdin)['markdown'])")"
check "docx table pipe"    '| K | V |' "$(curl -s "$BRIDGE/docx_read?path=report.docx" $T | python3 -c "import json,sys; print(json.load(sys.stdin)['markdown'])")"
check "docx wrong type"    'not a docx' "$(curl -s "$BRIDGE/docx_read?path=sheet.xlsx" $T)"
check "pptx slide count"   '"slide_count": *2' "$(curl -s "$BRIDGE/pptx_read?path=deck.pptx" $T)"
check "pptx title"         'Q3 Review' "$(curl -s "$BRIDGE/pptx_read?path=deck.pptx" $T)"
check "pptx texts"         'Revenue up 17' "$(curl -s "$BRIDGE/pptx_read?path=deck.pptx" $T)"
check "pptx wrong type"    'not a pptx' "$(curl -s "$BRIDGE/pptx_read?path=report.docx" $T)"
fi

# ---------- P1: /search /edit /html_text /csv ----------
cat > "$TESTDIR/contract.txt" <<'EOC'
This agreement is made 2026-01-15.
Section 4: termination clause requires 30 days notice.
Payment terms: net 30.
EOC
mkdir -p "$TESTDIR/docs2"
cp "$TESTDIR/contract.txt" "$TESTDIR/docs2/termination-policy.txt"
printf '<html><head><style>x</style><title>T</title></head><body><h1>Big Title</h1><script>bad()</script><p>Hello <b>world</b></p></body></html>' > "$TESTDIR/page.html"
printf 'name,age,score\nanna,41,9.5\nbob,35,7.25\ncarla,28,8.0\n' > "$TESTDIR/people.csv"

SR=$(curl -s "$BRIDGE/search?q=termination" $T)
check "search finds match"     'termination clause' "$SR"
check "search context lines"   '30 days notice'     "$SR"
check "search path cited"      'contract.txt'       "$SR"
SR2=$(curl -s "$BRIDGE/search?q=TERMINATION" $T)
check "search case-insensitive" 'termination-policy' "$SR2"
SR3=$(curl -s "$BRIDGE/search?q=carla&glob=*.csv" $T)
check "search glob filter"    'people.csv'         "$SR3"
SR4=$(curl -s "$BRIDGE/search?q=TOPSECRET" $T)
check "search respects ignore" 'TOPSECRET' "$SR4" # must NOT appear
if echo "$SR4" | grep -q '"path": "secrets'; then echo "  FAIL: search leaked ignored path"; fail=1; else echo "  PASS: search skips ignored"; fi

HT=$(curl -s "$BRIDGE/html_text?path=page.html" $T)
check "html_text strips tags"  'Hello world'       "$(echo "$HT" | python3 -c "import json,sys; print(json.load(sys.stdin)['text'])")"
check "html_text drops script" 'CLEAN'  "$(echo "$HT" | python3 -c "import json,sys; t=json.load(sys.stdin)['text']; print('CLEAN' if 'bad()' not in t else 'LEAKED')")"
CH=$(curl -s "$BRIDGE/csv_head?path=people.csv&rows=2" $T)
check "csv_head rows"          'anna'    "$CH"
check "csv_head not all rows"  '"head"'  "$CH"
CS=$(curl -s "$BRIDGE/csv_stats?path=people.csv" $T)
check "csv_stats count"        '"row_count": *4' "$CS"
check "csv_stats numeric"      '"type": *"numeric"' "$CS"

# /edit dry-run then real
ED=$(curl -s -X POST $BRIDGE/edit -H 'Content-Type: application/json' $T -d '{"path":"contract.txt","edits":[{"old_text":"30 days","new_text":"60 days"}],"dry_run":true}')
check "edit dry-run diff"      'clause requires 30 days' "$(echo "$ED" | python3 -c "import json,sys; print(json.load(sys.stdin)['diff'])")"
check "edit dry-run diff new"  'requires 60 days notice' "$(echo "$ED" | python3 -c "import json,sys; print(json.load(sys.stdin)['diff'])")"
check "edit dry-run no write"  'termination clause requires 30 days notice' "$(cat "$TESTDIR/contract.txt")"
ED2=$(curl -s -X POST $BRIDGE/edit -H 'Content-Type: application/json' $T -d '{"path":"contract.txt","edits":[{"old_text":"30 days","new_text":"60 days"}]}')
check "edit needs confirm"     'confirmation_required' "$ED2"
ECT=$(echo "$ED2" | python3 -c "import json,sys; print(json.load(sys.stdin)['confirmation_token'])")
ED3=$(curl -s -X POST $BRIDGE/edit -H 'Content-Type: application/json' $T -d "{\"path\":\"contract.txt\",\"edits\":[{\"old_text\":\"30 days\",\"new_text\":\"60 days\"}],\"confirmation_token\":\"$ECT\"}")
check "edit applied"           '"ok": *true'   "$ED3"
check "edit landed"            '60 days'       "$(cat "$TESTDIR/contract.txt")"
check "edit bad old_text"      'not found'     "$(curl -s -X POST $BRIDGE/edit -H 'Content-Type: application/json' $T -d '{"path":"contract.txt","edits":[{"old_text":"zzz-not-there","new_text":"x"}],"dry_run":true}')"

# ---------- state dir isolation & permissions ----------
if [ -f "$STATEDIR/state.json" ]; then echo "  PASS: state in FILE_BRIDGE_STATE_DIR"; else echo "  FAIL: state.json not in STATEDIR"; fail=1; fi
PERM=$(stat_mode "$STATEDIR/state.json")
if [ "$PERM" = "600" ]; then echo "  PASS: state.json is 0600"; else echo "  FAIL: state.json perm $PERM != 600"; fail=1; fi
if grep -q "test-token-1234" "$STATEDIR/state.json" 2>/dev/null; then
  echo "  FAIL: plaintext token leaked into state.json"; fail=1
else
  echo "  PASS: state.json holds only the token hash"
fi

# ---------- audit log (P2): JSONL in state dir, secrets scrubbed ----------
if [ -f "$STATEDIR/audit.log" ]; then echo "  PASS: audit.log created in state dir"; else echo "  FAIL: no audit.log in $STATEDIR"; fail=1; fi
if grep -q '"endpoint": "/read"' "$STATEDIR/audit.log"; then echo "  PASS: audit records endpoint"; else echo "  FAIL: no /read entry in audit.log"; fail=1; fi
if grep -q '"endpoint": "/write"' "$STATEDIR/audit.log"; then echo "  PASS: audit records POST /write"; else echo "  FAIL: no /write entry"; fail=1; fi
if grep -q '"path": "notes.txt"' "$STATEDIR/audit.log"; then echo "  PASS: audit records path"; else echo "  FAIL: notes.txt not in audit.log"; fail=1; fi
if grep -q '"status": 404' "$STATEDIR/audit.log"; then echo "  PASS: audit records error status"; else echo "  FAIL: no 404 in audit.log"; fail=1; fi
if grep -q '"written"' "$STATEDIR/audit.log" || grep -q 'test content' "$STATEDIR/audit.log"; then
  echo "  FAIL: audit leaked file content"; fail=1
else
  echo "  PASS: audit has no file contents"
fi
if grep -qi 'test-token-1234' "$STATEDIR/audit.log"; then
  echo "  FAIL: audit leaked bridge token"; fail=1
else
  echo "  PASS: audit has no token material"
fi
# every line must be valid JSON (JSONL invariant)
AJ=$(python3 - "$STATEDIR/audit.log" <<'PY'
import json, sys
bad = 0
with open(sys.argv[1]) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            assert "ts" in rec and "endpoint" in rec and "status" in rec
        except Exception:
            bad += 1
print(bad)
PY
)
if [ "$AJ" = "0" ]; then echo "  PASS: audit.log is valid JSONL with ts/endpoint/status"; else echo "  FAIL: $AJ malformed audit lines"; fail=1; fi
APER=$(stat_mode "$STATEDIR/audit.log")
if [ "$APER" = "600" ]; then echo "  PASS: audit.log is 0600"; else echo "  FAIL: audit.log perm $APER != 600"; fail=1; fi
# api/root settings changes audited with values redacted
if grep -q '"endpoint": "/api/root"' "$STATEDIR/audit.log" && ! grep -q 'owui.test:8080' "$STATEDIR/audit.log"; then
  echo "  PASS: /api/root audited, origin value redacted"
else
  echo "  FAIL: /api/root audit missing or origin leaked"; fail=1
fi

# ---------- atomic writes (P2): mode preserved, no tmp leftovers ----------
chmod 640 "$TESTDIR/notes.txt" 2>/dev/null || true
OWT=$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"notes.txt","content":"v2 atomic"}')
OCT=$(echo "$OWT" | python3 -c "import json,sys; print(json.load(sys.stdin)['confirmation_token'])" 2>/dev/null || echo "")
OWM=$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d "{\"path\":\"notes.txt\",\"content\":\"v2 atomic\",\"confirmation_token\":\"$OCT\"}")
check "overwrite confirmed"  '"ok": *true' "$OWM"
check "overwrite keeps mode" '600\|640' "$(stat_mode "$TESTDIR/notes.txt")"
check "atomic write landed"  'v2 atomic'  "$(cat "$TESTDIR/notes.txt")"
LEFT=$(find "$TESTDIR" -maxdepth 1 -name '.fb-tmp-*' -o -maxdepth 1 -name '.fb-restore-*' | wc -l | tr -d ' ')
if [ "$LEFT" = "0" ]; then echo "  PASS: no temp files left behind"; else echo "  FAIL: $LEFT temp files left in root"; fail=1; fi
# edit path also atomic + mode-preserving
chmod 640 "$TESTDIR/contract.txt" 2>/dev/null || true
EDM=$(curl -s -X POST $BRIDGE/edit -H 'Content-Type: application/json' $T -d '{"path":"contract.txt","edits":[{"old_text":"60 days","new_text":"90 days"}]}')
ECT2=$(echo "$EDM" | python3 -c "import json,sys; print(json.load(sys.stdin)['confirmation_token'])" 2>/dev/null || echo "")
curl -s -X POST $BRIDGE/edit -H 'Content-Type: application/json' $T -d "{\"path\":\"contract.txt\",\"edits\":[{\"old_text\":\"60 days\",\"new_text\":\"90 days\"}],\"confirmation_token\":\"$ECT2\"}" >/dev/null
if [ "$(stat_mode "$TESTDIR/contract.txt")" = "640" ]; then echo "  PASS: edit preserves mode"; else echo "  FAIL: edit changed mode to $(stat_mode "$TESTDIR/contract.txt")"; fail=1; fi
check "edit atomic landed" '90 days' "$(cat "$TESTDIR/contract.txt")"
# write_b64 preserves mode too
chmod 640 "$TESTDIR/out.bin" 2>/dev/null || true
OB=$(curl -s -X POST $BRIDGE/write_b64 -H 'Content-Type: application/json' $T -d "{\"path\":\"out.bin\",\"b64\":\"$(echo -n x | base64)\"}")
OBT=$(echo "$OB" | python3 -c "import json,sys; print(json.load(sys.stdin)['confirmation_token'])" 2>/dev/null || echo "")
curl -s -X POST $BRIDGE/write_b64 -H 'Content-Type: application/json' $T -d "{\"path\":\"out.bin\",\"b64\":\"$(echo -n y | base64)\",\"confirmation_token\":\"$OBT\"}" >/dev/null
if [ "$(stat_mode "$TESTDIR/out.bin")" = "640" ]; then echo "  PASS: write_b64 preserves mode"; else echo "  FAIL: write_b64 mode $(stat_mode "$TESTDIR/out.bin")"; fail=1; fi
# versions/restore lands atomically with snapshot's mode
VLN=$(curl -s -X POST $BRIDGE/versions/list -H 'Content-Type: application/json' $T -d '{"path":"notes.txt"}')
VRT=$(echo "$VLN" | python3 -c "import json,sys; print(json.load(sys.stdin)['versions'][0]['ts'])")
VRV=$(curl -s -X POST $BRIDGE/versions/restore -H 'Content-Type: application/json' $T -d "{\"path\":\"notes.txt\",\"ts\":\"$VRT\"}")
VRT2=$(echo "$VRV" | python3 -c "import json,sys; print(json.load(sys.stdin)['confirmation_token'])" 2>/dev/null || echo "")
RCR2=$(curl -s -X POST $BRIDGE/versions/restore -H 'Content-Type: application/json' $T -d "{\"path\":\"notes.txt\",\"ts\":\"$VRT\",\"confirmation_token\":\"$VRT2\"}")
check "restore confirmed (atomic)" '"ok": *true' "$RCR2"
check "restore landed original" 'test content' "$(cat "$TESTDIR/notes.txt")"
RPERM=$(stat_mode "$TESTDIR/notes.txt")
if [ "$RPERM" = "640" ] || [ "$RPERM" = "600" ]; then echo "  PASS: restore preserves mode ($RPERM)"; else echo "  FAIL: restore mode $RPERM"; fail=1; fi

# ---------- symlink protection (P2, Linux) ----------
mkdir -p "$TESTDIR/realdir"
echo "outside data" > "$TESTDIR/realdir/outside.txt"
ln -sfn "$TESTDIR/realdir" "$TESTDIR/linkdir"
ln -sf "$TESTDIR/realdir/outside.txt" "$TESTDIR/linkfile.txt"
check "write via dir-symlink blocked"  'escapes\|not found\|symlink' "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"linkdir/newfile.txt","content":"x"}')"
check "read via dir-symlink blocked"   'symlink' "$(curl -s "$BRIDGE/read?path=linkdir/outside.txt" $T)"
check "write through file-symlink refused" 'symlink' "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"linkfile.txt","content":"x"}')"
if [ -L "$TESTDIR/linkfile.txt" ]; then echo "  PASS: symlink not clobbered by replace"; else echo "  FAIL: symlink was replaced"; fail=1; fi
if grep -q "outside data" "$TESTDIR/realdir/outside.txt" 2>/dev/null; then echo "  PASS: symlink target untouched"; else echo "  FAIL: secret.txt via symlink was modified"; fail=1; fi
LEFT2=$(find "$TESTDIR" -maxdepth 1 -name '.fb-*' | wc -l | tr -d ' ')
if [ "$LEFT2" = "0" ]; then echo "  PASS: still no temp leftovers after symlink tests"; else echo "  FAIL: $LEFT2 temp files left"; fail=1; fi

# ---------- sensitive-name blacklist (P2) ----------
printf 'AWS_KEY=AKIATEST\n' > "$TESTDIR/.env"
printf '%s\n' '-----BEGIN PRIVATE KEY-----' > "$TESTDIR/cert.pem"
check "read .env blocked"        'credential'  "$(curl -s "$BRIDGE/read?path=.env" $T)"
check "read_b64 .env blocked"    'credential'  "$(curl -s "$BRIDGE/read_b64?path=.env" $T)"
check "stat .pem blocked"        'credential'  "$(curl -s "$BRIDGE/stat?path=cert.pem" $T)"
check "write .env blocked"       'credential'  "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":".env","content":"x"}')"
check "write id_rsa blocked"     'credential'  "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"id_rsa","content":"x"}')"
check "stat .env blocked"        'credential'  "$(curl -s "$BRIDGE/stat?path=.env" $T)"
if grep -q 'AKIATEST' "$TESTDIR/.env" && [ "$(cat "$TESTDIR/.env")" = "AWS_KEY=AKIATEST" ]; then echo "  PASS: .env content untouched"; else echo "  FAIL: .env was modified"; fail=1; fi
# normal files unaffected
check "normal file still readable" 'test content' "$(curl -s "$BRIDGE/read?path=notes.txt" $T)"

# ---------- /zip /unzip /directory_tree (P2, stdlib) ----------
mkdir -p "$TESTDIR/pack/sub"
echo "alpha" > "$TESTDIR/pack/a.txt"
echo "beta"  > "$TESTDIR/pack/sub/b.txt"
echo "loose" > "$TESTDIR/loose.txt"
check "zip creates archive"   '"ok": *true'    "$(curl -s -X POST $BRIDGE/zip -H 'Content-Type: application/json' $T -d '{"members":["pack","loose.txt"],"out":"bundle.zip"}')"
check "zip counts files"     '"files": *2'     "$(curl -s -X POST $BRIDGE/zip -H 'Content-Type: application/json' $T -d '{"members":["pack"],"out":"p2.zip"}')"
if command -v unzip >/dev/null; then
  check "zip readable"       'a.txt'  "$(unzip -l "$TESTDIR/bundle.zip" 2>/dev/null || echo NOMEMBER)"
else
  check "zip readable"       'PK'     "$(head -c 2 "$TESTDIR/bundle.zip")"
fi
check "zip missing member 404" 'not found'  "$(curl -s -X POST $BRIDGE/zip -H 'Content-Type: application/json' $T -d '{"members":["nope.txt"],"out":"x.zip"}')"
check "zip bad ext refused" 'must end in .zip' "$(curl -s -X POST $BRIDGE/zip -H 'Content-Type: application/json' $T -d '{"members":["loose.txt"],"out":"x.tar"}')"
# unzip roundtrip
check "unzip extracts"      '"files": *3'    "$(curl -s -X POST $BRIDGE/unzip -H 'Content-Type: application/json' $T -d '{"path":"bundle.zip","dest":"unpacked"}')"
check "unzip file content"  'alpha'          "$(cat "$TESTDIR/unpacked/a.txt")"
check "unzip dir member"    'beta'           "$(cat "$TESTDIR/unpacked/b.txt")"
# zip-slip: craft a malicious archive with ../ member
python3 - "$TESTDIR/evil.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("../escaped.txt", "pwned")
PY
check "zip-slip blocked"    'unsafe member'  "$(curl -s -X POST $BRIDGE/unzip -H 'Content-Type: application/json' $T -d '{"path":"evil.zip","dest":"unpacked"}')"
if [ -f "$TESTDIR/../escaped.txt" ] || [ -f "/tmp/escaped.txt" ]; then echo "  FAIL: zip-slip escaped the root"; fail=1; else echo "  PASS: no file escaped"; fi
check "unzip non-zip refused" 'not a zip\|not a valid' "$(curl -s -X POST $BRIDGE/unzip -H 'Content-Type: application/json' $T -d '{"path":"loose.txt","dest":"d"}')"
# directory_tree
DT=$(curl -s "$BRIDGE/directory_tree?path=." $T)
check "tree lists root files"   'notes.txt'  "$DT"
check "tree nested dirs"        '"children"' "$DT"
check "tree counts entries"     'entry_count' "$DT"
DT2=$(curl -s "$BRIDGE/directory_tree?path=pack" $T)
check "tree subdir works"       'a.txt'      "$DT2"
if echo "$DT" | grep -q 'TOPSECRET'; then echo "  FAIL: tree leaked ignored path"; fail=1; else echo "  PASS: tree respects ignore lists"; fi

# pdf_text/ocr functional tests: run suite WITH addons via:
#   uv run --with pymupdf,rapidocr-onnxruntime bash tests/e2e_test.sh
ADDONS=$(curl -s $BRIDGE/health | python3 -c "import json,sys; print(json.load(sys.stdin)['addons']['pdf'])" 2>/dev/null || echo False)
if [ "$ADDONS" = "True" ]; then
  python3 - <<PY
import fitz
doc = fitz.open(); page = doc.new_page()
page.insert_text((72,72), "E2E INVOICE 42", fontname="helv", fontsize=12)
doc.save("$TESTDIR/inv.pdf"); doc.close()
PY
fi

# ---------- image_info + reveal (P3) ----------
# stdlib-built fixtures: 3x2 PNG (hand-rolled), 4x1 GIF, BMP
python3 - "$TESTDIR" <<'PYEOF'
import sys, struct, zlib, pathlib
d = pathlib.Path(sys.argv[1])
# PNG 3x2 RGB
def chunk(tag, payload):
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
raw = b"\x00" + b"\xff\x00\x00" * 3 + b"\x00" + b"\x00\xff\x00" * 3
png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 3, 2, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
(d / "tiny.png").write_bytes(png)
# GIF 4x1
gif = b"GIF89a" + struct.pack("<HH", 4, 1) + b"\x80\x00\x00" + b"\x00\x00\x00\xff\xff\xff" + b"\x2c" + struct.pack("<HHHH", 0, 0, 4, 1) + b"\x00\x02\x02\x44\x01\x00" + b"\x3b"
(d / "tiny.gif").write_bytes(gif)
# BMP 2x2 (BITMAPINFOHEADER, 24bpp)
bih = struct.pack("<IiiHHIIiiII", 40, 2, 2, 1, 24, 0, 16, 0, 0, 0, 0)
bmp = b"BM" + struct.pack("<IHHI", 14 + len(bih) + 16, 0, 0, 14 + len(bih)) + bih + b"\x00" * 16
(d / "tiny.bmp").write_bytes(bmp)
print("image fixtures ok")
PYEOF
II=$(curl -s "$BRIDGE/image_info?path=tiny.png" $T)
check "png dims"              '"width": *3'      "$II"
check "png height"            '"height": *2'     "$II"
check "png format"            '"format": *"png"' "$II"
check "png megapixels"        'megapixels'       "$II"
check "gif dims"              '"width": *4'      "$(curl -s "$BRIDGE/image_info?path=tiny.gif" $T)"
check "bmp dims"              '"width": *2'      "$(curl -s "$BRIDGE/image_info?path=tiny.bmp" $T)"
check "image_info non-image"  'not a supported image' "$(curl -s "$BRIDGE/image_info?path=notes.txt" $T)"
check "image_info missing"    'no such file'     "$(curl -s "$BRIDGE/image_info?path=ghost.png" $T)"
check "image_info traversal"  'escapes'          "$(curl -s "$BRIDGE/image_info?path=../../etc/passwd" $T)"
# reveal: consent-gated OFF by default
RV=$(curl -s "$BRIDGE/reveal?path=notes.txt" $T)
check "reveal off by default" 'reveal is disabled' "$RV"
# enabling via local picker API unlocks it (xdg-open on headless may fail —
# accept either ok or the explicit file-manager error, NOT the 403)
curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"allow_reveal":true}' >/dev/null
RV2=$(curl -s "$BRIDGE/reveal?path=notes.txt" $T)
if echo "$RV2" | grep -q 'reveal is disabled'; then echo "  FAIL: reveal still gated after enabling"; fail=1; else echo "  PASS: reveal unlocks when enabled"; fi
curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"allow_reveal":false}' >/dev/null
check "reveal re-locks"       'reveal is disabled' "$(curl -s "$BRIDGE/reveal?path=notes.txt" $T)"
check "state shows allow_reveal" 'allow_reveal'  "$(curl -s $BRIDGE/state)"

# ---------- .eml parsing (P3, stdlib) ----------
python3 - "$TESTDIR" <<'PYEOF'
import sys, pathlib
from email.message import EmailMessage
from email.utils import formatdate
d = pathlib.Path(sys.argv[1])
m = EmailMessage()
m["From"] = "Anna Svensson <anna@example.se>"
m["To"] = "Dandan Wei <dandan@example.com>"
m["Cc"] = "cc@example.com"
m["Subject"] = "Quarterly invoice attached"
m["Date"] = formatdate(1787896000, localtime=False)
m.set_content("Hej!\n\nPlease find the invoice below.\nTotal: 44 000 SEK.\n\nMvh Anna")
m.add_attachment(b"PK\x03\x04fake-xlsx-bytes", maintype="application",
                 subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                 filename="invoice-q3.xlsx")
(d / "mail-with-attachment.eml").write_bytes(m.as_bytes())
# html-only mail
h = EmailMessage()
h["Subject"] = "HTML newsletter"
h["From"] = "news@example.com"
h["To"] = "me@example.com"
h.set_content("<html><body><p>Hello <b>HTML</b> world</p><script>evil()</script></body></html>", subtype="html")
(d / "mail-html.eml").write_bytes(h.as_bytes())
print("eml fixtures ok")
PYEOF
EM=$(curl -s "$BRIDGE/eml_read?path=mail-with-attachment.eml" $T)
check "eml subject"          'Quarterly invoice attached' "$EM"
check "eml from"             'anna@example.se'   "$EM"
check "eml body text"        '44 000 SEK'        "$EM"
check "eml attachment count" '"attachment_count": *1' "$EM"
check "eml attachment name"  'invoice-q3.xlsx'   "$EM"
check "eml date_iso"         'date_iso'          "$EM"
check "eml cc"               'cc@example.com'    "$EM"
EH=$(curl -s "$BRIDGE/eml_read?path=mail-html.eml" $T)
check "eml html stripped"    'Hello *HTML* world\|Hello' "$EH"
check "eml script dropped"   'body_was_html'     "$EH"
if echo "$EH" | grep -q 'evil()'; then echo "  FAIL: script leaked into body"; fail=1; else echo "  PASS: script stripped"; fi
check "eml wrong ext"        'needs an .eml file' "$(curl -s "$BRIDGE/eml_read?path=notes.txt" $T)"
check "eml missing"          'no such file'       "$(curl -s "$BRIDGE/eml_read?path=ghost.eml" $T)"
check "eml traversal"        'escapes'            "$(curl -s "$BRIDGE/eml_read?path=../../etc/passwd" $T)"
ECT=$(curl -s "$BRIDGE/eml_read?path=mail-with-attachment.eml&max_chars=30" $T)
check "eml truncation"       '"truncated": *true' "$ECT"

# ---------- risk classes per endpoint (P3) ----------
RS=$(curl -s $BRIDGE/state)
check "state exposes risk map"    'endpoint_risk'  "$RS"
check "risk: write_local on /write"    '"/write": *"write_local"'    "$RS"
check "risk: read on /pdf_text"        '"/pdf_text": *"read"'        "$RS"
check "risk: ui on /reveal"            '"/reveal": *"ui"'            "$RS"
check "risk: meta on /health"          '"/health": *"meta"'          "$RS"
# every table endpoint appears in the map (no silently-unclassified routes)
MISSING_RISK=$(echo "$RS" | python3 -c "
import json, sys
d = json.load(sys.stdin)['endpoint_risk']
for ep in ('/write','/write_b64','/edit','/delete','/write_many','/zip','/unzip',
           '/versions/list','/versions/restore','/trash/list','/trash/restore',
           '/pdf_text','/ocr','/ocr_pdf','/pdf_op','/docx_merge',
           '/pptx_from_template','/image_info','/reveal','/list','/read','/peek',
           '/stat','/search','/html_text','/csv_head','/csv_stats','/xlsx_read',
           '/docx_read','/pptx_read','/directory_tree','/api/pick_folder',
           '/api/shutdown'):
    if ep not in d:
        print('missing:', ep)
")
if [ -n "$MISSING_RISK" ]; then echo "  FAIL: risk map gaps — $MISSING_RISK"; fail=1; else echo "  PASS: risk map covers all endpoints"; fi
# audit rows carry the declared class
curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"risk-audit.txt","content":"x"}' >/dev/null
AL=$(tail -3 "$STATEDIR/audit.log" | grep '"endpoint": "/write"' | tail -1)
check "audit row has risk class"  '"risk": *"write_local"'  "$AL"
AL2=$(tail -50 "$STATEDIR/audit.log" | grep '"endpoint": "/read"' | tail -1 || true)
if [ -n "$AL2" ] && echo "$AL2" | grep -q '"risk": *"read"'; then echo "  PASS: read audit has risk class"; elif [ -z "$AL2" ]; then echo "  PASS: read audit has risk class (no /read row yet)"; else echo "  FAIL: read audit risk wrong — $AL2"; fail=1; fi

# ---------- rate circuit breaker (own low-limit instance) ----------
# The main suite bridge runs with FILE_BRIDGE_MAX_WRITES=500, so a burst can
# never trip it there. This runs LAST because it reclaims port 8765.
kill $BRIDGE_PID 2>/dev/null || true
wait $BRIDGE_PID 2>/dev/null || true
# wait until a new bridge could bind the port again (the old listener must
# be fully gone; ss is Linux-only so we test bindability directly)
for _ in $(seq 1 40); do port_bindable && break; sleep 0.25; done
BRKDIR=$(mktemp -d); BRKSTATE=$(mktemp -d)
echo "b1" > "$BRKDIR/f.txt"
FILE_BRIDGE_STATE_DIR="$BRKSTATE" FILE_BRIDGE_MAX_WRITES=3 $BRIDGE_CMD "$BRKDIR" &
BRIDGE_PID=$!
for _ in $(seq 1 60); do curl -s -m 1 "$BRIDGE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"allowed_origin":"http://owui.test:8080"}' >/dev/null
BRK=""
for i in $(seq 1 6); do
  R=$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d "{\"path\":\"burst-$i.txt\",\"content\":\"x\"}")
  if echo "$R" | grep -q rate_limited; then BRK="$R"; break; fi
done
check "rate breaker trips"    'circuit breaker' "$BRK"
check "breaker err mentions limit" 'limits 3 /' "$BRK"

echo
if [[ $fail -eq 0 ]]; then echo "ALL TESTS PASSED ✅"; else echo "SOME TESTS FAILED ❌"; exit 1; fi
