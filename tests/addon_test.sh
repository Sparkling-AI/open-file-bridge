#!/usr/bin/env bash
# Addon test: PDF text extraction + OCR, run against the stdlib bridge env.
# Usage: uv run --with pymupdf bash tests/addon_test.sh
#        (OCR additionally needs a tesseract binary; TESSERACT_CMD to point at it)
# (expects the e2e bridge already running on 8765 with addons, or starts its own)
set -euo pipefail
cd "$(dirname "$0")/.."

BRIDGE="http://127.0.0.1:8765"
TESTDIR=$(mktemp -d)
STATEDIR=$(mktemp -d)

started_here=0
if ! curl -s -m 1 "$BRIDGE/health" >/dev/null 2>&1; then
  FILE_BRIDGE_STATE_DIR="$STATEDIR" uv run --with pymupdf python src/file_bridge.py "$TESTDIR" &
  BPID=$!
  started_here=1
  trap 'kill $BPID 2>/dev/null; rm -rf "$TESTDIR" "$STATEDIR"' EXIT
  sleep 8
  # security gate (v2): unlock file serving by locking an origin
  curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' \
       -d '{"allowed_origin":"http://owui.test:8080"}' >/dev/null
fi

fail=0
check() { if echo "$3" | grep -q "$2"; then echo "  PASS: $1"; else echo "  FAIL: $1 — got: $3"; fail=1; fi }

# make fixtures
uv run --with pymupdf python - <<PY
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
uv run --with pymupdf python - <<PY
import fitz
src = fitz.open("$TESTDIR/inv.pdf")
src[0].get_pixmap(dpi=150).save("$TESTDIR/inv.png")
src.close()
PY
OI=$(curl -s -m 60 "$BRIDGE/ocr?path=inv.png")
check "ocr image"        'INVOICE'         "$OI"

# language handling
CFG=$(curl -s "$BRIDGE/ocr/config")
check "ocr config langs"  'eng'            "$CFG"
curl -s -X POST $BRIDGE/api/root -H 'Content-Type: application/json' -d '{"ocr_lang":"swe+eng"}' >/dev/null
check "ocr lang saved"    'swe+eng'        "$(curl -s "$BRIDGE/ocr/config")"
check "ocr lang used"     'swe+eng'        "$(curl -s -m 60 "$BRIDGE/ocr?path=inv-scan.pdf")"

check "pdf_text traversal" 'escapes'       "$(curl -s "$BRIDGE/pdf_text?path=../../etc/passwd")"
check "ocr traversal"      'escapes'       "$(curl -s "$BRIDGE/ocr?path=../../etc/shadow")"
check "ocr absolute path"  'not allowed'   "$(curl -s "$BRIDGE/ocr?path=/etc/shadow")"

# ---------- content-hash cache (P2) ----------
T2=$(curl -s "$BRIDGE/pdf_text?path=inv.pdf")
check "cache miss first"   'E2E INVOICE 997' "$T2"
T3=$(curl -s "$BRIDGE/pdf_text?path=inv.pdf")
check "cache hit second"   'E2E INVOICE 997' "$T3"
check "cache hit flagged"  '"cached": *true'  "$T3"
# modified file → different sha256 → miss again
python3 - <<PY
import fitz
doc = fitz.open("$TESTDIR/inv.pdf")
doc[0].insert_text((72, 120), "REVISED TOTAL 55000", fontname="helv", fontsize=12)
doc.saveIncr()
doc.close()
PY
T4=$(curl -s "$BRIDGE/pdf_text?path=inv.pdf")
check "cache invalidates on change" 'REVISED TOTAL 55000' "$T4"
if echo "$T4" | grep -q '"cached": *true'; then echo "  FAIL: stale cache served after edit"; fail=1; else echo "  PASS: no stale cache after edit"; fi
# ocr cache: second identical call hits
O2=$(curl -s -m 120 "$BRIDGE/ocr?path=inv-scan.pdf")
O3=$(curl -s -m 120 "$BRIDGE/ocr?path=inv-scan.pdf")
check "ocr cache hit"      '"cached": *true'  "$O3"
check "ocr cache content"  'INVOICE'          "$O3"
# different params → different cache key → fresh compute (no cached flag)
O4=$(curl -s -m 120 "$BRIDGE/ocr?path=inv-scan.pdf&dpi=150")
if echo "$O4" | grep -q '"cached": *true'; then echo "  FAIL: params ignored in cache key"; fail=1; else echo "  PASS: params part of cache key"; fi

echo
if [[ $fail -eq 0 ]]; then echo "ALL ADDON TESTS PASSED ✅"; else echo "SOME ADDON TESTS FAILED ❌"; exit 1; fi
