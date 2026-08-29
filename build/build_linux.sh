#!/usr/bin/env bash
# Open File Bridge — Linux build (plain PyInstaller onefile) or run directly.
# Linux users can run the Python script directly (python3 is preinstalled
# on virtually every distro), so the binary is a convenience, not a requirement.
#
#   ./build_linux.sh              -> dist/OpenFileBridge (on-Linux binary)
#   ./build_linux.sh --container  -> build inside an old glibc container for
#                                    maximum compatibility (needs docker)

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--container" ]]; then
  # Build against CentOS 7-era glibc (2.17) so the binary runs on old distros too.
  docker run --rm -v "$PWD":/src -w /src python:3.11-slim bash -c '
    pip install --quiet pyinstaller &&
    pyinstaller --onefile --clean --name OpenFileBridge \
      --exclude-module tkinter --exclude-module unittest \
      src/file_bridge.py &&
    chmod +x dist/OpenFileBridge'
else
  pip install --quiet pyinstaller pymupdf
  pyinstaller --onefile --clean --name OpenFileBridge \
    --exclude-module tkinter --exclude-module unittest \
    --collect-all pymupdf --collect-all fitz \
    src/file_bridge.py
fi

echo
echo "Built: $(ls -lh dist/OpenFileBridge | awk '{print $5, $9}')"
echo "Smoke test:"
# The binary takes a folder arg only (no flags): launch it against a temp
# dir, poll /health, then stop it. tessdata/ + wheels/ must sit next to the
# exe for the full bundled layout (see BUILDING.md).
SMOKE_DIR=$(mktemp -d)
./dist/OpenFileBridge "$SMOKE_DIR" &
SMOKE_PID=$!
for _ in $(seq 1 20); do
  curl -s -m 1 http://127.0.0.1:8765/health >/dev/null 2>&1 && break
  sleep 0.5
done
curl -s http://127.0.0.1:8765/health && echo
kill "$SMOKE_PID" 2>/dev/null || true
# graceful shutdown takes a moment — wait it out so the port is free after
wait "$SMOKE_PID" 2>/dev/null || true
rm -rf "$SMOKE_DIR"
