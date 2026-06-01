#!/bin/bash
# Bitaxe Difficulty Tracker - Linux/macOS/Umbrel Launcher

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  =========================================="
echo "   Bitaxe Difficulty Tracker - Starting..."
echo "  =========================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "  ERROR: Node.js is not installed."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "  Install with Homebrew: brew install node"
    else
        echo "  Install with: sudo apt install nodejs"
    fi
    echo "  Or visit: https://nodejs.org"
    exit 1
fi

NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
    echo "  ERROR: Node.js 18+ required. You have version $NODE_VER."
    echo "  Update at: https://nodejs.org"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  Installing dependencies..."
    npm install
    echo ""
fi

# Open in app mode (no tab throttling) - try Chromium browsers first
APP_FLAGS="--app=http://localhost:19248 --disable-background-timer-throttling"
OPENED=0

if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS - try Chrome then default
    if [ -d "/Applications/Google Chrome.app" ]; then
        sleep 1 && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" $APP_FLAGS &
        OPENED=1
    elif [ -d "/Applications/Brave Browser.app" ]; then
        sleep 1 && "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" $APP_FLAGS &
        OPENED=1
    elif [ -d "/Applications/Microsoft Edge.app" ]; then
        sleep 1 && "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" $APP_FLAGS &
        OPENED=1
    else
        sleep 1 && open "http://localhost:19248" &
    fi
else
    # Linux - try Chromium browsers
    for BROWSER in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
        if command -v $BROWSER &> /dev/null; then
            sleep 1 && $BROWSER $APP_FLAGS &
            OPENED=1
            break
        fi
    done
    if [ $OPENED -eq 0 ]; then
        # Fall back to default browser
        echo "  Note: No Chromium browser found - opening in default browser"
        sleep 1 && xdg-open "http://localhost:19248" &
    fi
fi

node server.js
