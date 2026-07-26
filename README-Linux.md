# Bitaxe Difficulty Tracker — Linux / macOS / Umbrel

A real-time share difficulty monitor and full dashboard for home Bitcoin miners running AxeOS firmware. This version runs on Linux, macOS, Raspberry Pi, and Umbrel using Node.js — no Windows required.

No cloud. No accounts. Runs entirely on your local network. Full companion mobile app for iPhone/Android via Safari or Chrome over WiFi or Tailscale.

---

## What's New (Recent Updates)

This build is now feature-matched to the Windows release.

**Fleet card** — the whole rig as one card above the miners: combined hashrate, total power, fleet efficiency, shares/rejects, fleet-wide all-time and session best, and 10m/1h averages. Collapsible and colour-settable, on desktop and mobile.

**Luck** — 1h / 4h / 12h / 24h on the fleet card and every miner card. Green over 100%, amber and red under; hideable in the stats toggles. Three things make it accurate:
- Miners that only log shares meeting the pool target (Nexus-class) are detected and scored by counting shares above target, rather than summing targets they never reported.
- Under vardiff, expected count uses a time-weighted mean of 1/target, not 1/(mean target).
- Downtime is excluded — expected work is measured over hashing time only, so a reboot doesn't drag a 24h window down for the rest of the day.

**Analysis charts (Charts ▾)** — Luck Curve, Efficiency Curve, Volt/Temp Map, and Cold-Drop Watch, fed by a background run-logger that records each stable frequency/voltage operating point. Mobile gets the same four as scrollable sections.

**Per-miner chart timeframe** — 1h / 2h / 4h / 6h / 8h / 12h / 24h / 36h per miner on the hashrate/temp chart, independent of the master setting.

**Nexus per-share difficulty, now in the Node server.** Boards running NexusOS / BM1373 never log `diff X of Y` — they emit only raw stratum JSON. The server now reconstructs each share's difficulty itself (rebuilds the block header, double-SHA, compares to DIFF1) and injects the line the dashboard expects. `extranonce1` and the pool difficulty are captured live and **persisted to disk**, so a server restart resumes from the real values. If it attaches mid-session and hasn't seen a `mining.set_difficulty` yet, it estimates the target from the smallest submitted share, which converges from above within about 20 shares. *This is the biggest gap that was closed — previously Nexus-class miners produced no share data at all on Linux.*

**Script actions for both fans** — `setAsicTargetTemp`, `setVrTargetTemp`, `setVrFanSpeed`. All fan writes echo the miner's `fans[]` array back verbatim and edit only the intended field, which fixes target-temp changes that appeared to do nothing (and the connector-1-stuck-at-90% lock). VR actions skip cleanly on single-fan miners.

**`/fleet` endpoint** — serves fleet hashrate, shares, best difficulty and luck as JSON, for an Apple Watch complication or any external display, reachable over Tailscale.

**Other fixes** — fleet session best now clears when a miner restarts; Min Fan Speed is always available in auto mode; the share stream recovers from a power cycle on its own; miner card spacing tightened.

### Previously

- **Dynamic Governor** (runs in the Node server, always-on) — auto-adjusts frequency/voltage/fan to hold miners inside temperature, VR-temp, and current (amps) bands, with dwell/settle timers, per-profile 24hr scheduling, and restart-after-adjust.
- **Governor amps band** — cap current draw to protect the input connector, not just temperature.
- **Governor fan-step control** — the governor can drive the manual fan (opposite to MHz/mV: hotter raises the fan), with fan floor/ceiling limits.
- **Remove a miner without losing its history** — re-add the same IP later and it reconnects to its data.
- **🧹 Purge Miner** — completely wipe a miner from every store when you want it gone for good.
- **Per-miner all-time clear** — 🗑 to wipe a single miner's all-time Best Diffs or HR Scores (durable; syncs both ways).
- **VR fan control** — mode (Linked / Manual / Auto-PID), manual speed, and PID target temp independent of the ASIC fan.
- **Correct target-temp & min-fan reading across firmwares** (Nexus-class).
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
| `nexus-enonce.json` | Captured `extranonce1` per miner — lets share-difficulty reconstruction survive a server restart |
| `nexus-pooldiff.json` | Last known pool difficulty per miner, for the same reason |

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

## Run on Boot

The desktop app has a "Start with Windows" checkbox. That's Windows-only — on Linux the
server answers `/startup` with `supported:false`, so the checkbox simply stays unchecked
rather than erroring. Use systemd instead, as below.

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
