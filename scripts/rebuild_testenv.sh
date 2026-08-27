#!/usr/bin/env bash
# Rebuild the complete local test environment from scratch (idempotent).
# Use after a reboot, docker cleanup, or in a fresh session.
#
#   bash scripts/rebuild_testenv.sh          # everything incl. OWUI container
#   bash scripts/rebuild_testenv.sh --no-owui # bridge fixtures only
#
# Brings up:
#   1. Open WebUI v0.11.x container on 127.0.0.1:8788 (admin/test-admin-pass-123)
#      + model connection (Z.AI via ~/.hermes/.env GLM_API_KEY)
#      + public skill + Local Files Assistant preset (via setup_owui.py)
#   2. Test fixture folder /tmp/owui-demo-files with txt/pdf/scans/office files
#   3. Tesseract hint (persistent copy expected at ~/tools/tesseract-5.3.4)
#
# Leaves the OWUI container running; prints connection info at the end.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

OWUI_PORT=8788
OWUI_CONTAINER=owui-test
FIXDIR=/tmp/owui-demo-files
TESS=~/tools/tesseract-5.3.4

say() { echo -e "\e[1;36m[rebuild]\e[0m $*"; }

# ---------- 1. fixtures ----------
say "fixtures: $FIXDIR"
mkdir -p "$FIXDIR/docs" "$FIXDIR/projects/alpha" "$FIXDIR/reports"
echo "hello from local disk - fixture $(date)" > "$FIXDIR/notes.txt"
echo "project alpha config" > "$FIXDIR/projects/alpha/config.txt"

if command -v uv >/dev/null; then
  uv run --with pymupdf python - <<'PY' 2>/dev/null || say "WARN: pymupdf unavailable, PDF fixtures skipped"
import fitz, os
D = "/tmp/owui-demo-files/docs"
# text-layer invoice
doc = fitz.open(); page = doc.new_page()
lines = ['INVOICE #2026-084', '', 'From: Acme Consulting AB', 'Box 123, 114 23 Stockholm',
         '', 'Item                    Qty   Price   Total',
         'Consulting hours        12    950    11400', 'Travel expenses          -     -       1850',
         '', 'TOTAL (excl VAT)               13250', 'VAT 25%                         3312.50',
         'TOTAL (incl VAT)               16562.50', '', 'Payment terms: 30 days net', 'BG: 123-4567']
y = 72
for ln in lines:
    page.insert_text((72, y), ln, fontname='helv', fontsize=11); y += 16
doc.save(f"{D}/invoice.pdf"); doc.close()
# scanned (image-only) variant
src = fitz.open(f"{D}/invoice.pdf"); pix = src[0].get_pixmap(dpi=150)
d2 = fitz.open(); p2 = d2.new_page(width=595, height=842)
p2.insert_image(fitz.Rect(0,0,595,842), pixmap=pix)
d2.save(f"{D}/invoice-scanned.pdf"); d2.close(); src.close()
# Swedish faktura scan
doc = fitz.open(); page = doc.new_page()
for i, ln in enumerate(['FAKTURA 2026-099','','Betalningsvillkor: 30 dagar netto',
                        'Org.nr: 556677-8899','Moms 25% ingår i priset','Totalt att betala: 12 345 kr']):
    page.insert_text((72, 72+i*16), ln, fontname='helv', fontsize=11)
doc.save(f"{D}/faktura.pdf"); doc.close()
src = fitz.open(f"{D}/faktura.pdf"); pix = src[0].get_pixmap(dpi=150)
d2 = fitz.open(); p2 = d2.new_page(width=595, height=842)
p2.insert_image(fitz.Rect(0,0,595,842), pixmap=pix)
d2.save(f"{D}/faktura-scan.pdf"); d2.close(); src.close()
# Chinese scan (needs CJK font)
cjk = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"
if os.path.exists(cjk):
    doc = fitz.open(); page = doc.new_page()
    page.insert_font(fontname='cjk', fontfile=cjk)
    for i, ln in enumerate(['发票号码: 2026-084','合计金额: 16,562.50 元','付款期限: 30天']):
        page.insert_text((72, 72+i*22), ln, fontname='cjk', fontsize=14)
    doc.save(f"{D}/fapiao.pdf"); doc.close()
    src = fitz.open(f"{D}/fapiao.pdf"); pix = src[0].get_pixmap(dpi=200)
    d2 = fitz.open(); p2 = d2.new_page(width=595, height=842)
    p2.insert_image(fitz.Rect(0,0,595,842), pixmap=pix)
    d2.save(f"{D}/fapiao-scan.pdf"); d2.close(); src.close()
print("PDF fixtures OK")
PY
else
  say "WARN: uv not found — PDF fixtures skipped"
fi

# ---------- 2. tesseract ----------
if [ -x "$TESS/usr/bin/tesseract" ]; then
  say "tesseract OK at ~/tools/tesseract-5.3.4 (langs: $(ls $TESS/usr/share/tesseract-ocr/5/tessdata/*.traineddata | wc -l))"
else
  say "tesseract NOT at ~/tools — OCR tests will fail. Install with:"
  say "  see docs/DEVNOTES.md §tesseract"
fi

# ---------- 3. OWUI ----------
if [[ "${1:-}" == "--no-owui" ]]; then
  say "skip OWUI (--no-owui)"
else
  if docker ps --format '{{.Names}}' | grep -q "^$OWUI_CONTAINER$"; then
    say "OWUI container already running"
  else
    docker rm -f "$OWUI_CONTAINER" 2>/dev/null || true
    say "starting OWUI container on 127.0.0.1:$OWUI_PORT (image pull if needed)…"
    docker run -d --name "$OWUI_CONTAINER" -p 127.0.0.1:$OWUI_PORT:8080 \
      -e WEBUI_SECRET_KEY=owui-test-secret \
      -v ${OWUI_CONTAINER}-data:/app/backend/data \
      ghcr.io/open-webui/open-webui:main >/dev/null
    for i in $(seq 1 40); do
      curl -s -m 2 "http://127.0.0.1:$OWUI_PORT/api/version" >/dev/null 2>&1 && break
      sleep 3
    done
    curl -s "http://127.0.0.1:$OWUI_PORT/api/version" >/dev/null 2>&1 || { say "OWUI failed to start"; exit 1; }
    say "OWUI up: $(curl -s http://127.0.0.1:$OWUI_PORT/api/version)"
  fi

  # admin account (first-run creates; later runs just sign in)
  curl -s -X POST "http://127.0.0.1:$OWUI_PORT/api/v1/auths/signup" \
    -H 'Content-Type: application/json' \
    -d '{"name":"Admin","email":"admin@test.local","password":"test-admin-pass-123"}' >/dev/null || true

  # model connection: needs GLM_API_KEY (Z.AI coding endpoint)
  GLM_KEY=$(grep '^GLM_API_KEY=' ~/.hermes/.env 2>/dev/null | head -1 | cut -d= -f2 || true)
  if [ -n "$GLM_KEY" ]; then
    TOK=$(curl -s -X POST "http://127.0.0.1:$OWUI_PORT/api/v1/auths/signin" \
      -H 'Content-Type: application/json' \
      -d '{"email":"admin@test.local","password":"test-admin-pass-123"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
    curl -s -X POST "http://127.0.0.1:$OWUI_PORT/openai/config/update" \
      -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
      -d "{\"ENABLE_OPENAI_API\":true,\"OPENAI_API_BASE_URLS\":[\"https://api.z.ai/api/coding/paas/v4\"],\"OPENAI_API_KEYS\":[\"$GLM_KEY\"],\"OPENAI_API_CONFIGS\":{}}" >/dev/null
    say "model connection configured (Z.AI coding endpoint)"
  else
    say "WARN: GLM_API_KEY not in ~/.hermes/.env — configure model manually"
  fi

  python3 scripts/setup_owui.py --url "http://127.0.0.1:$OWUI_PORT" \
    --email admin@test.local --password test-admin-pass-123 \
    --base-model glm-5.3-flash
fi

say "environment ready:"
echo "  OWUI:        http://127.0.0.1:8788  (admin@test.local / test-admin-pass-123)"
echo "  fixtures:    $FIXDIR"
echo "  tesseract:   ~/tools/tesseract-5.3.4"
echo ""
echo "Start the bridge for manual testing:"
echo "  TESSERACT_CMD=\$HOME/tools/tesseract-5.3.4/usr/bin/tesseract \\"
echo "  LD_LIBRARY_PATH=\$HOME/tools/tesseract-5.3.4/usr/lib \\"
echo "  uv run --with pymupdf python src/file_bridge.py $FIXDIR"
