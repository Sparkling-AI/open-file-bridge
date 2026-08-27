# File Bridge — Windows build spec (PyInstaller)
# Build on a Windows machine (or Windows runner) with:
#   pip install pyinstaller
#   pyinstaller --noconfirm file_bridge_windows.spec
#
# Output: dist/FileBridge/FileBridge.exe  (one-folder bundle)
# Zip dist/FileBridge -> FileBridge-windows-x64.zip for distribution.

import sys
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

# --onefile: single self-extracting exe. Simpler for non-technical users
# (one file to download, one to double-click), slower startup (~1-2s) is fine here.
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name='FileBridge',
    console=False,          # no black console window; logs go to ~/.file-bridge.log
    icon=None,              # add icon='filebridge.ico' when you have one
    uac_admin=False,        # normal user rights, no admin needed
)

# Windows Defender SmartScreen will warn on first run of an unsigned exe.
# Users click "More info" -> "Run anyway". Signing (EV cert) removes this.
