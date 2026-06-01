Bitaxe Difficulty Tracker — Linux / macOS / Umbrel
A real-time share difficulty monitor and full dashboard for home Bitcoin miners running AxeOS firmware. This version runs on Linux, macOS, Raspberry Pi, and Umbrel using Node.js — no Windows required.

No cloud. No accounts. Runs entirely on your local network. Full companion mobile app for iPhone/Android via Safari or Chrome over WiFi or Tailscale.

Quick Start
Download and unzip all files into the same folder
Open a terminal in that folder
Run: ./launch.sh
The app opens automatically in your browser
On iPhone/Android: open http://YOUR_SERVER_IP:19248 in Safari or Chrome
First launch installs the ws dependency automatically via npm.

Requirements
Node.js 18 or higher
npm (comes with Node.js)
A Chromium-based browser recommended (Chrome, Brave, Chromium, Edge) for app-mode window
Installing Node.js
Ubuntu / Debian / Raspberry Pi OS:

sudo apt update && sudo apt install nodejs npm
node --version  # must be 18+
If version is below 18:

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs
macOS:

brew install node
Umbrel (via SSH):

ssh umbrel@umbrel.local
sudo apt install nodejs npm
How to Run
./launch.sh
Or manually:

npm install   # first time only
node server.js
The server starts on port 19248.

Desktop browser: Opens automatically at http://localhost:19248
iPhone / Android: Open http://YOUR_SERVER_IP:19248 in Safari or Chrome
Browser Window
The launcher tries to open the app in a dedicated app-mode window (no browser tabs, no throttling) using the first Chromium browser it finds:

Linux: Chrome → Chromium → Brave → Edge → default browser
macOS: Chrome → Brave → Edge → default browser

If no Chromium browser is found it falls back to your default browser as a regular tab.

Standalone — No Windows Required
The server connects directly to your miners. It:

Connects to each miner via WebSocket and parses the live log stream
Calculates share difficulty, session best, accepted/rejected counts
Polls the AxeOS API every 2 seconds for hashrate, temps, power, uptime
Pushes live data to the mobile app automatically
Triggers Crash/Restart Reports when hashrate drops to zero
iPhone/Android users get full live stats without needing a Windows PC running.

Adding Miners
Open the app in your browser and use the + button to add miners by IP address. Miners are saved to miners-data.json and reconnect automatically every time the server starts.

Features
Windows / Desktop App
Live difficulty chart with all shares plotted in real time
Hashrate / Temperature / Efficiency chart per miner
Combined, Split, and Both chart layouts
Time range dropdown: 10s / 30s / 1m / 5m / 30m / 1h / 6h / 24h / 1w / All
Efficiency (W/TH) stat per miner
All-Time Hall of Fame with AxeOS Scoreboard integration
📋 Crash/Restart Reports — auto-saved session snapshots when hashrate drops to zero
📜 Scripts Engine — automation scripts with conditions and actions, bidirectional sync with mobile
Pool settings and miner settings panels
Auto-restart per miner (5 min no shares + near-zero hashrate)
Chart history persists across session resets
Stall detection
iPhone / Android Companion
Live miner stats pushed every 2 seconds
Difficulty and Hashrate/Temp charts per miner
Pool settings, fan control, frequency/voltage control
Auto-restart toggle synced with desktop
Scripts management with drag-and-drop reordering
Crash/Restart Reports — collapsible session cards, delete support, bidirectional sync
Battery Saver refresh rate: 2s / 5s / 10s / 20s
Hash Rain visual effect
All-Time and Session best lists
Data Persistence
All data is saved to disk in the same folder as the server:

File	Contents
miners-data.json	Miner IPs, names, colors
alltime-data.json	All-time hall of fame records
scripts-data.json	Automation scripts
settings-data.json	App preferences
reports-data.json	Crash/Restart session reports
Data survives server restarts, reboots, and page refreshes.

Remote Access via Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
Then access from anywhere using your Tailscale IP: http://100.x.x.x:19248

Umbrel — Run on Boot (systemd)
sudo nano /etc/systemd/system/bitaxe-tracker.service
Paste (adjust path to where you extracted the files):

[Unit]
Description=Bitaxe Difficulty Tracker
After=network.target

[Service]
Type=simple
User=umbrel
WorkingDirectory=/home/umbrel/BitaxeDifficultyTracker-Linux
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
Enable and start:

sudo systemctl enable bitaxe-tracker
sudo systemctl start bitaxe-tracker
sudo systemctl status bitaxe-tracker
Firewall
If your phone can't connect, open port 19248:

sudo ufw allow 19248
Copying Files to Umbrel
scp -r BitaxeDifficultyTracker-Linux umbrel@umbrel.local:~/
Supported Devices
Device	Notes
Bitaxe (all models)	Full support
Bitaxe Duo 650	Single ASIC temp sensor
NerdQaxe++	ANSI stripping + slash log format
Titan	AxeOS compatible
NerdMiner v2	No API — shows ⚠ warning
License
MIT — do whatever you want with it.
