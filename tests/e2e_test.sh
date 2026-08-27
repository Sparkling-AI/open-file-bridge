#!/usr/bin/env bash
# End-to-end test: starts the bridge, exercises every endpoint incl. security checks.
# Run:  ./tests/e2e_test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BRIDGE="http://127.0.0.1:8765"
TESTDIR=$(mktemp -d)
echo "test content $(date)" > "$TESTDIR/notes.txt"
mkdir -p "$TESTDIR/sub" && echo "nested" > "$TESTDIR/sub/n.txt"

export HOME_BACKUP="$HOME"
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

echo
if [[ $fail -eq 0 ]]; then echo "ALL TESTS PASSED ✅"; else echo "SOME TESTS FAILED ❌"; exit 1; fi
