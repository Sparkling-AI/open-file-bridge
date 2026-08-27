# File Bridge — macOS build spec (PyInstaller)
# Build on a macOS machine (or macOS runner) with:
#   pip install pyinstaller
#   pyinstaller --noconfirm file_bridge_macos.spec
#
# Output: dist/FileBridge.app  -> zip it: FileBridge-macos.zip
# NOTE: build on the OLDEST macOS you want to support (PyInstaller binaries
# are forward-compatible but not backward-compatible).

from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

a = Analysis(
    ['../src/file_bridge.py'],
    pathex=['../src'],
    binaries=[],
    datas=[],
    hiddenimports=[],
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
    name='FileBridge',
    console=False,
    icon=None,              # add icon='filebridge.icns' when you have one
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name='FileBridge',
)

# After build, make the .app bundle:
#   mkdir -p dist/FileBridge.app/Contents/MacOS
#   cp -R dist/FileBridge/* dist/FileBridge.app/Contents/MacOS/
# or use pyinstaller --windowed --name FileBridge directly (auto .app).
#
# GATEKEEPER: unsigned apps are blocked on first open.
# User must: right-click FileBridge.app -> Open -> Open (once).
# Or System Settings -> Privacy & Security -> "Open Anyway".
# Proper fix: sign + notarize with an Apple Developer ID ($99/yr):
#   codesign --deep --force --sign "Developer ID Application: YOU" dist/FileBridge.app
#   xcrun notarytool submit FileBridge-macos.zip --keychain-profile AC --wait
#   xcrun staple FileBridge.app
