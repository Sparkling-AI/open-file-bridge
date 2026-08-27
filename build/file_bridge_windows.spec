# File Bridge — Windows build spec (PyInstaller)
# ============================================================
# Build on a Windows machine (or Windows runner) with:
#   pip install pyinstaller pymupdf
#   pyinstaller --noconfirm file_bridge_windows.spec
#
# Output: dist/FileBridge/FileBridge.exe  (one-folder bundle)
# Zip dist/FileBridge -> FileBridge-windows-x64.zip for distribution,
# or compile installer_windows.iss (Inno Setup) for the full installer
# that also bundles wheels/ + tessdata/ + the tesseract engine.

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

# --onefile: single self-extracting exe. Slower startup (~1-2s) is fine here.
# PDF support (pymupdf) is frozen INTO the exe via collect_all below, so the
# installed app has /pdf_text + PDF-rendering-for-OCR out of the box.
# OCR itself uses the external tesseract binary bundled by the installer.
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name='FileBridge',
    console=False,          # no console window; runs quietly in background
    icon=None,              # add icon='filebridge.ico' when you have one
    uac_admin=False,        # normal user rights, no admin needed
)

# Windows Defender SmartScreen will warn on first run of an unsigned exe.
# Users click "More info" -> "Run anyway". Signing (EV cert) removes this.
