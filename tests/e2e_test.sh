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
check "abs path blocked"   'escapes'              "$(curl -s "$BRIDGE/read?path=/etc/passwd" $T)"
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
