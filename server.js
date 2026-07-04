#!/usr/bin/env node
// Bitaxe Difficulty Tracker - Node.js Server
// For Linux / Umbrel / macOS
// Requires Node.js 18+

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { WebSocket } = require('ws');

const PORT       = 19248;
const SCRIPT_DIR = __dirname;

// ── Persistence files ──────────────────────────────────────────────────────────
const MINERS_FILE   = path.join(SCRIPT_DIR, 'miners-data.json');
const SETTINGS_FILE = path.join(SCRIPT_DIR, 'settings-data.json');
const ALLTIME_FILE  = path.join(SCRIPT_DIR, 'alltime-data.json');
const SCRIPTS_FILE  = path.join(SCRIPT_DIR, 'scripts-data.json');
const GOVERNORS_FILE = path.join(SCRIPT_DIR, 'governors-data.json');

// ── In-memory state ────────────────────────────────────────────────────────────
let pendingNotifs = null;
let scriptsCache  = null;
let pendingScripts = null;
let arStateCache  = null;
let reportsCache   = null;
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
  if(fs.existsSync(ALLTIME_FILE)){ allTimeCache=fs.readFileSync(ALLTIME_FILE,'utf8'); console.log('  [Server] Loaded all-time data'); }
  if(fs.existsSync(SCRIPTS_FILE)){ scriptsCache=fs.readFileSync(SCRIPTS_FILE,'utf8'); console.log('  [Server] Loaded scripts'); }
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
      return json(res,{ok:true});
    }else{ return json(res,sessionCache); }
  }

  // ── All-time ──
  if(path_==='/alltime'){
    const body=await readBody(req);
    if(req.method==='POST'){
      allTimeCache=body;
      try{fs.writeFileSync(ALLTIME_FILE,body,'utf8');}catch(e){}
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
