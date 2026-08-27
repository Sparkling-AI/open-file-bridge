#!/usr/bin/env bash
# Addon test: PDF text extraction + OCR, run against the stdlib bridge env.
# Usage: uv run --with pymupdf,rapidocr-onnxruntime bash tests/addon_test.sh
# (expects the e2e bridge already running on 8765 with addons, or starts its own)
set -euo pipefail
cd "$(dirname "$0")/.."

BRIDGE="http://127.0.0.1:8765"
TESTDIR=$(mktemp -d)

started_here=0
if ! curl -s -m 1 "$BRIDGE/health" >/dev/null 2>&1; then
  uv run --with pymupdf,rapidocr-onnxruntime python src/file_bridge.py "$TESTDIR" &
  BPID=$!
  started_here=1
  trap 'kill $BPID 2>/dev/null; rm -rf "$TESTDIR"' EXIT
  sleep 8
fi

fail=0
check() { if echo "$3" | grep -q "$2"; then echo "  PASS: $1"; else echo "  FAIL: $1 — got: $3"; fail=1; fi }

# make fixtures
python3 - <<PY
import fitz
doc = fitz.open(); page = doc.new_page()
page.insert_text((72, 72), "E2E INVOICE 997", fontname="helv", fontsize=12)
page.insert_text((72, 96), "Total: 44000 SEK", fontname="helv", fontsize=12)
doc.save("$TESTDIR/inv.pdf"); doc.close()
# scanned version (image only)
src = fitz.open("$TESTDIR/inv.pdf")
pix = src[0].get_pixmap(dpi=150)
d2 = fitz.open(); p2 = d2.new_page(width=595, height=842)
p2.insert_image(fitz.Rect(0,0,595,842), pixmap=pix)
d2.save("$TESTDIR/inv-scan.pdf"); d2.close(); src.close()
PY

check "addons enabled"   '"pdf": *true'   "$(curl -s $BRIDGE/health)"
T=$(curl -s "$BRIDGE/pdf_text?path=inv.pdf")
check "pdf_text extract" 'E2E INVOICE 997' "$T"
check "pdf_text total"   '44000 SEK'       "$T"

O=$(curl -s -m 120 "$BRIDGE/ocr?path=inv-scan.pdf")
check "ocr scanned pdf"  'INVOICE'         "$O"
check "ocr amount"       '44000'           "$O"

# make standalone image fixture
python3 - <<PY
import fitz
src = fitz.open("$TESTDIR/inv.pdf")
src[0].get_pixmap(dpi=150).save("$TESTDIR/inv.png")
src.close()
PY
OI=$(curl -s -m 60 "$BRIDGE/ocr?path=inv.png")
check "ocr image"        'INVOICE'         "$OI"

check "pdf_text traversal" 'escapes'       "$(curl -s "$BRIDGE/pdf_text?path=../../etc/passwd")"
check "ocr traversal"      'escapes'       "$(curl -s "$BRIDGE/ocr?path=/etc/shadow")"

echo
if [[ $fail -eq 0 ]]; then echo "ALL ADDON TESTS PASSED ✅"; else echo "SOME ADDON TESTS FAILED ❌"; exit 1; fi
