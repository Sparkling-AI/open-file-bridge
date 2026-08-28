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
  FILE_BRIDGE_STATE_DIR="$STATEDIR" uv run --with pymupdf --with fpdf2 python src/file_bridge.py "$TESTDIR" &
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

# ---------- /ocr_pdf (P2 searchable PDF) ----------
echo "not a scan" > "$TESTDIR/loose.txt"
J() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get(sys.argv[1],''))" "$2" <<<"$1"; }
# no token → 409 confirmation
P1=$(curl -s -m 20 -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"inv-scan.pdf","out":"inv-searchable.pdf"}')
check "ocr_pdf needs confirmation" 'confirmation_required' "$P1"
TOKEN1=$(J "$P1" confirmation_token)
# changed payload (different out) → 400, token burned
P1b=$(curl -s -m 20 -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"inv-scan.pdf","out":"inv-searchable2.pdf","confirmation_token":"'"$TOKEN1"'"}')
check "ocr_pdf changed payload burns token" 'request parameters do not match\|invalid or expired' "$P1b"
# fresh 409 → correct confirm → searchable pdf
P1=$(curl -s -m 20 -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"inv-scan.pdf","out":"inv-searchable.pdf"}')
TOKEN1=$(J "$P1" confirmation_token)
P2=$(curl -s -m 120 -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"inv-scan.pdf","out":"inv-searchable.pdf","confirmation_token":"'"$TOKEN1"'","lang":"eng"}')
check "ocr_pdf writes ok"        '"ok": *true'      "$P2"
check "ocr_pdf page count"       '"pages": *1'      "$P2"
check "ocr_pdf has snapshot key" 'snapshot'         "$P2"
head -c 5 "$TESTDIR/inv-searchable.pdf" | grep -q '%PDF-' && echo "  PASS: ocr_pdf output is a PDF" || { echo "  FAIL: not a PDF"; fail=1; }
# output now has a REAL text layer: /pdf_text can read it back
SRCH=$(curl -s "$BRIDGE/pdf_text?path=inv-searchable.pdf")
check "searchable pdf text layer" 'INVOICE'         "$SRCH"
# source is untouched
SRCC=$(curl -s "$BRIDGE/pdf_text?path=inv-scan.pdf")
if echo "$SRCC" | grep -q 'INVOICE'; then echo "  FAIL: source mutated"; fail=1; else echo "  PASS: source untouched"; fi
# image input
P3=$(curl -s -m 20 -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"inv.png","out":"img-searchable.pdf"}')
TOKEN3=$(J "$P3" confirmation_token)
P4=$(curl -s -m 120 -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"inv.png","out":"img-searchable.pdf","confirmation_token":"'"$TOKEN3"'"}')
check "ocr_pdf image input"      '"pages": *1'      "$P4"
# overwrite needs a SECOND confirmation (existing target)
P5=$(curl -s -m 20 -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"inv-scan.pdf","out":"inv-searchable.pdf"}')
check "ocr_pdf overwrite confirmed" 'confirmation_required' "$P5"
# policy errors
check "ocr_pdf wrong ext"    'supports images and PDF' "$(curl -s -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"loose.txt","out":"x.pdf"}')"
check "ocr_pdf bad out ext"  'must end in .pdf'  "$(curl -s -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"inv.png","out":"x.txt"}')"
check "ocr_pdf traversal"    'escapes'           "$(curl -s -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"../../etc/passwd","out":"x.pdf"}')"
check "ocr_pdf missing src"  'no such file'      "$(curl -s -X POST $BRIDGE/ocr_pdf -H 'Content-Type: application/json' -d '{"path":"ghost.png","out":"x.pdf"}')"

# ---------- /pdf_text?mode=images (P2 vision mode) ----------
IM=$(curl -s -m 60 "$BRIDGE/pdf_text?path=inv.pdf&mode=images")
check "images mode pages"     '"page_count": *1'  "$IM"
check "images mode rendered"  '"rendered": *1'    "$IM"
check "images mode has b64"   'png_b64'           "$IM"
# PNG magic inside the base64 (verifies the hand-rolled encoder)
if echo "$IM" | python3 -c "import json,sys,base64; d=json.load(sys.stdin); b=base64.b64decode(d['pages'][0]['png_b64']); sys.exit(0 if b[:8]==b'\x89PNG\r\n\x1a\n' else 1)"; then echo "  PASS: images mode valid PNG"; else echo "  FAIL: images mode bad PNG"; fail=1; fi
# page selection works in images mode too
IM2=$(curl -s -m 60 "$BRIDGE/pdf_text?path=inv.pdf&mode=images&max_pages=1")
check "images mode max_pages" '"rendered": *1'    "$IM2"
# cache: second identical call is a hit
IM3=$(curl -s -m 60 "$BRIDGE/pdf_text?path=inv.pdf&mode=images")
check "images cache hit"      '"cached": *true'   "$IM3"
# text mode unaffected (no png_b64 key)
if curl -s "$BRIDGE/pdf_text?path=inv.pdf" | grep -q png_b64; then echo "  FAIL: text mode leaked images"; fail=1; else echo "  PASS: text mode unaffected"; fi

# ---------- office writes: /docx_merge + /pptx_from_template (P2) ----------
if command -v uv >/dev/null; then
  # fixtures: template docx with placeholders, pptx template deck
  uv run --with python-docx --with python-pptx python3 - "$TESTDIR" <<'PYEOF'
import sys, pathlib
d = pathlib.Path(sys.argv[1])
from docx import Document
doc = Document()
doc.add_heading("Contract {{client_name}}", 0)
doc.add_paragraph("Dear {{client_name}}, your total is {{amount}} SEK.")
doc.save(d / "template.docx")
from pptx import Presentation
prs = Presentation()
s1 = prs.slides.add_slide(prs.slide_layouts[0])
s1.shapes.title.text = "{{report_title}}"
s1.placeholders[1].text = "Prepared for {{client_name}}"
prs.save(d / "deck-template.pptx")
print("fixtures ok")
PYEOF
  # docx_merge happy path
  DM=$(curl -s -m 20 -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"contract-filled.docx","values":{"client_name":"Acme AB","amount":"12500"}}')
  check "docx_merge needs confirmation" 'confirmation_required' "$DM"
  TOK=$(J "$DM" confirmation_token)
  DM2=$(curl -s -m 20 -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"contract-filled.docx","values":{"client_name":"Acme AB","amount":"12500"},"confirmation_token":"'"$TOK"'"}')
  check "docx_merge ok"          '"ok": *true'   "$DM2"
  # verify content via /docx_read (stdlib reader works without the lib)
  DR=$(curl -s "$BRIDGE/docx_read?path=contract-filled.docx")
  check "docx_merge filled name"   'Acme AB'      "$DR"
  check "docx_merge filled amount" '12500 SEK'    "$DR"
  # unfilled placeholder reported (non-strict leaves {{x}} in text)
  DM3=$(curl -s -m 20 -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"partial.docx","values":{"client_name":"Beta"}}')
  TOK=$(J "$DM3" confirmation_token)
  DM4=$(curl -s -m 20 -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"partial.docx","values":{"client_name":"Beta"},"confirmation_token":"'"$TOK"'"}')
  check "docx_merge reports missing" '"missing": *\["amount"\]' "$DM4"
  # strict mode refuses
  DM5=$(curl -s -m 20 -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"partial2.docx","values":{"client_name":"Beta"},"strict":true}')
  TOK=$(J "$DM5" confirmation_token)
  DM6=$(curl -s -m 20 -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"partial2.docx","values":{"client_name":"Beta"},"strict":true,"confirmation_token":"'"$TOK"'"}')
  check "docx_merge strict blocks"  'unresolved placeholders' "$DM6"
  if [ -f "$TESTDIR/partial2.docx" ]; then echo "  FAIL: strict wrote the file"; fail=1; else echo "  PASS: strict wrote nothing"; fi
  # policy errors
  check "docx_merge bad out ext" 'must end in .docx' "$(curl -s -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"x.pdf","values":{}}')"
  check "docx_merge wrong src"   'must be .docx'     "$(curl -s -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"inv.png","out":"x.docx","values":{}}')"
  check "docx_merge missing src" 'no such file'      "$(curl -s -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"ghost.docx","out":"x.docx","values":{}}')"
  check "docx_merge traversal"   'escapes'           "$(curl -s -X POST $BRIDGE/docx_merge -H 'Content-Type: application/json' -d '{"path":"../../etc/passwd","out":"x.docx","values":{}}')"

  # pptx_from_template
  PT=$(curl -s -m 20 -X POST $BRIDGE/pptx_from_template -H 'Content-Type: application/json' -d '{"path":"deck-template.pptx","out":"deck-out.pptx","values":{"report_title":"Q4 Wrap","client_name":"Acme AB"},"slides":[{"layout":1,"title":"Agenda","body":"One\nTwo"}]}')
  check "pptx_template needs confirmation" 'confirmation_required' "$PT"
  TOK=$(J "$PT" confirmation_token)
  PT2=$(curl -s -m 20 -X POST $BRIDGE/pptx_from_template -H 'Content-Type: application/json' -d '{"path":"deck-template.pptx","out":"deck-out.pptx","values":{"report_title":"Q4 Wrap","client_name":"Acme AB"},"slides":[{"layout":1,"title":"Agenda","body":"One\nTwo"}],"confirmation_token":"'"$TOK"'"}')
  check "pptx_template ok"        '"ok": *true'      "$PT2"
  check "pptx_template added"     '"slides_added": *1' "$PT2"
  PR=$(curl -s "$BRIDGE/pptx_read?path=deck-out.pptx")
  check "pptx_template filled title" 'Q4 Wrap'       "$PR"
  check "pptx_template filled body"  'Acme AB'       "$PR"
  check "pptx_template new slide"    'Agenda'        "$PR"
  check "pptx_template slide count"  '"slide_count": *2' "$PR"
  check "pptx_template bad layout"   'bad layout index' "$(curl -s -X POST $BRIDGE/pptx_from_template -H 'Content-Type: application/json' -d '{"path":"deck-template.pptx","out":"d2.pptx","slides":[{"layout":99}]}')"
  check "pptx_template wrong src"    'must be .potx or .pptx' "$(curl -s -X POST $BRIDGE/pptx_from_template -H 'Content-Type: application/json' -d '{"path":"inv.png","out":"x.pptx"}')"
  check "pptx_template traversal"    'escapes'       "$(curl -s -X POST $BRIDGE/pptx_from_template -H 'Content-Type: application/json' -d '{"path":"../../etc/passwd","out":"x.pptx"}')"

  # ---------- structured writes: /pdf_from_text /docx_write /xlsx_append (P3) ----------
  # pdf_from_text happy path (confirm flow first)
  PF=$(curl -s -m 20 -X POST $BRIDGE/pdf_from_text -H 'Content-Type: application/json' -d '{"out":"from-text.pdf","title":"Test Doc","blocks":[{"style":"title","text":"Quarterly Report"},{"style":"h1","text":"Summary"},{"style":"body","text":"Revenue is up 17% this quarter — arrows → and åäö survive latin-1 mapping."},{"style":"pagebreak"},{"style":"body","text":"Page two body."}]}')
  check "pdf_from_text needs confirmation" 'confirmation_required' "$PF"
  TOK=$(J "$PF" confirmation_token)
  PF2=$(curl -s -m 20 -X POST $BRIDGE/pdf_from_text -H 'Content-Type: application/json' -d '{"out":"from-text.pdf","title":"Test Doc","blocks":[{"style":"title","text":"Quarterly Report"},{"style":"h1","text":"Summary"},{"style":"body","text":"Revenue is up 17% this quarter — arrows → and åäö survive latin-1 mapping."},{"style":"pagebreak"},{"style":"body","text":"Page two body."}],"confirmation_token":"'"$TOK"'"}')
  check "pdf_from_text ok"        '"ok": *true'      "$PF2"
  check "pdf_from_text blocks"    '"blocks": *5'     "$PF2"
  # it IS a real PDF: bridge's own /pdf_text reads it back
  PT=$(curl -s "$BRIDGE/pdf_text?path=from-text.pdf")
  check "pdf_from_text readable"  'Quarterly Report' "$PT"
  check "pdf_from_text page 2"    'Page two body'    "$PT"
  check "pdf_from_text sanitize"  'arrows ->'        "$PT"
  # page_size letter + policy errors
  PF3=$(curl -s -X POST $BRIDGE/pdf_from_text -H 'Content-Type: application/json' -d '{"out":"letter.pdf","page_size":"letter","blocks":[{"style":"body","text":"x"}]}')
  TOK=$(J "$PF3" confirmation_token)
  PF4=$(curl -s -X POST $BRIDGE/pdf_from_text -H 'Content-Type: application/json' -d '{"out":"letter.pdf","page_size":"letter","blocks":[{"style":"body","text":"x"}],"confirmation_token":"'"$TOK"'"}')
  check "pdf_from_text letter"    '"page_size": *"letter"' "$PF4"
  check "pdf_from_text bad ext"   'need out'  "$(curl -s -X POST $BRIDGE/pdf_from_text -H 'Content-Type: application/json' -d '{"out":"x.txt","blocks":[]}')"
  check "pdf_from_text bad style" 'unknown style\|each block' "$(curl -s -X POST $BRIDGE/pdf_from_text -H 'Content-Type: application/json' -d '{"out":"x.pdf","blocks":[{"style":"h5","text":"x"}]}')"
  check "pdf_from_text bad size"  'page_size must be' "$(curl -s -X POST $BRIDGE/pdf_from_text -H 'Content-Type: application/json' -d '{"out":"x.pdf","page_size":"a3","blocks":[{"style":"body","text":"x"}]}')"

  # docx_write happy path
  DW=$(curl -s -m 20 -X POST $BRIDGE/docx_write -H 'Content-Type: application/json' -d '{"out":"sections.docx","title":"Spec","sections":[{"style":"h1","text":"Overview"},{"style":"paragraph","text":"Some intro text."},{"style":"list","items":["first","second"]},{"style":"numbered","items":["step one","step two"]},{"style":"pagebreak"},{"style":"h2","text":"After break"}]}')
  check "docx_write needs confirmation" 'confirmation_required' "$DW"
  TOK=$(J "$DW" confirmation_token)
  DW2=$(curl -s -m 20 -X POST $BRIDGE/docx_write -H 'Content-Type: application/json' -d '{"out":"sections.docx","title":"Spec","sections":[{"style":"h1","text":"Overview"},{"style":"paragraph","text":"Some intro text."},{"style":"list","items":["first","second"]},{"style":"numbered","items":["step one","step two"]},{"style":"pagebreak"},{"style":"h2","text":"After break"}],"confirmation_token":"'"$TOK"'"}')
  check "docx_write ok"           '"ok": *true'      "$DW2"
  DR=$(curl -s "$BRIDGE/docx_read?path=sections.docx")
  check "docx_write title"        'Spec'             "$DR"
  check "docx_write bullet item"  'first'            "$DR"
  check "docx_write numbered"     'step one'         "$DR"
  check "docx_write after break"  'After break'      "$DR"
  check "docx_write bad ext"      'need out'  "$(curl -s -X POST $BRIDGE/docx_write -H 'Content-Type: application/json' -d '{"out":"x.pdf","sections":[]}')"
  check "docx_write bad style"    'each section' "$(curl -s -X POST $BRIDGE/docx_write -H 'Content-Type: application/json' -d '{"out":"x.docx","sections":[{"style":"h5","text":"x"}]}')"

  # xlsx_append: create-then-append round trip via /xlsx_read
  XA=$(curl -s -m 20 -X POST $BRIDGE/xlsx_append -H 'Content-Type: application/json' -d '{"path":"log.xlsx","header":["when","event"],"rows":[["2026-08-28","created"],["2026-08-28","row2"]]}')
  check "xlsx_append create ok (no confirm for new file)" '"ok": *true'  "$XA"
  check "xlsx_append created"     '"created": *true' "$XA"
  XA2=$(curl -s -m 20 -X POST $BRIDGE/xlsx_append -H 'Content-Type: application/json' -d '{"path":"log.xlsx","rows":[["2026-08-29","appended"]]}')
  check "xlsx_append existing needs confirm" 'confirmation_required' "$XA2"
  TOK=$(J "$XA2" confirmation_token)
  XA3=$(curl -s -m 20 -X POST $BRIDGE/xlsx_append -H 'Content-Type: application/json' -d '{"path":"log.xlsx","rows":[["2026-08-29","appended"]],"confirmation_token":"'"$TOK"'"}')
  check "xlsx_append ok"          '"rows_appended": *1' "$XA3"
  XR=$(curl -s "$BRIDGE/xlsx_read?path=log.xlsx")
  check "xlsx_append row landed"  'appended'         "$XR"
  check "xlsx_append row_count"   '"row_count": *4'  "$XR"
  # sheet targeting + policy
  XA4=$(curl -s -m 20 -X POST $BRIDGE/xlsx_append -H 'Content-Type: application/json' -d '{"path":"log.xlsx","sheet":"Archive","rows":[["x"]]}')
  TOK=$(J "$XA4" confirmation_token)
  XA5=$(curl -s -m 20 -X POST $BRIDGE/xlsx_append -H 'Content-Type: application/json' -d '{"path":"log.xlsx","sheet":"Archive","rows":[["x"]],"confirmation_token":"'"$TOK"'"}')
  check "xlsx_append new sheet"   '"sheet": *"Archive"' "$XA5"
  check "xlsx_append bad ext"     'need path'  "$(curl -s -X POST $BRIDGE/xlsx_append -H 'Content-Type: application/json' -d '{"path":"x.xls","rows":[["x"]]}')"
  check "xlsx_append dict cell"   'flat list'  "$(curl -s -X POST $BRIDGE/xlsx_append -H 'Content-Type: application/json' -d '{"path":"x2.xlsx","rows":[{"k":"v"}]}')"
  check "xlsx_append no rows"     'rows must be' "$(curl -s -X POST $BRIDGE/xlsx_append -H 'Content-Type: application/json' -d '{"path":"x2.xlsx","rows":[]}')"


  # ---------- /docx_mailmerge: docx template + rows -> batch (P3) ----------
  # rows file fixture: xlsx with header row
  uv run --with openpyxl python3 - "$TESTDIR" <<'PYEOF'
import sys, pathlib
import openpyxl
d = pathlib.Path(sys.argv[1])
wb = openpyxl.Workbook(); ws = wb.active
ws.append(["name", "amount", "city"])
ws.append(["Acme AB", "12500", "Stockholm"])
ws.append(["Beta LLC", "9900", "Goteborg"])
wb.save(d / "clients.xlsx"); wb.close()
# csv variant
(d / "clients.csv").write_text("name,amount,city\nGamma AB,7000,Malmo\n", encoding="utf-8")
print("merge fixtures ok")
PYEOF
  # inline rows, loose outputs via name pattern
  MM=$(curl -s -m 30 -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"merged/{{client_name}}-contract.docx","rows":[{"client_name":"Acme AB","amount":"12500"},{"client_name":"Beta LLC","amount":"9900"}]}')
  check "mailmerge needs confirmation" 'confirmation_required' "$MM"
  TOK=$(J "$MM" confirmation_token)
  check "mailmerge preview count"     '"documents": *2' "$MM"
  MM2=$(curl -s -m 30 -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"merged/{{client_name}}-contract.docx","rows":[{"client_name":"Acme AB","amount":"12500"},{"client_name":"Beta LLC","amount":"9900"}],"confirmation_token":"'"$TOK"'"}')
  check "mailmerge ok"            '"ok": *true'        "$MM2"
  check "mailmerge doc count"     '"documents": *2'    "$MM2"
  DR=$(curl -s "$BRIDGE/docx_read?path=merged/Acme%20AB-contract.docx")
  check "mailmerge row1 filled"   'Acme AB'            "$DR"
  check "mailmerge row1 amount"   '12500 SEK'          "$DR"
  DR2=$(curl -s "$BRIDGE/docx_read?path=merged/Beta%20LLC-contract.docx")
  check "mailmerge row2 filled"   'Beta LLC'           "$DR2"
  # xlsx rows file
  MM3=$(curl -s -m 30 -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"fromxlsx/{{name}}.docx","rows":"clients.xlsx"}')
  TOK=$(J "$MM3" confirmation_token)
  MM4=$(curl -s -m 30 -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"fromxlsx/{{name}}.docx","rows":"clients.xlsx","confirmation_token":"'"$TOK"'"}')
  check "mailmerge xlsx ok"       '"documents": *2'    "$MM4"
  DR3=$(curl -s "$BRIDGE/docx_read?path=fromxlsx/Gamma%20AB.docx")
  check "mailmerge xlsx row"      'Gamma AB'           "$DR3"
  LS=$(curl -s "$BRIDGE/list?path=fromxlsx")
  check "mailmerge xlsx names"    'Acme AB.docx'       "$LS"
  # csv rows -> zip
  MM5=$(curl -s -m 30 -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"batch.zip","rows":"clients.csv"}')
  TOK=$(J "$MM5" confirmation_token)
  MM6=$(curl -s -m 30 -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"batch.zip","rows":"clients.csv","confirmation_token":"'"$TOK"'"}')
  check "mailmerge csv-zip ok"    '"ok": *true'        "$MM6"
  check "mailmerge zip doc count" '"documents": *1'    "$MM6"
  # policy errors
  check "mailmerge unresolved pattern" 'not present in the rows' "$(curl -s -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"{{nope}}.docx","rows":[{"client_name":"X"}]}')"
  check "mailmerge collision"     'collides' "$(curl -s -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"same.docx","rows":[{"client_name":"A"},{"client_name":"B"}]}')"
  check "mailmerge bad rows ext"  '.xlsx or .csv' "$(curl -s -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"x.zip","rows":"template.docx"}')"
  check "mailmerge bad out ext"   'must end in .docx' "$(curl -s -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"template.docx","out":"x.pdf","rows":[{"a":"b"}]}')"
  check "mailmerge wrong src"     'must be .docx' "$(curl -s -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"clients.xlsx","out":"x.zip"}')"
  check "mailmerge traversal"     'escapes' "$(curl -s -X POST $BRIDGE/docx_mailmerge -H 'Content-Type: application/json' -d '{"path":"../../etc/passwd","out":"x.zip"}')"


  # ---------- /pdf_op split|merge|rotate (P3) ----------
  # multi-page fixture
  uv run --with pymupdf python3 - "$TESTDIR" <<'PYEOF'
import sys, pathlib
import fitz
d = pathlib.Path(sys.argv[1])
doc = fitz.open()
for n in range(3):
    pg = doc.new_page()
    pg.insert_text((72, 72), f"PAGE {n+1}", fontname="helv", fontsize=14)
doc.save(d / "multi.pdf"); doc.close()
PYEOF
  # split
  SP=$(curl -s -X POST $BRIDGE/pdf_op -H 'Content-Type: application/json' -d '{"op":"split","paths":["multi.pdf"],"out":"chunk.pdf","pages":"1,3"}')
  check "pdf_op split"          '"pages_split": *2' "$SP"
  check "pdf_op split file1"    'chunk.p1.pdf'     "$SP"
  for f in chunk.p1.pdf chunk.p3.pdf; do
    if [ -f "$TESTDIR/$f" ]; then echo "  PASS: $f exists"; else echo "  FAIL: $f missing"; fail=1; fi
  done
  if [ -f "$TESTDIR/chunk.p2.pdf" ]; then echo "  FAIL: unselected page split out"; fail=1; else echo "  PASS: page 2 skipped"; fi
  SPV=$(curl -s "$BRIDGE/pdf_text?path=chunk.p2.pdf" 2>/dev/null || echo skip)
  # merge
  MG=$(curl -s -X POST $BRIDGE/pdf_op -H 'Content-Type: application/json' -d '{"op":"merge","paths":["chunk.p1.pdf","chunk.p3.pdf"],"out":"merged.pdf"}')
  check "pdf_op merge"          '"ok": *true'      "$MG"
  check "pdf_op merge pages"    '"pages": *2'      "$MG"
  MGV=$(curl -s "$BRIDGE/pdf_text?path=merged.pdf")
  check "merge order page1"     'PAGE 1'           "$MGV"
  check "merge order page3"     'PAGE 3'           "$MGV"
  if echo "$MGV" | grep -q 'PAGE 2'; then echo "  FAIL: page 2 leaked into merge"; fail=1; else echo "  PASS: merge only wanted pages"; fi
  # merge overwrite needs confirmation
  MG2=$(curl -s -X POST $BRIDGE/pdf_op -H 'Content-Type: application/json' -d '{"op":"merge","paths":["chunk.p1.pdf"],"out":"merged.pdf"}')
  check "pdf_op overwrite confirmed" 'confirmation_required' "$MG2"
  # rotate
  RT=$(curl -s -X POST $BRIDGE/pdf_op -H 'Content-Type: application/json' -d '{"op":"rotate","paths":["multi.pdf"],"out":"rot.pdf","angle":90,"pages":"1"}')
  check "pdf_op rotate"         '"pages_rotated": *1' "$RT"
  # rotation actually changed the page (mediabox rotates)
  python3 - "$TESTDIR" <<'PYEOF'
import sys, pathlib
import fitz
d = pathlib.Path(sys.argv[1])
a = fitz.open(d / "multi.pdf"); b = fitz.open(d / "rot.pdf")
try:
    assert b[0].rotation == (a[0].rotation + 90) % 360, "page 1 not rotated"
    assert b[1].rotation == a[1].rotation, "page 2 wrongly rotated"
    print("rotations verified")
finally:
    a.close(); b.close()
PYEOF
  if [ $? -eq 0 ]; then echo "  PASS: rotate verified"; else echo "  FAIL: rotation wrong"; fail=1; fi
  # policy errors
  check "pdf_op bad op"       'split\|merge\|rotate' "$(curl -s -X POST $BRIDGE/pdf_op -H 'Content-Type: application/json' -d '{"op":"shred","paths":["multi.pdf"],"out":"x.pdf"}')"
  check "pdf_op non-pdf src"  'must be .pdf'   "$(curl -s -X POST $BRIDGE/pdf_op -H 'Content-Type: application/json' -d '{"op":"split","paths":["loose.txt"],"out":"x.pdf"}')"
  check "pdf_op traversal"    'escapes'        "$(curl -s -X POST $BRIDGE/pdf_op -H 'Content-Type: application/json' -d '{"op":"split","paths":["../../etc/passwd"],"out":"x.pdf"}')"
  check "pdf_op angle 0"      'does nothing'   "$(curl -s -X POST $BRIDGE/pdf_op -H 'Content-Type: application/json' -d '{"op":"rotate","paths":["multi.pdf"],"out":"r2.pdf","angle":0}')"
  check "pdf_op split multi-input" 'takes exactly one' "$(curl -s -X POST $BRIDGE/pdf_op -H 'Content-Type: application/json' -d '{"op":"split","paths":["multi.pdf","merged.pdf"],"out":"x.pdf"}')"
fi

echo
if [[ $fail -eq 0 ]]; then echo "ALL ADDON TESTS PASSED ✅"; else echo "SOME ADDON TESTS FAILED ❌"; exit 1; fi
