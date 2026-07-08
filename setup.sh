#!/bin/bash
# One-time setup / (re)install of the launchd daemon (macOS).
# Detects your node + install path automatically and writes the LaunchAgent for you.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.claude-code-telegram-cockpit.bridge"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"
STATE_DIR="$HOME/.claude/bridge-state"

echo "== claude-code-telegram-cockpit setup =="

if [ -z "$NODE" ]; then
  echo "node not found on PATH. Install Node.js >= 20 first." >&2
  exit 1
fi

if ! /usr/bin/security find-generic-password -s claude-tg-bridge -w >/dev/null 2>&1; then
  cat <<'EOF'
[1/3] Telegram bot token missing. Do this first:
   a. In Telegram, message @BotFather -> /newbot -> pick a name/username -> copy the token.
   b. security add-generic-password -s claude-tg-bridge -a bot -w '<TOKEN>'
   c. Re-run this script.
EOF
  exit 1
fi
echo "[1/3] bot token found in Keychain ✓"

echo "[2/3] building…"
( cd "$DIR" && npm install --silent && npx tsc )

echo "[3/3] installing launchd agent…"
mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR/logs"

cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/dist/main.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$STATE_DIR/logs/bridge.log</string>
  <key>StandardErrorPath</key>
  <string>$STATE_DIR/logs/bridge.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
sleep 2
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|pid" | head -3 || true

echo
echo "Done. If this is the first run, send the pairing code to your bot:"
echo "  cat $STATE_DIR/pairing-code.txt"
echo "Logs: tail -f $STATE_DIR/logs/bridge.log"
echo "Restart later with: launchctl kickstart -k gui/\$(id -u)/$LABEL"
