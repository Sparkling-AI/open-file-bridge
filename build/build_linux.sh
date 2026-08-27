#!/usr/bin/env bash
# File Bridge — Linux build (plain PyInstaller onefile) or run directly.
# Linux users can run the Python script directly (python3 is preinstalled
# on virtually every distro), so the binary is a convenience, not a requirement.
#
#   ./build_linux.sh              -> dist/FileBridge (on-Linux binary)
#   ./build_linux.sh --container  -> build inside an old glibc container for
#                                    maximum compatibility (needs docker)

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--container" ]]; then
  # Build against CentOS 7-era glibc (2.17) so the binary runs on old distros too.
  docker run --rm -v "$PWD":/src -w /src python:3.11-slim bash -c '
    pip install --quiet pyinstaller &&
    pyinstaller --onefile --clean --name FileBridge \
      --exclude-module tkinter --exclude-module unittest \
      src/file_bridge.py &&
    chmod +x dist/FileBridge'
else
  pip install --quiet pyinstaller
  pyinstaller --onefile --clean --name FileBridge \
    --exclude-module tkinter --exclude-module unittest \
    src/file_bridge.py
fi

echo
echo "Built: $(ls -lh dist/FileBridge | awk '{print $5, $9}')"
echo "Smoke test:"
./dist/FileBridge --smoke-test 2>/dev/null || \
  (./dist/FileBridge /tmp &
   sleep 1; curl -s http://127.0.0.1:8765/health && kill %1)
