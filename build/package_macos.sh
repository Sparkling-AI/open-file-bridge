#!/usr/bin/env bash
# File Bridge — macOS .app packaging + (optional) signing/notarization
# Run on a Mac AFTER: pyinstaller --onefile --windowed --name OpenFileBridge src/file_bridge.py
#
#   ./package_macos.sh              -> OpenFileBridge-macos.zip (unsigned)
#   ./package_macos.sh --sign       -> signed + notarized (needs Apple Developer ID
#                                      + notarytool profile "AC" in keychain)

set -euo pipefail
cd "$(dirname "$0")/.."
SIGN="${1:-}"

APP="dist/OpenFileBridge.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp dist/OpenFileBridge "$APP/Contents/MacOS/OpenFileBridge"
chmod +x "$APP/Contents/MacOS/OpenFileBridge"

# Frozen-build asset layout (docs/BUILDING.md): wheels/ (browser-side office
# libs served by /wheels) and tessdata/ (OCR langs incl. swe/chi_sim) next to
# the executable. The bridge resolves them via sys.executable's dir when
# frozen, i.e. Contents/MacOS inside the .app. Skip gracefully if absent.
for asset in wheels tessdata; do
  if [ -d "src/$asset" ]; then
    rm -rf "$APP/Contents/MacOS/$asset"
    cp -R "src/$asset" "$APP/Contents/MacOS/$asset"
  fi
done

# App icon (build/appicon.icns — see docs/BUILDING.md to regenerate)
if [ -f build/appicon.icns ]; then
  cp build/appicon.icns "$APP/Contents/Resources/appicon.icns"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>Open File Bridge</string>
  <key>CFBundleDisplayName</key>     <string>Open File Bridge</string>
  <key>CFBundleIdentifier</key>      <string>com.yourorg.openfilebridge</string>
  <key>CFBundleVersion</key>         <string>1.0.0</string>
  <key>CFBundlePackageType</key>     <string>APPL</string>
  <key>CFBundleExecutable</key>      <string>OpenFileBridge</string>
  <key>CFBundleIconFile</key>        <string>appicon</string>
  <key>LSMinimumSystemVersion</key>  <string>11.0</string>
</dict>
</plist>
PLIST
# NO LSUIElement (2026-08-28, user feedback): the bridge shows a normal Dock
# icon while running — that is how you tell it is up. The binary itself
# bootstraps NSApplication (see CocoaDock in src/file_bridge.py) so Dock →
# Quit works too; the settings page also has a Stop button.

if [[ "$SIGN" == "--sign" ]]; then
  codesign --deep --force --sign "Developer ID Application: YOUR NAME (TEAMID)" "$APP"
  ditto -c -k --keepParent "$APP" OpenFileBridge-macos.zip
  xcrun notarytool submit OpenFileBridge-macos.zip --keychain-profile AC --wait
  xcrun staple "$APP"
  echo "Signed + notarized."
else
  ditto -c -k --keepParent "$APP" OpenFileBridge-macos.zip
  echo "Unsigned zip: OpenFileBridge-macos.zip"
  echo "Users must right-click -> Open on first launch (Gatekeeper)."
fi
