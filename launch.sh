#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "  =========================================="
echo "   Bitaxe Difficulty Tracker - Starting..."
echo "   Keep this terminal open while using app"
echo "  =========================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "  ERROR: Node.js not found."
  echo "  Install with: sudo apt install nodejs npm"
  echo "  Or visit: https://nodejs.org"
  exit 1
fi

NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
  echo "  ERROR: Node.js 18+ required (found v$(node -v))"
  echo "  Update: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install nodejs"
  exit 1
fi

echo "  Node.js $(node -v) OK"

# Install dependencies if needed
if [ ! -d "node_modules/ws" ]; then
  echo "  Installing dependencies..."
  npm install
fi

# Open firewall port if ufw is active
if command -v ufw &> /dev/null; then
  UFW_STATUS=$(sudo ufw status 2>/dev/null | head -1)
  if echo "$UFW_STATUS" | grep -q "active"; then
    if ! sudo ufw status | grep -q "19248"; then
      echo "  Opening firewall port 19248..."
      sudo ufw allow 19248 > /dev/null 2>&1
      echo "  Port 19248 opened"
    else
      echo "  Firewall port 19248 already open"
    fi
  fi
fi

# Get local IP
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo "  App:    http://localhost:19248"
if [ -n "$LOCAL_IP" ]; then
  echo "  Mobile: http://$LOCAL_IP:19248"
fi
echo ""

# Try to open browser in app mode
OPENED=0
FLAGS="--app=http://localhost:19248 --disable-background-timer-throttling"

if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  for BROWSER in "Google Chrome" "Brave Browser" "Microsoft Edge"; do
    APP="/Applications/$BROWSER.app/Contents/MacOS/$BROWSER"
    if [ -f "$APP" ]; then
      "$APP" $FLAGS &>/dev/null &
      OPENED=1; break
    fi
  done
else
  # Linux
  for CMD in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
    if command -v $CMD &> /dev/null; then
      $CMD $FLAGS &>/dev/null &
      OPENED=1; break
    fi
  done
fi

if [ $OPENED -eq 0 ]; then
  echo "  No Chromium browser found - open http://localhost:19248 manually"
  if command -v xdg-open &> /dev/null; then
    xdg-open http://localhost:19248 &>/dev/null &
  fi
fi

# Start server
node server.js
