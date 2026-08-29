# File Bridge — macOS build spec (PyInstaller)
# Build on a macOS machine (or macOS runner) with:
#   pip install pyinstaller
#   pyinstaller --noconfirm file_bridge_macos.spec
#
# Output: dist/OpenFileBridge.app  -> zip it: OpenFileBridge-macos.zip
# NOTE: build on the OLDEST macOS you want to support (PyInstaller binaries
# are forward-compatible but not backward-compatible).

from PyInstaller.utils.hooks import collect_submodules

from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = [], [], []
for pkg in ('pymupdf', 'fitz'):
    d, b, h = collect_all(pkg)
    datas += d; binaries += b; hiddenimports += h

block_cipher = None

a = Analysis(
    ['../src/file_bridge.py'],
    pathex=['../src'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'unittest', 'pydoc_data'],
    cipher=block_cipher,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name='OpenFileBridge',
    console=False,
    icon='appicon.icns',    # raw-binary Dock icon; the .app wrapper sets its own copy
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name='OpenFileBridge',
)

# After build, make the .app bundle:
#   mkdir -p dist/OpenFileBridge.app/Contents/MacOS
#   cp -R dist/OpenFileBridge/* dist/OpenFileBridge.app/Contents/MacOS/
# or use pyinstaller --windowed --name OpenFileBridge directly (auto .app).
#
# GATEKEEPER: unsigned apps are blocked on first open.
# User must: right-click OpenFileBridge.app -> Open -> Open (once).
# Or System Settings -> Privacy & Security -> "Open Anyway".
# Proper fix: sign + notarize with an Apple Developer ID ($99/yr):
#   codesign --deep --force --sign "Developer ID Application: YOU" dist/OpenFileBridge.app
#   xcrun notarytool submit OpenFileBridge-macos.zip --keychain-profile AC --wait
#   xcrun staple OpenFileBridge.app
