#!/usr/bin/env bash
# File Bridge — macOS .app packaging + (optional) signing/notarization
# Run on a Mac AFTER: pyinstaller --onefile --windowed --name FileBridge src/file_bridge.py
#
#   ./package_macos.sh              -> FileBridge-macos.zip (unsigned)
#   ./package_macos.sh --sign       -> signed + notarized (needs Apple Developer ID
#                                      + notarytool profile "AC" in keychain)

set -euo pipefail
cd "$(dirname "$0")/.."
SIGN="${1:-}"

APP="dist/FileBridge.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp dist/FileBridge "$APP/Contents/MacOS/FileBridge"
chmod +x "$APP/Contents/MacOS/FileBridge"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>File Bridge</string>
  <key>CFBundleDisplayName</key>     <string>File Bridge</string>
  <key>CFBundleIdentifier</key>      <string>com.yourorg.filebridge</string>
  <key>CFBundleVersion</key>         <string>1.0.0</string>
  <key>CFBundlePackageType</key>     <string>APPL</string>
  <key>CFBundleExecutable</key>      <string>FileBridge</string>
  <key>LSMinimumSystemVersion</key>  <string>11.0</string>
  <key>LSUIElement</key>             <true/>
</dict>
</plist>
PLIST
# LSUIElement=true: no Dock icon; runs quietly in background (it's a helper app)

if [[ "$SIGN" == "--sign" ]]; then
  codesign --deep --force --sign "Developer ID Application: YOUR NAME (TEAMID)" "$APP"
  ditto -c -k --keepParent "$APP" FileBridge-macos.zip
  xcrun notarytool submit FileBridge-macos.zip --keychain-profile AC --wait
  xcrun staple "$APP"
  echo "Signed + notarized."
else
  ditto -c -k --keepParent "$APP" FileBridge-macos.zip
  echo "Unsigned zip: FileBridge-macos.zip"
  echo "Users must right-click -> Open on first launch (Gatekeeper)."
fi
