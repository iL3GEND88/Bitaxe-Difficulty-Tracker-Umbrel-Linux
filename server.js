#!/usr/bin/env node
// Bitaxe Difficulty Tracker - Node.js Server
// For Linux / Umbrel / macOS
// Requires Node.js 18+ (for built-in fetch and WebSocket support)
// Run: node server.js

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');

const PORT = 19248;
const SCRIPT_DIR = __dirname;

// ── In-memory state ────────────────────────────────────────────────────────────
let pendingNotifs = null;
let scriptsCache = null;
let pendingScripts = null;
let arStateCache = null;
let sessionCache = {};
let allTimeCache = null;
let minersCache = null;
let netHashCache = { btc: '{}', bch: '{}', dgb: '{}', xec: '{}', fb: '{}' };
let netHashLastFetch = { btc: 0, bch: 0, dgb: 0, xec: 0, fb: 0 };

// ── Helpers ────────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function json(res, data, status = 200) {
  cors(res);
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function proxyGet(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function proxyPost(url, bodyStr, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: timeoutMs
    };
    const req = http.request(options, (res) => {
      res.resume();
      res.on('end', () => resolve('ok'));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function proxyPatch(url, bodyStr, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: timeoutMs
    };
    const req = http.request(options, (res) => {
      res.resume();
      res.on('end', () => resolve('ok'));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Background nethash fetcher ─────────────────────────────────────────────────
const nethashUrls = {
  btc: 'https://blockchain.info/q/hashrate',
  bch: 'https://blockchain.info/bch/q/hashrate',
  dgb: 'https://chainz.cryptoid.info/dgb/api.dws?q=hashrate',
  xec: 'https://chainz.cryptoid.info/xec/api.dws?q=hashrate',
  fb:  null
};

function fetchNetHash(coin) {
  const url = nethashUrls[coin];
  if (!url) return;
  const now = Math.floor(Date.now() / 1000);
  if (now - netHashLastFetch[coin] < 300) return;
  netHashLastFetch[coin] = now;
  proxyGet(url, 10000)
    .then(val => {
      netHashCache[coin] = JSON.stringify({ hashrate: val.trim(), coin });
    })
    .catch(() => {});
}

// Pre-fetch on startup
Object.keys(nethashUrls).forEach(fetchNetHash);

// ── Serve static files ─────────────────────────────────────────────────────────
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
    cors(res);
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
}

// ── SSE stream proxy ───────────────────────────────────────────────────────────
function handleStream(req, res, ip) {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive'
  });

  console.log(`  [SSE] Browser subscribing to ${ip}`);
  let ws;
  let closed = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    try { ws && ws.close(); } catch (e) {}
    try { res.end(); } catch (e) {}
  }

  req.on('close', cleanup);
  req.on('error', cleanup);

  try {
    ws = new WebSocket(`ws://${ip}/api/ws`, { handshakeTimeout: 6000 });
  } catch (e) {
    res.write(`data: ERROR:${e.message}\n\n`);
    res.end();
    return;
  }

  ws.on('open', () => {
    console.log(`  [SSE] Connected to ${ip}`);
    if (!closed) res.write('data: CONNECTED\n\n');
  });

  ws.on('message', (data) => {
    if (closed) return;
    try {
      const msg = data.toString();
      res.write(`data: ${msg}\n\n`);
    } catch (e) { cleanup(); }
  });

  ws.on('error', (e) => {
    if (!closed) {
      try { res.write(`data: ERROR:${e.message}\n\n`); } catch (_) {}
    }
    cleanup();
  });

  ws.on('close', cleanup);
}

// ── Main request handler ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const path_ = u.pathname;
  const ip = u.searchParams.get('ip');
  const coin = u.searchParams.get('coin') || 'btc';

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // Serve main HTML - redirect mobile browsers to /mobile
  if (path_ === '/' || path_ === '/index.html' || path_ === '/BitaxeDifficultyTracker.html') {
    const ua = req.headers['user-agent'] || '';
    if (/iPhone|iPad|Android/i.test(ua)) {
      cors(res); res.writeHead(302, { Location: '/mobile' }); res.end(); return;
    }
    return serveFile(res, path.join(SCRIPT_DIR, 'BitaxeDifficultyTracker.html'));
  }

  if (path_ === '/mobile') {
    return serveFile(res, path.join(SCRIPT_DIR, 'mobile.html'));
  }

  if (path_ === '/test') {
    return json(res, { ok: true });
  }

  if (path_ === '/shutdown') {
    json(res, { ok: true });
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // ── Miner proxy endpoints ────────────────────────────────────────────────────
  if (path_ === '/api' && ip) {
    try {
      const data = await proxyGet(`http://${ip}/api/system/info`, 4000);
      cors(res); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data);
    } catch (e) {
      json(res, { error: e.message }, 502);
    }
    return;
  }

  if (path_ === '/scoreboard' && ip) {
    try {
      const data = await proxyGet(`http://${ip}/api/system/scoreboard`, 4000);
      cors(res); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data);
    } catch (e) {
      json(res, { error: e.message }, 502);
    }
    return;
  }

  if (path_ === '/stream' && ip) {
    return handleStream(req, res, ip);
  }

  if (path_ === '/restart' && ip) {
    try {
      await proxyPost(`http://${ip}/api/system/restart`, '', 5000);
      console.log(`  [RESTART] Sent restart to ${ip}`);
      cors(res); res.writeHead(200); res.end('ok');
    } catch (e) {
      console.log(`  [RESTART] Failed for ${ip}: ${e.message}`);
      cors(res); res.writeHead(502); res.end(`error: ${e.message}`);
    }
    return;
  }

  if (path_ === '/patch' && ip) {
    try {
      let bodyJson = req.headers['x-body'];
      if (!bodyJson) {
        const freq = req.headers['x-freq'];
        const voltage = req.headers['x-voltage'];
        bodyJson = `{"frequency":${freq},"coreVoltage":${voltage},"overclockEnabled":1}`;
      }
      await proxyPatch(`http://${ip}/api/system`, bodyJson, 5000);
      console.log(`  [PATCH] ${ip} OK`);
      cors(res); res.writeHead(200); res.end('ok');
    } catch (e) {
      cors(res); res.writeHead(502); res.end(`error: ${e.message}`);
    }
    return;
  }

  // ── Nethash ──────────────────────────────────────────────────────────────────
  if (path_ === '/nethash') {
    fetchNetHash(coin);
    const cached = netHashCache[coin] || `{"hashrate":"0","coin":"${coin}"}`;
    cors(res); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(cached);
    return;
  }

  // ── State endpoints ──────────────────────────────────────────────────────────
  if (path_ === '/notifications') {
    const body = await readBody(req);
    if (req.method === 'POST') {
      if (body && body.length > 2) {
        try {
          const newNotifs = JSON.parse(body);
          if (pendingNotifs) {
            const existing = JSON.parse(pendingNotifs);
            const combined = [...existing, ...newNotifs].slice(-50);
            pendingNotifs = JSON.stringify(combined);
          } else {
            pendingNotifs = body;
          }
        } catch { pendingNotifs = body; }
      }
      return json(res, { ok: true });
    } else {
      const out = pendingNotifs || '[]';
      pendingNotifs = null;
      cors(res); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out);
      return;
    }
  }

  if (path_ === '/session') {
    const body = await readBody(req);
    if (req.method === 'POST') {
      try { const d = JSON.parse(body); if (d.ip) sessionCache[d.ip] = d; } catch {}
      return json(res, { ok: true });
    } else {
      return json(res, sessionCache);
    }
  }

  if (path_ === '/alltime') {
    const body = await readBody(req);
    if (req.method === 'POST') {
      allTimeCache = body;
      return json(res, { ok: true });
    } else {
      cors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(allTimeCache || '{}');
      return;
    }
  }

  if (path_ === '/setminers') {
    const body = await readBody(req);
    minersCache = body;
    return json(res, { ok: true });
  }

  if (path_ === '/miners') {
    cors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(minersCache || '{"ips":[],"names":{},"ts":0}');
    return;
  }

  if (path_ === '/scripts') {
    const body = await readBody(req);
    if (req.method === 'POST') {
      scriptsCache = body;
      return json(res, { ok: true });
    } else {
      cors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(scriptsCache || '[]');
      return;
    }
  }

  if (path_ === '/setscripts') {
    const body = await readBody(req);
    pendingScripts = body;
    return json(res, { ok: true });
  }

  if (path_ === '/getscripts') {
    const out = pendingScripts || '[]';
    cors(res); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out);
    return;
  }

  if (path_ === '/setautorestart') {
    return json(res, { ok: true });
  }

  if (path_ === '/getautorestart') {
    return json(res, {});
  }

  if (path_ === '/arstate') {
    const body = await readBody(req);
    if (req.method === 'POST') {
      arStateCache = body;
      return json(res, { ok: true });
    } else {
      cors(res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(arStateCache || '{}');
      return;
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ==========================================');
  console.log(`   Bitaxe Difficulty Tracker`);
  console.log(`   Listening on http://0.0.0.0:${PORT}`);
  console.log(`   Open: http://localhost:${PORT}`);
  console.log('   Keep this window open while using the app');
  console.log('  ==========================================');
  console.log('');
});

server.on('error', (e) => {
  console.error('Server error:', e.message);
});

process.on('SIGINT', () => {
  console.log('\n  [Server] Stopped.');
  process.exit(0);
});
