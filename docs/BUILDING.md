# Building the Packages

Everything builds from `src/file_bridge.py` — a single stdlib-only Python
file (3.8+), so the "build" is just freezing it with PyInstaller per OS.

## Quick reference

| OS | Command | Output |
|---|---|---|
| Linux | `build/build_linux.sh` | `dist/FileBridge` (single binary) |
| Windows | `pyinstaller build/file_bridge_windows.spec` (on Windows) | `dist/FileBridge/FileBridge.exe` |
| Windows installer | Inno Setup on `build/installer_windows.iss` | `FileBridge-Setup.exe` |
| macOS | `pyinstaller --onefile --windowed --name FileBridge src/file_bridge.py` then `build/package_macos.sh` | `FileBridge-macos.zip` (.app inside) |
| All three (CI) | push a `v*` tag | GitHub Actions artifacts |

PyInstaller **cannot cross-compile** — build each OS on that OS (or use the
included GitHub Actions workflow, which is the easiest path: it produces all
three artifacts on tag push).

## Prerequisites

```bash
pip install pyinstaller        # on each build machine
```

## Linux

```bash
./build/build_linux.sh                # native build
./build/build_linux.sh --container    # build in python:3.11-slim docker
```

The container variant exists so the binary links against old glibc and runs on
older distros. Many Linux users can skip binaries entirely and run
`python3 src/file_bridge.py <folder>` — zero dependencies by design.

## Windows

On a Windows machine (or CI runner):

```powershell
pip install pyinstaller
cd build
pyinstaller --noconfirm file_bridge_windows.spec
```

- `console=False` — no black window pops up; it runs in the background.
- The exe **embeds `build/appicon.ico`** (7 sizes, 16–256 px, generated from
  `build/appicon.svg`) — Explorer, Taskbar and shortcuts show it. Regenerate
  alongside the `.icns` below; both come from the same SVG.
- Unsigned exe ⇒ SmartScreen "Windows protected your PC" on first run.
  Users click **More info → Run anyway**. An EV code-signing cert removes this.

Optional proper installer (Start-menu entry, uninstaller, desktop icon):

1. Install [Inno Setup](https://jrsoftware.org/isinfo.php)
2. Build the exe first (above)
3. Compile `build/installer_windows.iss` → `FileBridge-Setup.exe`

## macOS

On a Mac:

```bash
pip install pyinstaller
pyinstaller --onefile --windowed --name FileBridge src/file_bridge.py
./build/package_macos.sh              # -> FileBridge-macos.zip
```

`package_macos.sh` wraps the binary into a proper `.app` and zips it. It also
copies `src/wheels/` + `src/tessdata/` into the `.app` next to the executable,
so the frozen bridge serves all 8 office wheels and offers the bundled OCR
languages (eng/swe/chi_sim/osd) out of the box — verified on macOS 26/arm64:
`/health` reports `wheels: 8`, `addons: {pdf: true, ocr: true}`,
`ocr_langs_available: [chi_sim, eng, osd, swe]`.

The .app shows a **Dock icon while running** (2.4, user feedback): the binary
bootstraps NSApplication via ctypes (`CocoaDock` in src/file_bridge.py), so
Dock → Quit works too. Since 2.6.3 the bootstrap also installs an app
delegate, so **clicking the Dock icon (or re-opening the .app) opens the
settings page** in the browser, and a cold launch of the packaged app always
opens it once. Scripted/service contexts stay silent: launches with a folder
argument skip the auto-open, and `FILE_BRIDGE_NO_UI=1` (set by
scripts/install_service.py's units) suppresses every browser pop — set it
yourself when running the binary headless. Any bootstrap failure falls back
to plain background serving. The icon (`build/appicon.icns`) is committed;
to regenerate after editing its design:

```bash
# 1. edit build/appicon.svg (or your own 1024px SVG), then render + pack:
qlmanage -t -s 1024 -o /tmp build/appicon.svg          # -> /tmp/appicon.svg.png
mkdir /tmp/appicon.iconset
for pair in 16:icon_16x16.png 32:icon_16x16@2x.png 32:icon_32x32.png \
           64:icon_32x32@2x.png 128:icon_128x128.png 256:icon_128x128@2x.png \
           256:icon_256x256.png 512:icon_256x256@2x.png 512:icon_512x512.png \
           1024:icon_512x512@2x.png; do
  sips -z ${pair%%:*} ${pair%%:*} /tmp/appicon.svg.png \
        --out /tmp/appicon.iconset/${pair#*:} >/dev/null
done
iconutil -c icns -o build/appicon.icns /tmp/appicon.iconset
```

- Unsigned ⇒ Gatekeeper blocks first launch: **right-click → Open → Open** (once).
- With an Apple Developer ID ($99/yr):
  ```bash
  ./build/package_macos.sh --sign     # codesign + notarytool + staple
  ```
  (Edit the Developer ID string and keychain profile inside the script first.)
- Build on the **oldest macOS you support** — PyInstaller binaries run on newer
  macOS but not older ones.

## CI (recommended)

`.github/workflows/build.yml` builds **and smoke-tests** all three OSes
(health + frozen-addons checks; Windows artifacts get `wheels/` + `tessdata/`
layered in) on every `v*` tag:

```bash
git tag v1.0.0 && git push --tags
# → Actions → build → three artifacts ready to download
```

## Bundling the PDF/OCR add-ons (recommended for office deployments)

Two independent pieces:

**PDF** (`/pdf_text`, PDF page rendering for OCR): pure pip —

```bash
pip install pymupdf
pyinstaller ... --collect-all pymupdf ...
```

**OCR** (`/ocr`): the **tesseract binary**, not a pip package —

- **Windows — everything is in the Inno Setup installer.** Compile
  `build/installer_windows.iss`; it bundles the exe + `wheels/` + `tessdata/`
  + the tesseract engine itself (see PREP notes inside the script). The
  bridge auto-detects `{app}\tesseract\tesseract.exe` — the user needs
  nothing on PATH.
- Bundle `src/tessdata/` (eng/swe/chi_sim/osd, ~20 MB) **next to the bridge
  executable** — auto-detected, zero config.
- Other platforms: bundle a tesseract build as `tesseract/bin/tesseract`
  next to the exe, or set `TESSERACT_CMD`, or rely on system PATH
  (Linux distro package is fine).
- Extra languages WITHOUT touching the app package: drop `.traineddata`
  files from https://github.com/tesseract-ocr/tessdata_fast into the
  **user drop-in dir** — `~/Library/Application Support/file-bridge/tessdata/`
  (macOS), `~/.local/state/file-bridge/tessdata/` (Linux),
  `%APPDATA%\file-bridge\tessdata\` (Windows, or
  `%LOCALAPPDATA%\Programs\Open File Bridge\tessdata\` next to the exe).
  The bridge merges them with the bundled set at startup (restart to
  pick up new files); the settings page shows the exact path. Package
  size stays unchanged (~1-4 MB per extra language lives in user space).

**Frozen-build notes (verified on Linux with PyInstaller 6.22):**

- pymupdf is frozen into the binary via `--collect-all pymupdf --collect-all
  fitz` (the .spec files do this) → binary grows to ~82 MB, `/pdf_text` and
  PDF-page-rendering-for-OCR work with zero pip installs.
- The bridge resolves bundled assets via the **executable's directory**
  (PyInstaller's `sys.frozen`), NOT `__file__` — so `wheels/`, `tessdata/`,
  `tesseract/` next to the installed exe are found correctly. Layout:

```
<FileBridge install>/
├── FileBridge(.exe)      # everything python baked in (82 MB)
├── wheels/               # browser-side Office libs (8 .whl)
├── tessdata/             # eng swe chi_sim osd (.traineddata)
└── tesseract/            # engine binary (Windows installer only)
```

Without the add-ons the endpoints return 501 with a clear message; everything
else works.

## Smoke-testing a build

```bash
./FileBridge /tmp/test-folder &
sleep 1
curl -s http://127.0.0.1:8765/health     # {"ok": true, "root": "/tmp/test-folder", ...}
kill %1
```

The full endpoint/security test suite is `tests/e2e_test.sh` (also runs in CI
on the Linux build). It is portable across Linux and macOS (works with
macOS's stock bash 3.2 and BSD userland) and can run against a **frozen
binary** instead of the source:

```bash
FILE_BRIDGE_CMD="$PWD/dist/FileBridge.app/Contents/MacOS/FileBridge" \
  uv run --with pymupdf bash tests/e2e_test.sh
```

Verified on macOS this way: the complete 216-check suite passes against the
packaged `.app` binary (wheels served from inside the bundle, frozen-asset
detection, all security layers). The suite polls for readiness, so the
onefile binary's ~2 s self-extraction delay is handled.

The PDF/OCR addon suite (`tests/addon_test.sh`, 127 checks) is likewise
portable; it needs tesseract on PATH (e.g. `brew install tesseract`) — the
bundled `tessdata/` supplies the languages, so `swe`/`chi_sim` work without
any system language packs:

```bash
uv run --with pymupdf --with fpdf2 --with pypdfium2 \
       --with python-docx --with python-pptx --with openpyxl \
       bash tests/addon_test.sh
```
