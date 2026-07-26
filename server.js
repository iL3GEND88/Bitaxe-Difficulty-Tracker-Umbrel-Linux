#!/usr/bin/env node
// Bitaxe Difficulty Tracker - Node.js Server
// For Linux / Umbrel / macOS
// Requires Node.js 18+

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { WebSocket } = require('ws');
const crypto = require('crypto');

const PORT       = 19248;
const SCRIPT_DIR = __dirname;

// ── Persistence files ──────────────────────────────────────────────────────────
const MINERS_FILE   = path.join(SCRIPT_DIR, 'miners-data.json');
const SETTINGS_FILE = path.join(SCRIPT_DIR, 'settings-data.json');
const ALLTIME_FILE  = path.join(SCRIPT_DIR, 'alltime-data.json');
const SCRIPTS_FILE  = path.join(SCRIPT_DIR, 'scripts-data.json');
const GOVERNORS_FILE = path.join(SCRIPT_DIR, 'governors-data.json');

// ── Unified data store ───────────────────────────────────────────────────────
// Same single file and same section names as the Windows build, so
// bitaxe-data.json can be moved between a Windows box and this one unchanged.
// Node parses JSON fast enough that the string-concatenation trick used in the
// PowerShell version isn't needed here.
const DATA_FILE = path.join(SCRIPT_DIR, 'bitaxe-data.json');
const STORE_MIN_MS = 5000;
let storeDirty = false, lastFlush = 0, lastPsig = null;
let degCache = null, runlogCache = null, govStoreCache = null, ambLogCache = null;
let pendingUwCfg = null;   // consumed on read, like the other mobile write channels

function saveStore(force){
  const now = Date.now();
  if(!force){
    if(!storeDirty) return;
    if(now - lastFlush < STORE_MIN_MS) return;
  }
  try{
    const out = {
      v: 1,
      session:     (sessionCache && Object.keys(sessionCache).length) ? sessionCache : null,
      scripts:     scriptsCache   ? safeParse(scriptsCache)   : null,
      reports:     reportsCache   ? safeParse(reportsCache)   : null,
      degradation: degCache       ? safeParse(degCache)       : null,
      runlog:      runlogCache    ? safeParse(runlogCache)    : null,
      governors:   govStoreCache  ? safeParse(govStoreCache)  : null,
      alltime:     allTimeCache   ? safeParse(allTimeCache)   : null,
      ambientlog:  ambLogCache    ? safeParse(ambLogCache)    : null
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(out), 'utf8');   // no BOM, unlike the old PS writer
    storeDirty = false; lastFlush = now;
  }catch(e){ console.log('  [Server] store write failed:', e.message); }
}
function safeParse(t){ try{ return JSON.parse(t); }catch(e){ return null; } }
function sect(o, k){ const v = o && o[k]; return (v==null) ? null : JSON.stringify(v); }

function loadStore(){
  if(fs.existsSync(DATA_FILE)){
    try{
      const o = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if(o.session && typeof o.session === 'object') sessionCache = o.session;
      scriptsCache  = sect(o,'scripts');
      reportsCache  = sect(o,'reports');
      degCache      = sect(o,'degradation');
      runlogCache   = sect(o,'runlog');
      govStoreCache = sect(o,'governors');
      allTimeCache  = sect(o,'alltime');
      ambLogCache   = sect(o,'ambientlog');
      console.log('  [Server] Loaded bitaxe-data.json');
      return true;
    }catch(e){ console.log('  [Server] bitaxe-data.json unreadable:', e.message); }
  }
  return false;
}


// ── In-memory state ────────────────────────────────────────────────────────────
let pendingNotifs = null;
let scriptsCache  = null;
let pendingScripts = null;
let arStateCache  = null;
let reportsCache   = null;
let fleetCache     = null;   // dumb cache: desktop computes fleetStats() and POSTs it here
let pendingReports = null;
let hrAllTimeCache = null;
let pendingClearSession = null;
let pendingHrDelete = null;    // per-entry or whole-miner HR clear -> desktop clears local copy
let pendingDiffClear = null;   // whole-miner all-time diff clear -> desktop clears local copy
let allTimeCache  = null;
let minersCache   = null;

// Build labeled temps array: ASIC (temp,temp2..) + VR (vrTemp,vrTemp2..,vrr..).
// Single sensor -> plain label ('ASIC','VR'); multiple -> numbered. Mirrors the client.
function buildTempsArray(d){
  const asics=[], vrs=[];
  if(d.temp!=null && d.temp>0) asics.push(d.temp);
  for(let i=2;i<=16;i++){ if(d['temp'+i]!=null && d['temp'+i]>0) asics.push(d['temp'+i]); }
  if(d.vrTemp!=null && d.vrTemp>0) vrs.push(d.vrTemp);
  for(let j=2;j<=16;j++){ if(d['vrTemp'+j]!=null && d['vrTemp'+j]>0) vrs.push(d['vrTemp'+j]); }
  if(d.vrr!=null && d.vrr>0) vrs.push(d.vrr);
  for(let k=2;k<=16;k++){ if(d['vrr'+k]!=null && d['vrr'+k]>0) vrs.push(d['vrr'+k]); }
  const out=[];
  asics.forEach((v,idx)=>out.push({label: asics.length>1?('ASIC '+(idx+1)):'ASIC', val:v, isVR:false, kind:'asic', idx}));
  vrs.forEach((v,idx)=>out.push({label: vrs.length>1?('VR '+(idx+1)):'VR', val:v, isVR:true, kind:'vr', idx}));
  return out;
}

let netHashCache  = { btc:'{}', bch:'{}', dgb:'{}', xec:'{}', fb:'{}' };
let netHashLastFetch = { btc:0, bch:0, dgb:0, xec:0, fb:0 };

// ── Miner state (for standalone mode) ─────────────────────────────────────────
const minerState = {}; // ip -> miner data object
const minerWS    = {}; // ip -> WebSocket connection
const minerPoll  = {}; // ip -> poll interval

// ── Diff parsing (same as Windows app) ────────────────────────────────────────
const DIFF_RE    = /diff[:\s]+([\d.]+)\s+of\s+([\d.]+)/i;
const POOLDIFF_RE = /(?:stratum\s+)?difficulty\s+(?:set\s+to|changed\s+to|:)\s*([\d.]+)/i;
const BLOCK_RE   = /block\s*found/i;
const DIFF_RE1B  = /diff\s+([\d.]+)\/([\d.]+)/i;
const DIFF_RE2   = /(?:share\s+diff|difficulty)[:\s]+([\d.]+)[^\d]+(?:pool\s+diff|target|of)[:\s\/]+([\d.]+)/i;
const DIFF_RE3   = /([\d.]+)\s*\/\s*([\d.]+).*diff/i;

function stripAnsi(s){
  return s.replace(/\x1B\[[0-9;]*[mGKHF]/g,'')
          .replace(/\x1B\([0-9A-Z]/g,'')
          .replace(/[\x00-\x08\x0E-\x1F\x7F]/g,'');
}

function parseDiffLine(line){
  let m = DIFF_RE.exec(line);   if(m) return {found:parseFloat(m[1]),target:parseFloat(m[2])};
  m = DIFF_RE1B.exec(line);     if(m) return {found:parseFloat(m[1]),target:parseFloat(m[2])};
  m = DIFF_RE2.exec(line);      if(m) return {found:parseFloat(m[1]),target:parseFloat(m[2])};
  m = DIFF_RE3.exec(line);      if(m) return {found:parseFloat(m[1]),target:parseFloat(m[2])};
  return null;
}

function parseDiff(v){
  if(typeof v==='number') return v;
  if(typeof v==='string'){
    const m=v.match(/^([\d.]+)([KMGT]?)$/i);
    if(!m) return 0;
    const n=parseFloat(m[1]),s=m[2].toUpperCase();
    if(s==='T') return n*1e12; if(s==='G') return n*1e9;
    if(s==='M') return n*1e6;  if(s==='K') return n*1e3; return n;
  } return 0;
}

function fmtD(v){
  if(v>=1e12) return (v/1e12).toFixed(2)+'T';
  if(v>=1e9)  return (v/1e9).toFixed(2)+'G';
  if(v>=1e6)  return (v/1e6).toFixed(2)+'M';
  if(v>=1e3)  return (v/1e3).toFixed(2)+'K';
  return v.toFixed(2);
}

// ── Miner connection ───────────────────────────────────────────────────────────
function initMinerState(ip, name, color){
  if(!minerState[ip]){
    minerState[ip] = {
      ip, name:name||'', color:color||'#f7931a',
      series:[], hashSeries:[], topSeries:[],
      sharesFound:0, sharesAccepted:0,
      bestDiff:0, sessionBest:0,
      lastDiff:0, lastTarget:0,
      lastFoundTs:null, connectedAt:null,
      poolDifficulty:null,
      axeOSHashrate:null, axeOSPower:null, axeOSCurrent:null,
      axeOSUptime:null, axeOSShares:null,
      axeOSRejected:null, axeOSBestDiff:null,
      axeOSSessionBest:null, axeOSErrorRate:null,
      temps:[], status:'—', autoRestart:false
    };
  }
  return minerState[ip];
}


// ═══════════════════════════════════════════════════════════════════════════
//  Nexus per-share difficulty reconstruction
//
//  NexusOS / BM1373 firmware never logs "asic_result ... diff X of Y" — it emits
//  only the raw stratum JSON. So we watch the stratum exchange, rebuild the block
//  header ourselves, double-SHA it, and inject a "Nexus share diff X of Y" line
//  the dashboard's existing parser already understands.
//
//  Byte order is locked and verified against real captures: prevhash is
//  word-swapped, version rolling is applied through the mask, ver/ntime/nbits/
//  nonce are little-endian, merkle branches are used as-is, and the final digest
//  is reversed before comparing to DIFF1.
// ═══════════════════════════════════════════════════════════════════════════
const NX_ENONCE_FILE = path.join(SCRIPT_DIR, 'nexus-enonce.json');
const NX_DIFF_FILE   = path.join(SCRIPT_DIR, 'nexus-pooldiff.json');
const NX_DIFF1 = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');

function nxLoadStore(f){ try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return {}; } }
function nxSaveStore(f,ip,val){
  try{ const m=nxLoadStore(f); m[ip]=val; fs.writeFileSync(f,JSON.stringify(m),'utf8'); }catch(e){}
}

const nxHex   = h => Buffer.from(h,'hex');
const nxSha   = b => crypto.createHash('sha256').update(b).digest();
const nxSha2  = b => nxSha(nxSha(b));
function nxSwap32(b){
  const o=Buffer.alloc(b.length);
  for(let i=0;i<b.length;i+=4){ o[i]=b[i+3]; o[i+1]=b[i+2]; o[i+2]=b[i+1]; o[i+3]=b[i]; }
  return o;
}
function nxU32LE(v){ const b=Buffer.alloc(4); b.writeUInt32LE(v>>>0,0); return b; }

function nxShareDiff(en1, job, en2, ntimeHex, nonceHex, vbitsHex, mask){
  // merkle root from the coinbase we can reconstruct
  let mr = nxSha2(Buffer.concat([nxHex(job.coinb1), nxHex(en1), nxHex(en2), nxHex(job.coinb2)]));
  for(const br of job.merkle) mr = nxSha2(Buffer.concat([mr, nxHex(br)]));

  const jv   = parseInt(job.version,16)>>>0;
  const vb   = parseInt(vbitsHex,16)>>>0;
  const nm   = (0xFFFFFFFF ^ mask)>>>0;
  const hver = (((jv & nm)>>>0) | ((vb & mask)>>>0))>>>0;

  const header = Buffer.concat([
    nxU32LE(hver),
    nxSwap32(nxHex(job.prevhash)),
    mr,
    nxU32LE(parseInt(ntimeHex,16)),
    nxU32LE(parseInt(job.nbits,16)),
    nxU32LE(parseInt(nonceHex,16))
  ]);
  const h = Buffer.from(nxSha2(header)).reverse();
  const H = BigInt('0x'+h.toString('hex'));
  if(H <= 0n) return 0;
  return Number(NX_DIFF1 * 1000000n / H) / 1e6;
}

const nxState = {};   // per-IP stratum state
function nxInit(ip){
  if(nxState[ip]) return nxState[ip];
  const savedEn = nxLoadStore(NX_ENONCE_FILE)[ip] || null;
  const savedD  = parseInt(nxLoadStore(NX_DIFF_FILE)[ip],10) || 0;
  if(savedEn) console.log(`  [Nexus] using saved extranonce1 ${savedEn} for ${ip}`);
  if(savedD)  console.log(`  [Nexus] using saved pool difficulty ${savedD} for ${ip}`);
  nxState[ip] = {
    en1: savedEn, mask: 0x1fffe000,
    poolDiff: savedD>0 ? savedD : 10000,
    diffKnown: savedD>0,
    jobs: {}, order: [], sub: 0,
    minSeen: 0, minCount: 0
  };
  return nxState[ip];
}

// Returns a synthesized log line to inject, or null.
function nxOnLine(ip, line){
  if(!/mining\.|extranonce_str|version mask/.test(line)) return null;
  const st = nxInit(ip);
  try{
    let m;
    if((m = /extranonce_str:\s*([0-9a-fA-F]+)/.exec(line))){
      if(st.en1 !== m[1]){ st.en1 = m[1]; nxSaveStore(NX_ENONCE_FILE, ip, st.en1);
        console.log(`  [Nexus] extranonce1 captured ${st.en1} for ${ip} (saved)`); }
      return null;
    }
    if((m = /version mask:\s*([0-9a-fA-F]+)/.exec(line))){ st.mask = parseInt(m[1],16); return null; }
    if(!/"method":\s*"mining\.(notify|submit|set_difficulty)"/.test(line) &&
       !/"result":\[\[\["mining\.notify"/.test(line)) return null;

    const j = JSON.parse(line.substring(line.indexOf('{')));

    // subscribe response carries extranonce1 as result[1]
    if(j.result && j.result.length >= 2){
      const e = String(j.result[1]);
      if(st.en1 !== e){ st.en1 = e; nxSaveStore(NX_ENONCE_FILE, ip, e);
        console.log(`  [Nexus] extranonce1 captured ${e} for ${ip} (saved)`); }
      return null;
    }

    if(j.method === 'mining.set_difficulty'){
      const nd = parseInt(j.params[0],10);
      if(nd > 0){
        if(nd !== st.poolDiff) console.log(`  [Nexus] pool difficulty ${st.poolDiff} -> ${nd} for ${ip} (saved)`);
        st.poolDiff = nd; nxSaveStore(NX_DIFF_FILE, ip, nd);
      }
      st.diffKnown = true; st.minSeen = 0; st.minCount = 0;
      return null;
    }

    if(j.method === 'mining.notify'){
      const jid = String(j.params[0]);
      st.jobs[jid] = { prevhash:String(j.params[1]), coinb1:String(j.params[2]),
                       coinb2:String(j.params[3]), merkle:j.params[4],
                       version:String(j.params[5]), nbits:String(j.params[6]) };
      st.order.push(jid);
      while(st.order.length > 12){ delete st.jobs[st.order.shift()]; }
      return null;
    }

    if(j.method === 'mining.submit'){
      st.sub++;
      const job = st.jobs[String(j.params[1])];
      if(job && st.en1){
        const d = nxShareDiff(st.en1, job, String(j.params[2]), String(j.params[3]),
                              String(j.params[4]), String(j.params[5]), st.mask);
        if(d > 0){
          // No set_difficulty seen yet: infer the target from the smallest share
          // submitted. The miner never submits below target, so it converges from above.
          if(!st.diffKnown){
            if(st.minSeen <= 0 || d < st.minSeen) st.minSeen = d;
            st.minCount++;
            if(st.minCount >= 20 && st.minSeen > 0){
              const est = Math.round(st.minSeen);
              if(est > 0 && Math.abs(est - st.poolDiff)/st.poolDiff > 0.15){
                console.log(`  [Nexus] no set_difficulty yet; estimated pool difficulty ${est} from ${st.minCount} shares (was ${st.poolDiff})`);
                st.poolDiff = est; nxSaveStore(NX_DIFF_FILE, ip, est);
              }
              st.minCount = 0; st.minSeen = 0;
            }
          }
          return `Nexus share  diff ${d.toFixed(1)} of ${st.poolDiff}`;
        }
      } else if(st.sub <= 3 || st.sub % 25 === 0){
        console.log(`  [Nexus] submit seen, cannot compute yet (en1=${!!st.en1} jobCached=${!!job}) - if en1 is false, reboot the Nexus once while the tracker is running`);
      }
    }
  }catch(e){ if(nxState[ip] && nxState[ip].sub <= 5) console.log(`  [Nexus] parse note: ${e.message}`); }
  return null;
}

function connectMiner(ip, name, color){
  if(minerWS[ip]) return; // already connected
  const m = initMinerState(ip, name, color);
  m.status = 'Connecting…';

  function connect(){
    if(minerWS[ip]) return;
    console.log(`  [WS] Connecting to ${ip}`);
    let ws;
    try {
      ws = new WebSocket(`ws://${ip}/api/ws`, { handshakeTimeout: 6000 });
    } catch(e) {
      m.status = 'Error'; setTimeout(connect, 5000); return;
    }
    minerWS[ip] = ws;

    ws.on('open', () => {
      console.log(`  [WS] Connected: ${ip}`);
      m.status = 'Live';
      m.connectedAt = Date.now();
    });

    ws.on('message', (data) => {
      try {
        const msg = data.toString();
        // Also forward to any SSE subscribers
        if(sseClients[ip]) sseClients[ip].forEach(res => {
          try { res.write(`data: ${msg}\n\n`); } catch(e){}
        });

        // ── Nexus per-share difficulty ──
        // Boards that never log "diff X of Y" get the line synthesized here from
        // the raw stratum exchange, so the chart and luck maths see their shares.
        try {
          const nxLine = nxOnLine(ip, stripAnsi(msg));
          if(nxLine && sseClients[ip]) sseClients[ip].forEach(res => {
            try { res.write(`data: ${nxLine}\n\n`); } catch(e){}
          });
        } catch(e){}
        // Parse log lines for difficulty
        const parsed = JSON.parse(msg);
        if(parsed && parsed.log){
          const line = stripAnsi(parsed.log);
          if(BLOCK_RE.test(line)){
            addNotification(ip, 'BLOCK FOUND! '+ip);
          }
          const pdm = POOLDIFF_RE.exec(line);
          if(pdm){
            const newTarget = parseFloat(pdm[1]);
            if(newTarget>0) m.poolDifficulty = newTarget;
            return;
          }
          const result = parseDiffLine(line);
          if(result){
            const {found, target} = result;
            const effectiveTarget = m.poolDifficulty||target;
            const accepted = found >= effectiveTarget;
            m.lastDiff = found; m.lastTarget = effectiveTarget;
            m.sharesFound++;
            if(accepted){
              m.sharesAccepted++;
              if(found > m.bestDiff) m.bestDiff = found;
            }
            if(found > m.sessionBest) m.sessionBest = found;
            const nowTs = Date.now();
            m.lastFoundTs = nowTs;
            m.series.push({ts:nowTs, found, target:effectiveTarget, accepted});
            if(m.series.length > 30000) m.series.shift();
            // Track top series
            if(!m.topSeries) m.topSeries = [];
            m.topSeries.push({ts:nowTs, found, target:effectiveTarget, accepted});
            m.topSeries.sort((a,b)=>b.found-a.found);
            if(m.topSeries.length > 500) m.topSeries = m.topSeries.slice(0,500);
          }
        }
      } catch(e){}
    });

    ws.on('error', (e) => {
      console.log(`  [WS] Error ${ip}: ${e.message}`);
      m.status = 'Error';
    });

    ws.on('close', () => {
      console.log(`  [WS] Closed: ${ip} — reconnecting in 5s`);
      minerWS[ip] = null;
      m.status = 'Reconnecting…';
      setTimeout(connect, 5000);
    });
  }

  connect();
}

function addNotification(ip, msg){
  const notif = [{ip, msg, ts:Date.now()}];
  if(pendingNotifs){
    try { const ex = JSON.parse(pendingNotifs); pendingNotifs = JSON.stringify([...ex,...notif].slice(-50)); }
    catch { pendingNotifs = JSON.stringify(notif); }
  } else { pendingNotifs = JSON.stringify(notif); }
}

// ── SSE clients (for browser stream forwarding) ────────────────────────────────
const sseClients = {}; // ip -> [res, ...]

// ── Poll miner API every 2 seconds ────────────────────────────────────────────
function startMinerPoll(ip){
  if(minerPoll[ip]) return;
  minerPoll[ip] = setInterval(async () => {
    const m = minerState[ip]; if(!m) return;
    try {
      const data = await proxyGet(`http://${ip}/api/system/info`, 4000);
      const d = JSON.parse(data);
      const temps = buildTempsArray(d);
      m.temps = temps;
      // Stash live control inputs for the governor engine
      m._lastApiData = d;
      if(d.uptimeSeconds!=null) m.axeOSUptime = d.uptimeSeconds;
      // current draw (amps) for the governor amps-band: prefer currentA, else mA->A
      if(d.currentA!=null) m.axeOSCurrent = d.currentA;
      else if(d.current!=null) m.axeOSCurrent = d.current/1000;
      const hrInst = d.hashRate!=null?d.hashRate:(d.hashrate!=null?d.hashrate:null);
      const hr = hrInst!=null?hrInst:(d.hashRate_1m!=null?d.hashRate_1m:null);
      if(hr!=null){
        m.axeOSHashrate = hr;
        m.hashSeries = m.hashSeries||[];
        m.hashSeries.push({ts:Date.now(),hr,hr1m:d.hashRate_1m||hr,hr10m:d.hashRate_10m||hr,hr1h:d.hashRate_1h||hr,temps:temps.slice(),pwr:d.power||0});
        if(m.hashSeries.length>30000) m.hashSeries.shift();
      }
      if(d.bestDiff!=null) m.axeOSBestDiff = d.bestDiff;
      if(d.bestSessionDiff!=null) m.axeOSSessionBest = d.bestSessionDiff;
      if(d.sharesAccepted!=null) m.axeOSShares = d.sharesAccepted;
      if(d.sharesRejected!=null) m.axeOSRejected = d.sharesRejected;
      if(d.errorPercentage!=null) m.axeOSErrorRate = d.errorPercentage;
      if(d.power!=null) m.axeOSPower = d.power;
      if(m.status!=='Live') m.status = 'Live';
    } catch(e){}
  }, 2000);
}

// ── Push session data every 2 seconds ─────────────────────────────────────────
setInterval(() => {
  const out = {};
  Object.values(minerState).forEach(m => {
    if(!m.ip) return;
    const acc = m.series.filter(p=>p.accepted);
    let avgStr = '—';
    if(acc.length>=2){
      let total=0;
      for(let i=1;i<acc.length;i++) total+=acc[i].ts-acc[i-1].ts;
      const avgSec=(total/(acc.length-1))/1000;
      avgStr=avgSec<60?avgSec.toFixed(1)+'s':Math.floor(avgSec/60)+'m '+Math.round(avgSec%60)+'s';
    }
    const recentSeries = m.series.slice(-120);
    const hashPts = (m.hashSeries||[]).slice(-200);
    const stalled = m.status==='Live'&&(
      (m.lastFoundTs&&(Date.now()-m.lastFoundTs>30000))||
      (!m.lastFoundTs&&m.connectedAt&&(Date.now()-m.connectedAt>30000))
    );
    out[m.ip] = {
      avgShare:avgStr,
      top10:(m.topSeries&&m.topSeries.length?m.topSeries:m.series).slice().sort((a,b)=>b.found-a.found).slice(0,500),
      series:recentSeries,
      hashSeries:hashPts,
      hashrate:m.axeOSHashrate,
      efficiency:(m.axeOSPower&&m.axeOSHashrate&&m.axeOSHashrate>0)?parseFloat((m.axeOSPower/m.axeOSHashrate*1000).toFixed(1)):null,
      temps:m.temps||[],
      uptime:m.axeOSUptime,
      shares:m.axeOSShares,
      rejected:m.axeOSRejected,
      bestDiff:m.axeOSBestDiff,
      sessionBest:m.axeOSSessionBest,
      lastDiff:m.lastDiff,
      lastTarget:m.lastTarget,
      errorRate:m.axeOSErrorRate,
      power:m.axeOSPower,
      status:m.status,
      stalled:!!stalled,
      autoRestart:m.autoRestart||false,
      color:m.color,
      name:m.name||''
    };
  });
  // Store in session cache keyed by IP
  Object.entries(out).forEach(([ip,data]) => { sessionCache[ip] = data; });
}, 2000);

let sessionCache = {};

// ── Load persisted data on startup ─────────────────────────────────────────────
try {
  if(fs.existsSync(MINERS_FILE)){
    minersCache = fs.readFileSync(MINERS_FILE,'utf8');
    // Connect to persisted miners
    try {
      const parsed = JSON.parse(minersCache);
      const ips = parsed.ips||[];
      const names = parsed.names||{};
      // Don't connect to hardcoded defaults - only persisted miners
      ips.forEach(ip => {
        const key = ip.replace(/[.]/g,'_');
        connectMiner(ip, names[key]||'', '#f7931a');
        startMinerPoll(ip);
      });
      console.log(`  [Server] Loaded ${ips.length} miners from file`);
    } catch(e){}
  }
  // Unified store first. Only fall back to the individual legacy files when it
  // doesn't exist yet, then write the combined one so the migration is one-way.
  const _unified = loadStore();
  if(!_unified){
    if(fs.existsSync(ALLTIME_FILE)){ allTimeCache=fs.readFileSync(ALLTIME_FILE,'utf8'); console.log('  [Server] Loaded all-time data (legacy)'); }
    if(fs.existsSync(SCRIPTS_FILE)){ scriptsCache=fs.readFileSync(SCRIPTS_FILE,'utf8'); console.log('  [Server] Loaded scripts (legacy)'); }
    saveStore(true);
    console.log('  [Server] Migrated legacy files into bitaxe-data.json');
  }
  if(fs.existsSync(GOVERNORS_FILE)){ try{ _govLoadFrom(fs.readFileSync(GOVERNORS_FILE,'utf8')); console.log('  [Server] Loaded governors'+(_govEnabled?' (ON)':' (off)')); }catch(e){} }
} catch(e){ console.log('  [Server] Could not load data files:', e.message); }

// ── Helpers ────────────────────────────────────────────────────────────────────
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','*');
}
function json(res,data,status=200){
  cors(res);
  const body=typeof data==='string'?data:JSON.stringify(data);
  res.writeHead(status,{'Content-Type':'application/json'});
  res.end(body);
}
function readBody(req){
  return new Promise(resolve=>{
    let body='';
    req.on('data',chunk=>body+=chunk);
    req.on('end',()=>resolve(body));
    req.on('error',()=>resolve(''));
  });
}
function proxyGet(url,timeoutMs=4000){
  return new Promise((resolve,reject)=>{
    const mod=url.startsWith('https')?https:http;
    const req=mod.get(url,{timeout:timeoutMs},res=>{
      let data='';
      res.on('data',chunk=>data+=chunk);
      res.on('end',()=>resolve(data));
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject);
  });
}
function proxyPatch(url,bodyStr,timeoutMs=5000){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const options={hostname:u.hostname,port:u.port||80,path:u.pathname,method:'PATCH',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bodyStr)},timeout:timeoutMs};
    const req=http.request(options,res=>{res.resume();res.on('end',()=>resolve('ok'));});
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject);
    req.write(bodyStr); req.end();
  });
}
function proxyPost(url,bodyStr,timeoutMs=5000){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const options={hostname:u.hostname,port:u.port||80,path:u.pathname,method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bodyStr)},timeout:timeoutMs};
    const req=http.request(options,res=>{res.resume();res.on('end',()=>resolve('ok'));});
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject);
    req.write(bodyStr); req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMIC GOVERNOR ENGINE (server-side, Node) — Linux/Umbrel lead node.
// Runs the control loop here so governance works without any browser open.
// Faithful port of the Windows browser engine: per-sensor bands, dwell/settle,
// fan gates, floor/ceiling clamping, restart-after, 24hr windows.
// ═══════════════════════════════════════════════════════════════════════════════
let governorsCache = null;     // canonical JSON {enabled, data:{ip:[profiles]}} (for /governors read)
let pendingGovernors = null;   // mobile/web writes -> picked up if a remote editor changes it
let _govData = {};             // {ip:[profiles]}
let _govEnabled = false;
const _govState = {};          // runtime per-ip: {lastActionTs,lastDir,outOfBandSince,dir}

function _govLoadFrom(jsonStr){
  try{
    const o = JSON.parse(jsonStr);
    if(o && typeof o==='object'){
      if(o.data && typeof o.data==='object'){ _govData = o.data; _govEnabled = !!o.enabled; }
      else { _govData = o; } // tolerate bare {ip:[...]}
      governorsCache = JSON.stringify({enabled:_govEnabled, data:_govData});
      try{ fs.writeFileSync(GOVERNORS_FILE, governorsCache); }catch(e){}
    }
  }catch(e){}
}

function _nowHHMM(){ const d=new Date(); return d.getHours()*100+d.getMinutes(); }
function _govWindowActive(p){
  if(p.allDay) return true;
  const now=_nowHHMM(), s=p.startHHMM, e=p.endHHMM;
  if(s==null||e==null) return false;
  if(s===e) return false;
  if(s<e) return now>=s && now<e;
  return now>=s || now<e; // wraps midnight
}
function _activeGovernor(ip){
  const list=_govData[ip]||[];
  for(let i=0;i<list.length;i++){ if(list[i].enabled && _govWindowActive(list[i])) return list[i]; }
  return null;
}

function runGovernorFor(ip){
  if(!_govEnabled) return;
  const m = minerState[ip]; if(!m || !m.ip) return;
  const p = _activeGovernor(ip); if(!p) return;
  const d = m._lastApiData; if(!d) return;
  // Uptime gate
  if(m.axeOSUptime==null || m.axeOSUptime < (p.uptimeMin||0)*60) return;

  const fan = d.fanspeed!=null ? d.fanspeed : null;
  const curFreq = d.frequency!=null ? d.frequency : null;
  const curVolt = d.coreVoltage!=null ? d.coreVoltage : null;
  if(curFreq===null && curVolt===null) return;

  const st = _govState[ip] || (_govState[ip]={lastActionTs:0,lastDir:0,outOfBandSince:0,dir:0});

  // Settle: pause after any adjustment
  if(st.lastActionTs && (Date.now()-st.lastActionTs) < (p.settleSec||0)*1000) return;

  // Per-sensor evaluation: any sensor too hot -> down (wins); any too cool -> up. Blank band ignored.
  function bandDir(val, band){
    if(val==null || !band) return 0;
    if(band.max!=null && val>band.max) return -1;
    if(band.min!=null && val<band.min) return +1;
    return 0;
  }
  const asicBands=p.asicBands||[], vrBands=p.vrBands||[];
  let anyHot=false, anyCool=false;
  (m.temps||[]).forEach(t=>{
    const band = (t.kind==='vr') ? vrBands[t.idx] : asicBands[t.idx];
    const dd = bandDir(t.val, band);
    if(dd<0) anyHot=true; else if(dd>0) anyCool=true;
  });
  // Amps band — total current draw (single scalar). Over max is protective (like a
  // too-hot sensor); under min allows a step up (both-ways).
  if(p.ampsBand && m.axeOSCurrent!=null){
    const adir = bandDir(m.axeOSCurrent, p.ampsBand);
    if(adir<0) anyHot=true; else if(adir>0) anyCool=true;
  }
  let dir = anyHot ? -1 : (anyCool ? 1 : 0);
  if(!p.bothWays && dir>0) dir=0;
  if(dir===0){ st.outOfBandSince=0; st.dir=0; return; }

  // Fan gates
  if(dir<0){ if(p.fanStepDownMin!=null && fan!=null && fan < p.fanStepDownMin){ st.outOfBandSince=0; return; } }
  else     { if(p.fanStepUpMax!=null   && fan!=null && fan > p.fanStepUpMax){   st.outOfBandSince=0; return; } }

  // Reverse-direction lockout: reversing waits out dwell since last action
  if(st.lastDir!==0 && dir!==st.lastDir){
    if(st.lastActionTs && (Date.now()-st.lastActionTs) < (p.dwellSec||0)*1000) return;
  }
  // Dwell: sustained out of band
  if(st.dir!==dir){ st.dir=dir; st.outOfBandSince=Date.now(); }
  if(!st.outOfBandSince) st.outOfBandSince=Date.now();
  if((Date.now()-st.outOfBandSince) < (p.dwellSec||0)*1000) return;

  // Compute new freq/volt within floor/ceiling
  let newFreq=curFreq, newVolt=curVolt, changed=false;
  if(p.mhzStep && curFreq!=null){
    let nf=curFreq + dir*p.mhzStep;
    if(p.mhzFloor!=null) nf=Math.max(nf, p.mhzFloor);
    if(p.mhzCeil!=null)  nf=Math.min(nf, p.mhzCeil);
    if(nf!==curFreq){ newFreq=nf; changed=true; }
  }
  if(p.mvStep && curVolt!=null){
    let nv=curVolt + dir*p.mvStep;
    if(p.mvFloor!=null) nv=Math.max(nv, p.mvFloor);
    if(p.mvCeil!=null)  nv=Math.min(nv, p.mvCeil);
    if(nv!==curVolt){ newVolt=nv; changed=true; }
  }
  // Manual fan % target — steps OPPOSITE to freq/volt: too hot -> fan UP, too cool -> fan DOWN.
  const curFan = (fan!=null) ? Math.round(fan) : null;
  const fanGoverned = (p.fanStep!=null && p.fanStep!=='' && curFan!=null);
  let newFan = curFan;
  if(fanGoverned){
    let nfan = curFan + (-dir)*p.fanStep;
    const fFlo=(p.fanFloor!=null)?p.fanFloor:0, fCei=(p.fanCeil!=null)?p.fanCeil:100;
    nfan = Math.max(fFlo, Math.min(fCei, nfan));
    if(nfan!==curFan){ newFan=nfan; changed=true; }
  }
  if(!changed) return;

  const body={frequency:newFreq, coreVoltage:newVolt, overclockEnabled:1,
    autofanspeed: fanGoverned ? 0 : (d.autofanspeed?1:0),
    manualFanSpeed: fanGoverned ? newFan : (d.fanspeed||100),
    temptarget:d.tempTarget||d.temptarget||60, minfanspeed:d.minFanSpeed!=null?d.minFanSpeed:0};
  proxyPatch(`http://${ip}/api/system`, JSON.stringify(body), 5000).then(()=>{
    if(p.restartAfter){ setTimeout(()=>{ proxyPost(`http://${ip}/api/system/restart`,'',6000).catch(()=>{}); }, 1500); }
  }).catch(()=>{});
  st.lastActionTs=Date.now(); st.lastDir=dir; st.outOfBandSince=0; st.dir=0;
  console.log(`[governor] ${m.name||ip}: ${dir<0?'down':'up'} -> ${p.mhzStep?newFreq+'MHz ':''}${p.mvStep?newVolt+'mV':''}`);
}

function runAllGovernors(){ Object.keys(minerState).forEach(ip=>{ try{ runGovernorFor(ip); }catch(e){} }); }
setInterval(runAllGovernors, 5000);

function serveFile(res,filePath){
  fs.readFile(filePath,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    const ext=path.extname(filePath);
    const types={'.html':'text/html','.js':'application/javascript','.css':'text/css'};
    cors(res); res.writeHead(200,{'Content-Type':types[ext]||'text/plain'}); res.end(data);
  });
}

// ── Nethash ────────────────────────────────────────────────────────────────────
const nethashUrls={btc:'https://blockchain.info/q/hashrate',bch:'https://blockchain.info/bch/q/hashrate',
  dgb:'https://chainz.cryptoid.info/dgb/api.dws?q=hashrate',xec:'https://chainz.cryptoid.info/xec/api.dws?q=hashrate',fb:null};
function fetchNetHash(coin){
  const url=nethashUrls[coin]; if(!url) return;
  const now=Math.floor(Date.now()/1000);
  if(now-netHashLastFetch[coin]<300) return;
  netHashLastFetch[coin]=now;
  proxyGet(url,10000).then(val=>{netHashCache[coin]=JSON.stringify({hashrate:val.trim(),coin});}).catch(()=>{});
}
Object.keys(nethashUrls).forEach(fetchNetHash);

// ── HTTP server ────────────────────────────────────────────────────────────────
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://localhost:${PORT}`);
  const path_=u.pathname;
  const ip=u.searchParams.get('ip');
  const coin=u.searchParams.get('coin')||'btc';
  const method=req.method;

  if(req.method==='OPTIONS'){cors(res);res.writeHead(204);res.end();return;}

  if(path_==='/'||path_==='/index.html'||path_==='/BitaxeDifficultyTracker.html'){
    const ua=req.headers['user-agent']||'';
    if(/iPhone|iPad|Android/i.test(ua)){cors(res);res.writeHead(302,{Location:'/mobile'});res.end();return;}
    return serveFile(res,path.join(SCRIPT_DIR,'BitaxeDifficultyTracker.html'));
  }
  if(path_==='/mobile') return serveFile(res,path.join(SCRIPT_DIR,'mobile.html'));
  if(path_==='/test') return json(res,{ok:true});
  if(path_==='/shutdown'){json(res,{ok:true});setTimeout(()=>process.exit(0),100);return;}

  // ── Miner proxy ──
  if(path_==='/api'&&ip){
    try{ const data=await proxyGet(`http://${ip}/api/system/info`,4000); cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(data); }
    catch(e){ json(res,{error:e.message},502); } return;
  }
  if(path_==='/scoreboard'&&ip){
    try{ const data=await proxyGet(`http://${ip}/api/system/scoreboard`,4000); cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(data); }
    catch(e){ json(res,{error:e.message},502); } return;
  }
  if(path_==='/stream'&&ip){
    cors(res);
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-Accel-Buffering':'no','Connection':'keep-alive'});
    if(!sseClients[ip]) sseClients[ip]=[];
    sseClients[ip].push(res);
    // Connect miner if not already
    if(!minerWS[ip]){
      connectMiner(ip,'','#f7931a');
      startMinerPoll(ip);
    } else { res.write('data: CONNECTED\n\n'); }
    req.on('close',()=>{
      if(sseClients[ip]) sseClients[ip]=sseClients[ip].filter(r=>r!==res);
    });
    return;
  }
  if(path_==='/restart'&&ip){
    try{ await proxyPost(`http://${ip}/api/system/restart`,'',5000); cors(res);res.writeHead(200);res.end('ok'); }
    catch(e){ cors(res);res.writeHead(502);res.end(`error: ${e.message}`); } return;
  }
  if(path_==='/patch'&&ip){
    try{
      const bodyJson=req.headers['x-body'];
      await proxyPatch(`http://${ip}/api/system`,bodyJson||'{}',5000);
      cors(res);res.writeHead(200);res.end('ok');
    }catch(e){cors(res);res.writeHead(502);res.end(`error: ${e.message}`);} return;
  }

  // ── Nethash ──
  if(path_==='/nethash'){
    fetchNetHash(coin);
    const cached=netHashCache[coin]||`{"hashrate":"0","coin":"${coin}"}`;
    cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(cached);return;
  }

  // ── Miners ── (also connect on setminers)
  if(path_==='/setminers'){
    const body=await readBody(req);
    minersCache=body;
    try{fs.writeFileSync(MINERS_FILE,body,'utf8');}catch(e){}
    // Connect any new miners
    try{
      const parsed=JSON.parse(body);
      const ips=parsed.ips||[];
      const names=parsed.names||{};
      ips.forEach(ip=>{
        if(!minerState[ip]){
          const key=ip.replace(/[.]/g,'_');
          connectMiner(ip,names[key]||'','#f7931a');
          startMinerPoll(ip);
        } else if(names[ip.replace(/[.]/g,'_')]) {
          minerState[ip].name=names[ip.replace(/[.]/g,'_')];
        }
      });
    }catch(e){}
    return json(res,{ok:true});
  }
  if(path_==='/miners'){
    cors(res);res.writeHead(200,{'Content-Type':'application/json'});
    res.end(minersCache||'{"ips":[],"names":{},"ts":0}');return;
  }

  // ── Session ──
  if(path_==='/session'){
    const body=await readBody(req);
    if(req.method==='POST'){
      try{const d=JSON.parse(body);sessionCache=d;}catch(e){}
      // Session was memory-only here, so top shares and session bests died with
      // the relay. Persist it, gated on the desktop's X-Persist-Sig: if nothing
      // unrecoverable changed there is nothing worth writing.
      const psig = req.headers['x-persist-sig'];
      if(!psig || psig !== lastPsig){
        if(psig) lastPsig = psig;
        const txt = JSON.stringify(sessionCache);
        if(txt.includes('"topSeriesSnapshot":[{') || txt.includes('"sessionCleared":true')){
          storeDirty = true; saveStore();
        }
      }
      return json(res,{ok:true});
    }else{ return json(res,sessionCache); }
  }

  // ── Underperformance watchdog config (mobile -> desktop write channel) ──
  if(path_==='/setuwcfg' && req.method==='POST'){
    const body=await readBody(req);
    if(body && body.length>1) pendingUwCfg = body;
    return json(res,{ok:true});
  }
  if(path_==='/getuwcfg'){
    const out = pendingUwCfg; pendingUwCfg = null;
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    return res.end(out || 'null');
  }

  // ── Degradation log, run-log, governor store, ambient history ──
  if(path_==='/degradation'){
    const body=await readBody(req);
    if(req.method==='POST'){
      if(body && body.length>1){ degCache=body; storeDirty=true; saveStore(); }
      return json(res,{ok:true});
    }
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    return res.end(degCache || 'null');
  }
  if(path_==='/runlog'){
    const body=await readBody(req);
    if(req.method==='POST'){
      if(body && body.length>1){ runlogCache=body; storeDirty=true; saveStore(); }
      return json(res,{ok:true});
    }
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    return res.end(runlogCache || 'null');
  }
  if(path_==='/governorstore'){
    const body=await readBody(req);
    if(req.method==='POST'){
      if(body && body.length>1){ govStoreCache=body; storeDirty=true; saveStore(true); }
      return json(res,{ok:true});
    }
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    return res.end(govStoreCache || 'null');
  }
  if(path_==='/ambientlog'){
    const body=await readBody(req);
    if(req.method==='POST'){
      if(body && body.length>1){ ambLogCache=body; storeDirty=true; saveStore(); }
      return json(res,{ok:true});
    }
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    return res.end(ambLogCache || 'null');
  }

  // ── Storage audit: read back off disk, not from the in-memory caches ──
  if(path_==='/storeinfo'){
    let bytes=0, modified='', onDisk=null;
    try{
      if(fs.existsSync(DATA_FILE)){
        const st=fs.statSync(DATA_FILE); bytes=st.size;
        modified=new Date(st.mtime).toISOString().replace('T',' ').slice(0,19);
        onDisk=JSON.parse(fs.readFileSync(DATA_FILE,'utf8').replace(/^\uFEFF/,''));
      }
    }catch(e){}
    const sections={};
    ['session','scripts','reports','degradation','runlog','governors','alltime','ambientlog'].forEach(function(nm){
      const v=onDisk?onDisk[nm]:null;
      sections[nm]={ bytes: v==null?0:JSON.stringify(v).length,
                     items: v==null?0:(Array.isArray(v)?v.length:Object.keys(v).length) };
    });
    return json(res,{file:DATA_FILE, bytes:bytes, modified:modified, sections:sections});
  }

  // ── All-time ──
  if(path_==='/alltime'){
    const body=await readBody(req);
    if(req.method==='POST'){
      allTimeCache=body;
      try{fs.writeFileSync(ALLTIME_FILE,body,'utf8');}catch(e){}
      storeDirty=true; saveStore(true);   // all-time is the one thing that can never be rebuilt
      return json(res,{ok:true});
    }else{
      cors(res);res.writeHead(200,{'Content-Type':'application/json'});
      res.end(allTimeCache||'{}');return;
    }
  }

  // ── Scripts ──
  if(path_==='/scripts'){
    const body=await readBody(req);
    if(req.method==='POST'){
      scriptsCache=body;
      try{fs.writeFileSync(SCRIPTS_FILE,body,'utf8');}catch(e){}
      return json(res,{ok:true});
    }else{
      cors(res);res.writeHead(200,{'Content-Type':'application/json'});
      res.end(scriptsCache||'[]');return;
    }
  }
  if(path_==='/setscripts'){const body=await readBody(req);pendingScripts=body;return json(res,{ok:true});}
  if(path_==='/getscripts'){cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(pendingScripts||'[]');return;}

  // ── Governor sync (mirrors scripts) ──
  if(path_==='/governors'){
    if(method==='POST'){
      const body=await readBody(req);
      if(body && body.length>1){ _govLoadFrom(body); }
      return json(res,{ok:true});
    }
    cors(res);res.writeHead(200,{'Content-Type':'application/json'});
    res.end(governorsCache||'null');return;
  }
  if(path_==='/setgovernors'&&method==='POST'){
    const body=await readBody(req);
    if(body && body.length>1){ _govLoadFrom(body); pendingGovernors=governorsCache; }
    return json(res,{ok:true});
  }
  if(path_==='/getgovernors'){
    cors(res);res.writeHead(200,{'Content-Type':'application/json'});
    res.end(pendingGovernors||'null'); pendingGovernors=null; return;
  }

  // ── Notifications ──
  if(path_==='/notifications'){
    const body=await readBody(req);
    if(req.method==='POST'){
      if(body&&body.length>2){
        try{
          const newN=JSON.parse(body);
          if(pendingNotifs){const ex=JSON.parse(pendingNotifs);pendingNotifs=JSON.stringify([...ex,...newN].slice(-50));}
          else pendingNotifs=body;
        }catch{pendingNotifs=body;}
      }
      return json(res,{ok:true});
    }else{
      const out=pendingNotifs||'[]';pendingNotifs=null;
      cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(out);return;
    }
  }

  // ── Settings ──
  if(path_==='/settings'){
    const body=await readBody(req);
    if(req.method==='POST'){
      try{fs.writeFileSync(SETTINGS_FILE,body,'utf8');}catch(e){}
      return json(res,{ok:true});
    }else{
      let data='{}';
      try{if(fs.existsSync(SETTINGS_FILE))data=fs.readFileSync(SETTINGS_FILE,'utf8');}catch(e){}
      cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(data);return;
    }
  }

  if(path_==='/setautorestart') return json(res,{ok:true});
  // ── New endpoints ────────────────────────────────────────────────────────
  if(path_==='/hralltime'){
    if(method==='POST'){ const body=await readBody(req); hrAllTimeCache=body; return json(res,{ok:true}); }
    cors(res); res.writeHead(200,{'Content-Type':'application/json'}); res.end(hrAllTimeCache||'{}'); return;
  }
  if(path_==='/setclearsession'&&method==='POST'){ const body=await readBody(req); pendingClearSession=body; return json(res,{ok:true}); }
  if(path_==='/getclearsession'){
    const cs=pendingClearSession||'{}'; pendingClearSession=null;
    cors(res); res.writeHead(200,{'Content-Type':'application/json'}); res.end(cs); return;
  }
  // ── HR high-score delete: single entry (ts) or whole miner (ts:'all') ──
  if(path_==='/deletehrentry'&&method==='POST'){
    const body=await readBody(req);
    try{
      const del=JSON.parse(body);
      if(hrAllTimeCache){
        const dobj=JSON.parse(hrAllTimeCache);
        if(del.ts==='all'){
          if(Object.prototype.hasOwnProperty.call(dobj,del.ip)){ delete dobj[del.ip]; hrAllTimeCache=JSON.stringify(dobj); }
        } else if(dobj[del.ip]){
          dobj[del.ip]=dobj[del.ip].filter(x=>x.ts!==del.ts);
          hrAllTimeCache=JSON.stringify(dobj);
        }
      }
      pendingHrDelete=body;
    }catch(e){}
    return json(res,{ok:true});
  }
  if(path_==='/gethrdelete'){
    const hd=pendingHrDelete||'{}'; pendingHrDelete=null;
    cors(res); res.writeHead(200,{'Content-Type':'application/json'}); res.end(hd); return;
  }
  // ── All-time diff clear: whole miner ──
  if(path_==='/setdiffclear'&&method==='POST'){
    const body=await readBody(req);
    try{
      const del=JSON.parse(body);
      if(allTimeCache){
        const aobj=JSON.parse(allTimeCache);
        const target = (aobj && Object.prototype.hasOwnProperty.call(aobj,'alltime')) ? aobj.alltime : aobj;
        if(target && Object.prototype.hasOwnProperty.call(target,del.ip)){
          delete target[del.ip];
          allTimeCache=JSON.stringify(aobj);
          try{fs.writeFileSync(ALLTIME_FILE,allTimeCache,'utf8');}catch(e){}
        }
      }
      pendingDiffClear=body;
    }catch(e){}
    return json(res,{ok:true});
  }
  if(path_==='/getdiffclear'){
    const dc=pendingDiffClear||'{}'; pendingDiffClear=null;
    cors(res); res.writeHead(200,{'Content-Type':'application/json'}); res.end(dc); return;
  }
  // ── /fleet ── flat combined rollup for watch complications / widgets.
  // The desktop computes it (fleetStats() stays the single source of truth) and
  // POSTs it here; this server is only a cache.
  if(path_==='/fleet'){
    if(method==='POST'){ const body=await readBody(req); if(body&&body.length>2) fleetCache=body; return json(res,{ok:true}); }
    cors(res); res.writeHead(200,{'Content-Type':'application/json'}); res.end(fleetCache||'{}'); return;
  }

  // ── /reports ── same store as /setreports + /getreports, POST/GET on one path
  if(path_==='/reports'){
    if(method==='POST'){
      const body=await readBody(req);
      if(body&&body.length>2){
        reportsCache=body;
        try{ fs.writeFileSync(path.join(SCRIPT_DIR,'reports-data.json'), body, 'utf8'); }catch(e){}
      }
      cors(res); res.writeHead(200); res.end('ok'); return;
    }
    cors(res); res.writeHead(200,{'Content-Type':'application/json'}); res.end(reportsCache||'{}'); return;
  }

  // ── /startup ── Windows-only (adds a Startup shortcut). Answer honestly on
  // Linux so the checkbox shows unchecked instead of the UI erroring out.
  // Use systemd or your desktop's autostart to launch this on boot.
  if(path_==='/startup'){
    if(method==='POST'){ await readBody(req); return json(res,{ok:false,supported:false}); }
    return json(res,{enabled:false,supported:false});
  }

  if(path_==='/setreports'&&method==='POST'){ const body=await readBody(req); reportsCache=body; return json(res,{ok:true}); }
  if(path_==='/getreports'){
    cors(res); res.writeHead(200,{'Content-Type':'application/json'}); res.end(reportsCache||'{}'); return;
  }
  if(path_==='/getautorestart') return json(res,{});
  if(path_==='/arstate'){
    const body=await readBody(req);
    if(req.method==='POST'){arStateCache=body;return json(res,{ok:true});}
    cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(arStateCache||'{}');return;
  }

  res.writeHead(404);res.end('Not found');
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log('');
  console.log('  ==========================================');
  console.log('   Bitaxe Difficulty Tracker');
  console.log(`   Listening on http://0.0.0.0:${PORT}`);
  console.log(`   Open: http://localhost:${PORT}`);
  console.log('   Keep this window open while using the app');
  console.log('  ==========================================');
  console.log('');
});
server.on('error',e=>console.error('Server error:',e.message));
process.on('SIGINT',()=>{console.log('\n  [Server] Stopped.');process.exit(0);});
