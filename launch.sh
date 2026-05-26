#!/bin/bash
# Bitaxe Difficulty Tracker - Linux/Umbrel Launcher

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
    echo "  Install it with: sudo apt install nodejs"
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

# Open browser if available
if command -v xdg-open &> /dev/null; then
    sleep 1 && xdg-open "http://localhost:19248" &
elif command -v open &> /dev/null; then
    sleep 1 && open "http://localhost:19248" &
fi

node server.js
