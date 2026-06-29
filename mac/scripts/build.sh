#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
APP="shotsync.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp ".build/release/shotsync" "$APP/Contents/MacOS/shotsync"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>shotsync</string>
  <key>CFBundleIdentifier</key><string>com.jinkun.shotsync</string>
  <key>CFBundleExecutable</key><string>shotsync</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
codesign --force --deep --sign "Day Monitor Self-Signed" "$APP"
echo "Built $APP"
