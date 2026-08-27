; File Bridge — Windows installer (Inno Setup)
; ============================================================
; Bundles EVERYTHING into one setup exe — no Python, no downloads,
; no admin rights for the user:
;   FileBridge.exe          PyInstaller onefile (the bridge app)
;   wheels\                 browser-side Office libs (openpyxl etc.)
;   tessdata\               OCR languages: eng, swe, chi_sim, osd
;   tesseract\              tesseract binary + DLLs (UB-Mannheim build)
;
; PREP (on a Windows machine, once):
;   1. pip install pyinstaller pymupdf
;   2. cd build
;      pyinstaller --noconfirm file_bridge_windows.spec
;      -> dist\FileBridge\FileBridge.exe
;   3. Get tesseract for Windows (UB-Mannheim build):
;      https://github.com/UB-Mannheim/tesseract/wiki
;      Install it ONCE on your build machine, then copy the install dir
;      (tesseract.exe + *.dll + tessdata\) into bundle\tesseract\
;      (script uses bundle\ layout below; keep eng.traineddata in
;       bundle\tesseract\tessdata\ OR rely on bundle\tessdata\ —
;       the bridge checks both)
;   4. Copy assets:
;      xcopy /E /I ..\src\wheels   bundle\wheels
;      xcopy /E /I ..\src\tessdata bundle\tessdata
;   5. Compile this script in Inno Setup (F9) -> FileBridge-Setup.exe
;
; The bridge auto-detects the bundled engine at runtime:
;   <install>\tesseract\tesseract.exe and <install>\tessdata\ —
;   no TESSERACT_CMD / PATH setup needed on the user's machine.

[Setup]
AppId={{8E1B6C4A-9D2F-4E7B-A3C1-FILEBRIDGE01}
AppName=File Bridge
AppVersion=1.2.0
AppPublisher=Your Org
DefaultDirName={autopf}\File Bridge
DefaultGroupName=File Bridge
UninstallDisplayIcon={app}\FileBridge.exe
OutputBaseFilename=FileBridge-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest          ; per-user install, no UAC prompt

[Files]
; the app
Source: "..\dist\FileBridge\FileBridge.exe"; DestDir: "{app}"; Flags: ignoreversion
; browser-side Office wheels (served to Pyodide over localhost)
Source: "..\src\wheels\*.whl"; DestDir: "{app}\wheels"; Flags: ignoreversion
; OCR language packs (drop more .traineddata here to add languages later)
Source: "..\src\tessdata\*.traineddata"; DestDir: "{app}\tessdata"; Flags: ignoreversion
; bundled tesseract engine (from UB-Mannheim install, see PREP step 3)
Source: "bundle\tesseract\*"; DestDir: "{app}\tesseract"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\File Bridge"; Filename: "{app}\FileBridge.exe"
Name: "{autodesktop}\File Bridge"; Filename: "{app}\FileBridge.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; Flags: unchecked
Name: "autostart"; Description: "Start File Bridge automatically when Windows starts"; Flags: unchecked

[Registry]
; optional autostart (per-user Run key; no admin needed)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
    ValueType: string; ValueName: "FileBridge"; \
    ValueData: """{app}\FileBridge.exe"""; Tasks: autostart; Flags: uninsdeletevalue

[Dirs]
; users can drop additional .traineddata files here to add languages
Name: "{app}\tessdata"; Flags: uninsneveruninstall

[Run]
Filename: "{app}\FileBridge.exe"; Description: "Launch File Bridge"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\wheels"
Type: filesandordirs; Name: "{app}\tesseract"

; AFTER-INSTALL BEHAVIOR (what the user sees):
;  1. File Bridge launches; browser opens http://127.0.0.1:8765
;  2. Paste a folder to share -> Save
;  3. OCR language can be set on the same page (e.g. swe+eng)
;  4. In Open WebUI: pick the admin's preset model and ask for files
;  5. Chrome/Edge shows a one-time local-network permission -> Allow
;
; ADDING LANGUAGES LATER (no reinstall):
;   download .traineddata from https://github.com/tesseract-ocr/tessdata_fast
;   -> drop into C:\Users\<user>\AppData\Local\Programs\File Bridge\tessdata\
;   -> restart File Bridge; it appears in the settings page list
