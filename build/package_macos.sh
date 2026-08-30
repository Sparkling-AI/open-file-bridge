#!/usr/bin/env bash
# OpenFileBridge — macOS .app packaging + (optional) signing/notarization
# Run on a Mac AFTER: pyinstaller --onefile --windowed --name OpenFileBridge src/file_bridge.py
#
#   ./package_macos.sh              -> OpenFileBridge-macos.zip (unsigned)
#   ./package_macos.sh --sign       -> Developer-ID-signed + notarized + stapled
#                                      (users double-click; no Gatekeeper dance)
#
# One-time prerequisites (done 2026-08-30, Sparkling AI AB org account; see
# docs/BUILDING.md "macOS signing"):
#   keychain cert  "Developer ID Application: Sparkling AI AB (2N9PCQ7G5Z)"
#   notary profile xcrun notarytool store-credentials ofb-notary ...
# Override either via env: SIGN_IDENTITY / NOTARY_PROFILE.

set -euo pipefail
cd "$(dirname "$0")/.."
SIGN="${1:-}"
IDENTITY="${SIGN_IDENTITY:-Developer ID Application: Sparkling AI AB (2N9PCQ7G5Z)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-ofb-notary}"
VERSION="$(sed -n 's/^VERSION = "\(.*\)"$/\1/p' src/file_bridge.py | head -1)"
[[ -n "$VERSION" ]] || { echo "FATAL: VERSION not found in src/file_bridge.py" >&2; exit 1; }

APP="dist/OpenFileBridge.app"
# Full reassembly each run: a leftover stale _CodeSignature or old-layout
# asset dir (pre-signing era shipped tessdata/wheels in Contents/MacOS/)
# would either break codesign or ship cruft.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp dist/OpenFileBridge "$APP/Contents/MacOS/OpenFileBridge"
chmod +x "$APP/Contents/MacOS/OpenFileBridge"

# Frozen-build asset layout (docs/BUILDING.md): wheels/ (browser-side office
# libs served by /wheels) and tessdata/ (OCR langs incl. swe/chi_sim) in
# Contents/RESOURCES — not MacOS/: codesign treats everything in MacOS/ as
# code and refuses to sign data files there. The binary's _app_dir() resolves
# Resources when running inside a bundle, exe dir otherwise (bare onefile,
# Windows, CI artifacts). Skip gracefully if absent.
for asset in wheels tessdata; do
  if [ -d "src/$asset" ]; then
    cp -R "src/$asset" "$APP/Contents/Resources/$asset"
  fi
done

# App icon (build/appicon.icns — see docs/BUILDING.md to regenerate)
if [ -f build/appicon.icns ]; then
  cp build/appicon.icns "$APP/Contents/Resources/appicon.icns"
fi

# Keep CFBundleVersion in sync with src VERSION (Finder shows it in Get Info).
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>Open File Bridge</string>
  <key>CFBundleDisplayName</key>     <string>Open File Bridge</string>
  <key>CFBundleIdentifier</key>      <string>com.yourorg.openfilebridge</string>
  <key>CFBundleShortVersionString</key> <string>$VERSION</string>
  <key>CFBundleVersion</key>         <string>$VERSION</string>
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
  # --options runtime (hardened runtime) and --timestamp are BOTH required
  # for notarization. Entitlements: onefile extracts libpython3.x.dylib
  # (ad-hoc, no Team ID) at runtime and library validation would reject it
  # on arm64 — disable-library-validation is the standard fix; see
  # build/entitlements.mac.plist. No --deep needed: the bundle's only Mach-O
  # is the onefile executable — tessdata/ and wheels/ are data, sealed via
  # CodeResources. First-ever run may pop a keychain prompt: Always Allow.
  codesign --force --options runtime --timestamp \
    --entitlements build/entitlements.mac.plist \
    --sign "$IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
  # Notarize: the zip is TRANSPORT ONLY — the approval ticket is attached
  # to the .app by stapler below, so users pass Gatekeeper offline too.
  ditto -c -k --keepParent "$APP" OpenFileBridge-macos.zip
  xcrun notarytool submit OpenFileBridge-macos.zip \
    --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess -vv "$APP"   # expect: accepted, source=Notarized Developer ID
  # Re-zip AFTER stapling — the shipped zip must contain the stapled .app.
  ditto -c -k --keepParent "$APP" OpenFileBridge-macos.zip
  echo "Signed + notarized + stapled: OpenFileBridge-macos.zip (v$VERSION)"
else
  ditto -c -k --keepParent "$APP" OpenFileBridge-macos.zip
  echo "Unsigned zip: OpenFileBridge-macos.zip (v$VERSION)"
  echo "Users must right-click -> Open on first launch (Gatekeeper)."
fi
