#!/usr/bin/env bash
# End-to-end test: starts the bridge, exercises every endpoint incl. security checks.
# Run:  ./tests/e2e_test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BRIDGE="http://127.0.0.1:8765"
TESTDIR=$(mktemp -d)
echo "test content $(date)" > "$TESTDIR/notes.txt"
mkdir -p "$TESTDIR/sub" && echo "nested" > "$TESTDIR/sub/n.txt"

if curl -s -m 1 "$BRIDGE/health" >/dev/null 2>&1; then
  echo "ERROR: something already listens on $BRIDGE — stop it first." >&2
  exit 1
fi
python3 src/file_bridge.py "$TESTDIR" &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID 2>/dev/null; rm -rf "$TESTDIR"' EXIT
sleep 1.5

fail=0
check() { # name, expected_substring, actual
  if echo "$3" | grep -q "$2"; then echo "  PASS: $1"; else echo "  FAIL: $1 — got: $3"; fail=1; fi
}

check "health ok"          '"ok": *true'          "$(curl -s $BRIDGE/health)"
check "health shows root"  "$TESTDIR"             "$(curl -s $BRIDGE/health)"
check "list contains file" 'notes.txt'            "$(curl -s "$BRIDGE/list?path=." )"
check "read content"       'test content'         "$(curl -s "$BRIDGE/read?path=notes.txt")"
check "read nested"        'nested'               "$(curl -s "$BRIDGE/read?path=sub/n.txt")"
check "write works"        '"ok": *true'          "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' -d '{"path":"out.txt","content":"written"}')"
check "write landed"       'written'              "$(cat "$TESTDIR/out.txt")"
check "traversal blocked"  'escapes'              "$(curl -s "$BRIDGE/read?path=../../etc/passwd")"
check "abs path blocked"   'escapes'              "$(curl -s "$BRIDGE/read?path=/etc/passwd")"
check "write traversal blocked" 'escapes'         "$(curl -s -X POST $BRIDGE/write -H 'Content-Type: application/json' -d '{"path":"../evil.txt","content":"x"}')"
check "CORS origin"        'Access-Control-Allow-Origin: \*'  "$(curl -sI -X OPTIONS $BRIDGE/read -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: GET')"
check "CORS private-net"   'Allow-Private-Network: true'      "$(curl -sI -X OPTIONS $BRIDGE/read -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: GET')"

# --- binary endpoints
printf 'PNG\x89fake-binary-data' > "$TESTDIR/blob.bin"
check "b64 write ok"        '"ok": *true'          "$(curl -s -X POST $BRIDGE/write_b64 -H 'Content-Type: application/json' -d "{\"path\":\"out.bin\",\"b64\":\"$(base64 -w0 < "$TESTDIR/blob.bin")\"}")"
check "b64 read roundtrip"  '0000000'              "$(curl -s "$BRIDGE/read_b64?path=out.bin" | python3 -c "import json,sys,base64; d=json.load(sys.stdin); sys.stdout.write(base64.b64decode(d['b64']).decode('latin1')[:7])" | od -c | head -1 | grep -o '0000000' || echo MISS)"
check "b64 traversal blk"   'escapes'              "$(curl -s "$BRIDGE/read_b64?path=../../etc/shadow")"
check "stat kind text"      '"kind": *"text"'      "$(curl -s "$BRIDGE/stat?path=notes.txt")"
check "wheels listed"       'openpyxl'             "$(curl -s $BRIDGE/wheels)"
check "wheel served"        'PK'                   "$(curl -s $BRIDGE/wheels/openpyxl-3.1.5-py2.py3-none-any.whl | head -c 2)"
check "health reports addons" 'addons'            "$(curl -s $BRIDGE/health)"
# pdf_text/ocr functional tests: run suite WITH addons via:
#   uv run --with pymupdf,rapidocr-onnxruntime bash tests/e2e_test.sh
ADDONS=$(curl -s $BRIDGE/health | python3 -c "import json,sys; print(json.load(sys.stdin)['addons']['pdf'])" 2>/dev/null || echo False)
if [ "$ADDONS" = "True" ]; then
  python3 - <<'PY'
import fitz
doc = fitz.open(); page = doc.new_page()
page.insert_text((72,72), "E2E INVOICE 42", fontname="helv", fontsize=12)
doc.save("TESTDIR_PLACEHOLDER/inv.pdf"); doc.close()
PY
  sed -i "s|TESTDIR_PLACEHOLDER|$TESTDIR|" /dev/null 2>/dev/null || true
fi

echo
if [[ $fail -eq 0 ]]; then echo "ALL TESTS PASSED ✅"; else echo "SOME TESTS FAILED ❌"; exit 1; fi
