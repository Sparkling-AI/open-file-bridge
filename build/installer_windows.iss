; File Bridge — Windows installer (Inno Setup)
; Build: install Inno Setup (https://jrsoftware.org/isinfo.php), then
;   "Compil32 /cc installer_windows.iss"  (or open in Inno Setup IDE and hit Build)
; Requires dist/FileBridge/FileBridge.exe from file_bridge_windows.spec first.

[Setup]
AppId={{8E1B6C4A-9D2F-4E7B-A3C1-FILEBRIDGE01}
AppName=File Bridge
AppVersion=1.0.0
AppPublisher=Your Org
DefaultDirName={autopf}\File Bridge
DefaultGroupName=File Bridge
UninstallDisplayIcon={app}\FileBridge.exe
OutputBaseFilename=FileBridge-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest          ; install per-user, no admin prompt

[Files]
Source: "..\dist\FileBridge\FileBridge.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\File Bridge"; Filename: "{app}\FileBridge.exe"
Name: "{autodesktop}\File Bridge"; Filename: "{app}\FileBridge.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; Flags: unchecked

[Run]
Filename: "{app}\FileBridge.exe"; Description: "Launch File Bridge"; Flags: nowait postinstall skipifsilent

; After install, user double-clicks File Bridge:
;  1. Browser opens the folder picker (http://127.0.0.1:8765)
;  2. Paste a folder path, Save
;  3. Windows Defender SmartScreen may warn once: More info -> Run anyway
;  4. In Open WebUI: pick the admin's preset model, ask for a file
;  5. Chrome/Edge will prompt "allow local network access" once: Allow
