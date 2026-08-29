# Open File Bridge — Windows build spec (PyInstaller)
# ============================================================
# Build on a Windows machine (or Windows runner) with:
#   pip install pyinstaller pymupdf
#   pyinstaller --noconfirm file_bridge_windows.spec
#
# Output: dist/OpenFileBridge/OpenFileBridge.exe  (one-folder bundle — the layout
# installer_windows.iss expects; wheels/ + tessdata/ + the tesseract engine
# are layered next to the exe by the installer).

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

# One-folder (not onefile): no repeated self-extraction of ~80 MB on every
# start, faster launch, and the installer/uninstaller manages real files.
# PDF support (pymupdf) is frozen IN via collect_all above, so the installed
# app has /pdf_text + PDF-rendering-for-OCR out of the box.
# OCR itself uses the external tesseract binary bundled by the installer.
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name='OpenFileBridge',
    console=False,          # no console window; runs quietly in background
    icon='appicon.ico',     # embedded in the exe (Taskbar/Explorer/shortcuts)
    uac_admin=False,        # normal user rights, no admin needed
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name='OpenFileBridge',
)

# Windows Defender SmartScreen will warn on first run of an unsigned exe.
# Users click "More info" -> "Run anyway". Signing (EV cert) removes this.
