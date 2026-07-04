# Bitaxe Difficulty Tracker — Linux / macOS / Umbrel

A real-time share difficulty monitor and full dashboard for home Bitcoin miners running AxeOS firmware. This version runs on Linux, macOS, Raspberry Pi, and Umbrel using Node.js — no Windows required.

No cloud. No accounts. Runs entirely on your local network. Full companion mobile app for iPhone/Android via Safari or Chrome over WiFi or Tailscale.

---

## What's New (Recent Updates)

- **Dynamic Governor** (runs in the Node server, always-on) — auto-adjusts frequency/voltage/fan to hold miners inside temperature, VR-temp, and current (amps) bands, with dwell/settle timers, per-profile 24hr scheduling, and restart-after-adjust. Configurable from the desktop and mobile UI.
- **Governor amps band** — cap current draw to protect the input connector, not just temperature.
- **Governor fan-step control** — the governor can drive the manual fan (opposite to MHz/mV: hotter raises the fan), with fan floor/ceiling limits.
- **Remove a miner without losing its history** — take a miner offline and its history stays; re-add the same IP later and it reconnects to its data.
- **🧹 Purge Miner** — completely wipe a miner from every store (local + server) when you want it gone for good (desktop global button + per-miner on mobile).
- **Per-miner all-time clear** — 🗑 to wipe a single miner's all-time Best Diffs or HR Scores, on desktop and mobile (durable; syncs both ways).
- **VR fan control** — set the second (VR) fan's mode (Linked / Manual / Auto-PID), manual speed, and PID target temp independently of the ASIC fan.
- **Correct target-temp & min-fan reading across firmwares** (Nexus-class) — no more snapping back to a default; the Min-Fan field only shows on boards that support it.
- **Crash/Restart reports fire once per outage** instead of repeating every few minutes.

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
- **⚙ Dynamic Governor** — automatic per-miner thermal tuning (runs in the server, always-on)
  - Multiple named, non-overlapping time-window profiles per miner (or a **24hr** toggle for all-day)
  - **Per-sensor temp bands** — independent max/min for every ASIC and VR the board reports; leave any blank to ignore it. Any sensor out of band fires (too-hot always wins for safety)
  - Steps MHz and/or mV in your chosen increments, clamped to your floor/ceiling (rides up to the limit, never past)
  - Fan gates, uptime gate, dwell (sustained-out-of-band before acting) and settle (pause after each change) timing
  - Optional restart-after-adjust per profile
  - **Engine runs in `server.js`** so governance continues 24/7 with no browser open; config persists across reboots
  - Master on/off, pill-slider toggles throughout, bidirectional sync with mobile
- **Per-ASIC HR/Err stats** — per-chip hashrate and error count from the miner's hashrate monitor, toggleable in the stats dropdown (shows what AxeOS doesn't break out per chip)
- **Multi-sensor temps** — shows every ASIC and VR temp the board reports (numbered when more than one), across cards, stats, and reports
- **Per-miner stats** — Power (W), Amps (A), Voltage (mV), Frequency (MHz), each toggleable in the stats dropdown
- **⏱ Last Hour Report** — rolling 60-minute per-miner summary (temp hi/lo, avg hashrate, best diff, amps, efficiency, shares, avg share time), collapsible cards
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
- **⚙ Dynamic Governor** — full editor: create/edit per-miner profiles, per-sensor ASIC/VR bands, 24hr toggle, all timing and step settings, master on/off; syncs to the server which runs the engine
- **Per-ASIC HR/Err**, multi-sensor temps, and Power/Amps/Voltage/Frequency stats
- **⏱ Last Hour Report** — rolling 60-minute per-miner summary, collapsible
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

## Umbrel / Linux — Run on Boot (systemd)

This is the recommended way to run on a headless Umbrel box or any always-on Linux
machine. It starts the server automatically on boot — **no browser or login required** —
and restarts it if it ever crashes.

**Why this matters:** the Dynamic Governor engine runs inside `server.js`, not in the
browser. With this service enabled, the governor keeps tuning your miners 24/7, even with
no dashboard open. If the Umbrel reboots (power loss, update, manual restart), the service
comes back up on its own and governance resumes automatically.

```bash
sudo nano /etc/systemd/system/bitaxe-tracker.service
```

Paste (adjust path/User for your box — on Umbrel the user is usually `umbrel`):
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
sudo systemctl enable bitaxe-tracker    # <-- auto-start on every boot (survives reboots)
sudo systemctl start bitaxe-tracker     # <-- start it now
```

- `enable` is the key step: it registers the service to launch on every boot.
- `start` just runs it for the current session.
- Check status any time: `sudo systemctl status bitaxe-tracker`
- View live logs (incl. governor actions): `journalctl -u bitaxe-tracker -f`
- The governor config is saved to `governors-data.json` and reloaded on restart, so your
  profiles and on/off state survive reboots too.

> Note: most Umbrel hosts run plain systemd services fine. If your Umbrel is heavily
> containerized and the service doesn't persist, you'd need to package this as an Umbrel
> app instead — only necessary in that specific case.

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
