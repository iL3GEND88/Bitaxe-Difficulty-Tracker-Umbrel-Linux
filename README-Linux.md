# Bitaxe Difficulty Tracker — Linux / macOS / Umbrel

A real-time share difficulty monitor and full dashboard for home Bitcoin miners running AxeOS firmware. This version runs on Linux, macOS, Raspberry Pi, and Umbrel using Node.js — no Windows required.

No cloud. No accounts. Runs entirely on your local network. Full companion mobile app for iPhone/Android via Safari or Chrome over WiFi or Tailscale.

> **Raspberry Pi note:** The Node.js server runs great on any Pi model. However, the dashboard is a heavy browser app — 48 hours of chart history, live WebSocket streams, and multiple overlays. If you want to open the dashboard on the Pi itself using Chromium, a Pi 4 or 5 is recommended and may still feel sluggish over time. The recommended setup is to run the server on the Pi and open the dashboard on a PC or phone browser across the network — the Pi never touches rendering in that case and works fine even on older models.

---

## Quick Start

1. Download and unzip all files into the same folder
2. Open a terminal in that folder
3. Run: `./launch.sh`
4. The app opens automatically in your browser
5. On iPhone/Android: open `http://YOUR_SERVER_IP:19248` in Safari or Chrome

> **First launch** installs the `ws` dependency automatically via npm.

---

## Requirements

- **Node.js 18 or higher**
- **npm** (comes with Node.js)
- A Chromium-based browser recommended (Chrome, Brave, Chromium, Edge) for app-mode window

---

## Installing Node.js

**Ubuntu / Debian / Raspberry Pi OS:**
```bash
sudo apt update && sudo apt install nodejs npm
node --version  # must be 18+
```

If version is below 18:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs
```

**macOS:**
```bash
brew install node
```

**Umbrel (via SSH):**
```bash
ssh umbrel@umbrel.local
sudo apt install nodejs npm
```

---

## How to Run

```bash
./launch.sh
```

Or manually:
```bash
npm install   # first time only
node server.js
```

The server starts on port **19248**.

- **Desktop browser:** Opens automatically at `http://localhost:19248`
- **iPhone / Android:** Open `http://YOUR_SERVER_IP:19248` in Safari or Chrome

---

## Browser Window

The launcher tries to open the app in a dedicated app-mode window using the first Chromium browser it finds:

**Linux:** Chrome → Chromium → Brave → Edge → default browser  
**macOS:** Chrome → Brave → Edge → default browser

The launcher also **automatically opens port 19248 in ufw** if it is active. If your phone still can't connect, run manually:

```bash
sudo ufw allow 19248
```

---

## Features

### Windows / Desktop App
- Live difficulty chart with all shares plotted in real time — persists across session resets
- **📊 Difficulty Scores page** — session best and all-time best per miner, collapsible, live updates, per-miner clear
- **⚡ HR High Scores page** — peak hashrate records with error rate, collapsible per miner, per-miner clear
- **Session best list persists** — restores from disk on app restart, validated against miner uptime
- Hashrate / Temperature / Efficiency chart per miner
- Combined, Split, and Both chart layouts
- Time range dropdown: 10s / 30s / 1m / 5m / 30m / 1h / 6h / 24h / 1w / All
- Efficiency (W/TH) stat per miner
- All-Time Hall of Fame with AxeOS Scoreboard integration
- **📋 Crash/Restart Reports** — auto-saved when hashrate drops to zero
  - 60-second lookback captures pre-crash hashrate and temps accurately
  - Detects power faults, overheat, pool switches, manual and auto-restarts
  - Collapsible cards, delete support, bidirectional sync with mobile
- **📜 Scripts Engine** — automation scripts with conditions and actions
  - Supports: hashrate, temperature, uptime, frequency, time of day, **autoRestarts** (restarts in last hour), and more
  - Bidirectional sync with mobile
- **🗑 Clear Sessions** — clear difficulty and HR scores per miner individually or all at once
- **🪩 Disco Mode** — hides miner cards, expands live log full height
- Pool settings and miner settings panels
- Auto-restart per miner (max 3 per hour with warning)
- Block found banner — fires immediately via API polling

### iPhone / Android Companion
- Live miner stats pushed every 2 seconds
- Difficulty and Hashrate/Temp charts per miner
- **Session tab** — best diffs and HR scores per miner, collapsible, per-list clear buttons
- **All-Time tab** — all-time bests per miner, collapsible
- Pool settings, fan control, frequency/voltage control
- Auto-restart toggle synced with desktop
- Scripts management with drag-and-drop reordering
- **Crash/Restart Reports** — collapsible per miner, delete support, bidirectional sync
- Battery Saver refresh rate: 2s / 5s / 10s / 20s
- Hash Rain visual effect
- Odds calculator with exact values

---

## Data Persistence

All data is saved to disk in the same folder as the server:

| File | Contents |
|---|---|
| `miners-data.json` | Miner IPs, names, colors |
| `alltime-data.json` | All-time hall of fame records |
| `scripts-data.json` | Automation scripts |
| `settings-data.json` | App preferences |
| `reports-data.json` | Crash/Restart session reports |
| `session-data.json` | Session best list snapshot (auto-created) |

Data survives server restarts, reboots, and page refreshes. Server state is bounded — notifications capped at 50, all data structures have fixed maximum sizes to prevent memory growth over time.

---

## Adding Miners

Open the app and use the **+** button to add miners by IP address.

---

## Remote Access via Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Then access from anywhere: `http://100.x.x.x:19248`

---

## Umbrel — Run on Boot (systemd)

```bash
sudo nano /etc/systemd/system/bitaxe-tracker.service
```

Paste (adjust path):
```ini
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
```

```bash
sudo systemctl enable bitaxe-tracker
sudo systemctl start bitaxe-tracker
```

---

## Copying Files to Umbrel

```bash
scp -r BitaxeDifficultyTracker-Linux umbrel@umbrel.local:~/
```

---

## Supported Devices

| Device | Notes |
|---|---|
| Bitaxe (all models) | Full support |
| Bitaxe Duo 650 | Dual BM1370 chips |
| NerdQaxe++ | Full support — uses lastResetReason field |
| NerdOCTAXE Gamma | Full support — same firmware base as NerdQaxe |
| Titan | AxeOS compatible |
| NerdMiner v2 | No API — shows ⚠ warning |

---

## License

MIT — do whatever you want with it.
