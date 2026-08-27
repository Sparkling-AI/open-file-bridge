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

`package_macos.sh` wraps the binary into a proper `.app` (with `LSUIElement`
so it runs background-only, no Dock icon) and zips it.

- Unsigned ⇒ Gatekeeper blocks first launch: **right-click → Open → Open** (once).
- With an Apple Developer ID ($99/yr):
  ```bash
  ./build/package_macos.sh --sign     # codesign + notarytool + staple
  ```
  (Edit the Developer ID string and keychain profile inside the script first.)
- Build on the **oldest macOS you support** — PyInstaller binaries run on newer
  macOS but not older ones.

## CI (recommended)

`.github/workflows/build.yml` builds all three OSes on every `v*` tag:

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
- Extra languages: drop `.traineddata` files from
  https://github.com/tesseract-ocr/tessdata_fast into `tessdata/`.
  Users select them at runtime in the settings page — no rebuild needed.
  (On Windows: `%LOCALAPPDATA%\Programs\File Bridge\tessdata\`)

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
on the Linux build).
