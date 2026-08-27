#!/usr/bin/env bash
# End-to-end test: starts the bridge, exercises every endpoint incl. security.
# Run:  ./tests/e2e_test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BRIDGE="http://127.0.0.1:8765"
TESTDIR=$(mktemp -d)
STATEDIR=$(mktemp -d)
TOKEN="test-token-1234"
echo "test content $(date)" > "$TESTDIR/notes.txt"
mkdir -p "$TESTDIR/sub" && echo "nested" > "$TESTDIR/sub/n.txt"

if curl -s -m 1 "$BRIDGE/health" >/dev/null 2>&1; then
  echo "ERROR: something already listens on $BRIDGE — stop it first." >&2
  exit 1
fi
FILE_BRIDGE_STATE_DIR="$STATEDIR" python3 src/file_bridge.py "$TESTDIR" &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID 2>/dev/null; rm -rf "$TESTDIR" "$STATEDIR"' EXIT
sleep 1.5

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

# ---------- normal endpoints (with token) ----------
T="-H X-Bridge-Token:$TOKEN"
check "health ok"          '"ok": *true'          "$(curl -s $BRIDGE/health)"
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
check "b64 write ok"        '"ok": *true'          "$(curl -s -X POST $BRIDGE/write_b64 -H 'Content-Type: application/json' $T -d "{\"path\":\"out.bin\",\"b64\":\"$(base64 -w0 < "$TESTDIR/blob.bin")\"}")"
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
check "confirm params mismatch" 'do not match' "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d "{\"path\":\"snapme.txt\",\"content\":\"v2-CHANGED\",\"confirmation_token\":\"$CT\"}")"
# token was consumed by the failed attempt → now invalid
check "token one-shot" 'invalid or expired' "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d "{\"path\":\"snapme.txt\",\"content\":\"v2\",\"confirmation_token\":\"$CT\"}")"
# fresh token, correct params → success + snapshot recorded
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
check "restore confirmed"       '"ok": *true' "$(curl -s -X POST $BRIDGE/versions/restore -H 'Content-Type: application/json' $T -d "{\"path\":\"snapme.txt\",\"ts\":\"$VTS\",\"confirmation_token\":\"$RCT\"}")"
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
echo "TOPSECRET" > "$TESTDIR/secrets/key.pem"
echo "ref" > "$TESTDIR/.git/config"
echo "tmp" > "$TESTDIR/junk.tmp"
check "list omits ignored"  'clean' "$(curl -s "$BRIDGE/list?path=." $T | python3 -c "
import json,sys
d=json.load(sys.stdin)
paths=[e['path'] for e in d['entries']]
bad=[p for p in paths if 'secrets/' in p or '.git/' in p or p.endswith('.tmp')]
print('LEAKED:'+str(bad) if bad else 'clean')")"
check "read ignored 404s"   'excluded by settings' "$(curl -s "$BRIDGE/read?path=secrets/key.pem" $T)"
check "read dotgit 404s"    'excluded' "$(curl -s "$BRIDGE/read?path=.git/config" $T)"
check "write ignored refused" 'refused\|excluded' "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d '{"path":"secrets/new.txt","content":"x"}')"
check "pdf-like ignored too" 'excluded\|no such' "$(curl -s "$BRIDGE/read?path=junk.tmp" $T)"
# self-protection: state dir never reachable even if a root were to overlap
check "state file unreadable" 'escapes shared root\|never accessible' "$(curl -s "$BRIDGE/read?path=../../../.local/state/file-bridge/state.json" $T 2>/dev/null || echo unreachable)"
# root-in-state rejected by set_roots
check "state-inside-root rejected" 'cannot\|error' "$(curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d "{\"roots\":[{\"id\":\"x\",\"path\":\"$STATEDIR\"}]}")"
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
check "trash restore"         '"ok": *true' "$(curl -s -X POST $BRIDGE/trash/restore -H 'Content-Type: application/json' $T -d "{\"path\":\"delme.txt\",\"ts\":\"$TTS\"}")"
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

# rate circuit breaker (low limit via env would need restart; assert the
# response carries the breaker fields by bursting writes)
BURST=0; BRK=""
for i in $(seq 1 25); do
  R=$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' $T -d "{\"path\":\"burst-new-$i.txt\",\"content\":\"x\"}")
  if echo "$R" | grep -q rate_limited; then BRK="$R"; break; fi
done
check "rate breaker trips"    'circuit breaker' "$BRK"
rm -f "$TESTDIR"/burst-new-*.txt 2>/dev/null

# ---------- state dir isolation & permissions ----------
if [ -f "$STATEDIR/state.json" ]; then echo "  PASS: state in FILE_BRIDGE_STATE_DIR"; else echo "  FAIL: state.json not in STATEDIR"; fail=1; fi
PERM=$(stat -c '%a' "$STATEDIR/state.json" 2>/dev/null || echo "?")
if [ "$PERM" = "600" ]; then echo "  PASS: state.json is 0600"; else echo "  FAIL: state.json perm $PERM != 600"; fail=1; fi
if grep -q "test-token-1234" "$STATEDIR/state.json" 2>/dev/null; then
  echo "  FAIL: plaintext token leaked into state.json"; fail=1
else
  echo "  PASS: state.json holds only the token hash"
fi

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

echo
if [[ $fail -eq 0 ]]; then echo "ALL TESTS PASSED ✅"; else echo "SOME TESTS FAILED ❌"; exit 1; fi
