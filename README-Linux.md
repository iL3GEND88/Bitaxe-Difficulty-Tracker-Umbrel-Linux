# Bitaxe Difficulty Tracker — Linux / Umbrel

This is the Linux/Umbrel version of the Bitaxe Difficulty Tracker. It uses a Node.js server instead of PowerShell, making it compatible with Linux, macOS, Raspberry Pi, and Umbrel.

## Requirements

- **Node.js 18 or higher**
- **npm** (comes with Node.js)

## Installation

### 1. Install Node.js

**Ubuntu / Debian / Raspberry Pi OS:**
```bash
sudo apt update
sudo apt install nodejs npm
```

**Check version (must be 18+):**
```bash
node --version
```

If your version is below 18, install a newer version:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs
```

**macOS:**
```bash
brew install node
```

### 2. Download and Extract

Download the Linux zip from GitHub and extract it to a folder.

### 3. Install Dependencies

```bash
cd BitaxeDifficultyTracker-Linux
npm install
```

This installs the `ws` WebSocket library (the only dependency).

### 4. Run the Server

```bash
./launch.sh
```

Or manually:
```bash
node server.js
```

The server starts on port **19248**.

- **Desktop browser:** Open `http://localhost:19248`
- **iPhone/Android:** Open `http://YOUR_SERVER_IP:19248` in Safari or Chrome

## Umbrel

### Running Manually on Umbrel

1. SSH into your Umbrel:
   ```bash
   ssh umbrel@umbrel.local
   ```

2. Install Node.js if not already installed:
   ```bash
   sudo apt install nodejs npm
   ```

3. Copy the files to your Umbrel (via SCP or a USB drive):
   ```bash
   scp -r BitaxeDifficultyTracker-Linux umbrel@umbrel.local:~/
   ```

4. Install dependencies and run:
   ```bash
   cd ~/BitaxeDifficultyTracker-Linux
   npm install
   node server.js
   ```

5. Access from your phone at `http://umbrel.local:19248`

### Run on Boot (systemd)

To have the server start automatically when Umbrel boots:

```bash
sudo nano /etc/systemd/system/bitaxe-tracker.service
```

Paste this (adjust the path):
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

Enable and start:
```bash
sudo systemctl enable bitaxe-tracker
sudo systemctl start bitaxe-tracker
```

Check status:
```bash
sudo systemctl status bitaxe-tracker
```

## Firewall

If you can't connect from your phone, open port 19248:

```bash
sudo ufw allow 19248
```

## Notes

- The Windows app (`BitaxeDifficultyTracker.html`) is still required on the machine that is **connected to your miners** via the local network. The Linux/Umbrel server is the **backend proxy** — it does not connect to miners directly in the same way.
- All data (miners, settings, all-time records) is stored in the **browser's localStorage** on whatever device you use to access the app.
- The iOS companion app (`mobile.html`) works the same as the Windows version — just point your phone to `http://YOUR_SERVER_IP:19248`.

## Tailscale (Remote Access)

Install Tailscale on your Umbrel or Linux machine for secure remote access:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Then access from anywhere using your Tailscale IP: `http://100.x.x.x:19248`
