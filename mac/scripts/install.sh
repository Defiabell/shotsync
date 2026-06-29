#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="shotsync.app"
[ -d "$APP" ] || { echo "run build.sh first"; exit 1; }
rm -rf "/Applications/$APP"
cp -R "$APP" "/Applications/$APP"
PLIST="$HOME/Library/LaunchAgents/com.jinkun.shotsync.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jinkun.shotsync</string>
  <key>ProgramArguments</key><array><string>/Applications/$APP/Contents/MacOS/shotsync</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed + loaded. shotsync will start at login."
