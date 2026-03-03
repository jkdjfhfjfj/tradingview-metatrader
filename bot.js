#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║        TRADINGVIEW → METATRADER CLI BOT  v3.0                       ║
 * ║        Multi-Symbol | EAT Timezone | Zero Dependencies              ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */
'use strict';

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ─── ENV ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  var f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  fs.readFileSync(f, 'utf8').split('\n').forEach(function(line) {
    var t = line.trim();
    if (!t || t[0] === '#') return;
    var i = t.indexOf('=');
    if (i < 0) return;
    var k = t.slice(0, i).trim(), v = t.slice(i+1).trim().replace(/^["']|["']$/g,'');
    if (!process.env[k]) process.env[k] = v;
  });
}
loadEnv();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
var CFG = {
  TOKEN:      process.env.META_API_TOKEN  || '',
  ACCOUNT:    process.env.META_ACCOUNT_ID || '',
  API_BASE:   'https://mt-client-api-v1.london.agiliumtrade.ai',
  GROQ_KEY:   process.env.GROQ_API_KEY    || '',
  GROQ_MODEL: process.env.GROQ_MODEL      || 'llama3-70b-8192',
  LOT:        parseFloat(process.env.LOT_SIZE    || '0.01'),
  DEF_SL:     process.env.DEFAULT_SL  ? parseFloat(process.env.DEFAULT_SL)  : null, // pips
  DEF_TP:     process.env.DEFAULT_TP  ? parseFloat(process.env.DEFAULT_TP)  : null, // pips
  TRAIL:      process.env.TRAILING_SL ? parseFloat(process.env.TRAILING_SL) : null, // pips
  SECRET:     process.env.WEBHOOK_SECRET || '',
  ENABLED:    process.env.BOT_ENABLED !== 'false',
  PORT:       parseInt(process.env.PORT || '80'),
  POLL_SEC:   parseInt(process.env.MT_POLL_INTERVAL || '15'),
  DB:         path.join(__dirname, 'trades.json'),
  LOG:        path.join(__dirname, 'bot.log'),
};

// ─── SYMBOL SYSTEM ────────────────────────────────────────────────────────────
// Map canonical name → list of broker variants
var SYM_MAP = {
  GOLD:   ['XAUUSD','XAUUSDm','XAUUSD.pro','XAUUSD+','XAUm','XAU','GOLD.pro'],
  XAUUSD: ['GOLD','XAUUSDm','XAUUSD.pro','XAUUSD+','XAUm','XAU','GOLD.pro'],
  SILVER: ['XAGUSD','XAGUSDm','XAGUSD.pro','XAG','SILVER.pro'],
  XAGUSD: ['SILVER','XAGUSDm','XAGUSD.pro','XAG','SILVER.pro'],
  OIL:    ['USOIL','XTIUSD','WTI','CL','USOIL.pro','BRENT','XBRUSD','UKOIL'],
  USOIL:  ['OIL','XTIUSD','WTI','CL','USOIL.pro'],
  US30:   ['USA30','DOW','DJIA','US30.pro','US30+'],
  NAS100: ['USTEC','NDX','NAS100.pro','NAS100+','NASDAQ'],
  US500:  ['SPX500','SPX','US500.pro','SP500'],
  BTCUSD: ['BTC','BITCOIN','BTC/USD','BTCUSD.pro'],
  ETHUSD: ['ETH','ETHEREUM','ETH/USD','ETHUSD.pro'],
};

function canon(s) { return (s||'').toUpperCase().trim(); }

// Strip all known broker suffixes from symbol name
function stripSuffix(s) {
  return s
    .replace(/\.(pro|ecn|raw|stp|std|nano|mini|micro|cent|plus|prime|zero|m)$/i, '')
    .replace(/[m+#]$/, '');
}
function sameInst(a, b) {
  if (!a || !b) return false;
  var ca = canon(a), cb = canon(b);
  if (ca === cb) return true;
  // Direct alias lookup
  if ((SYM_MAP[ca]||[]).indexOf(cb) >= 0) return true;
  if ((SYM_MAP[cb]||[]).indexOf(ca) >= 0) return true;
  // Strip broker suffix then compare
  var sa = stripSuffix(ca), sb = stripSuffix(cb);
  if (sa === sb) return true;
  // Strip suffix then alias lookup (e.g. XAUUSDm → XAUUSD → alias GOLD)
  if ((SYM_MAP[sa]||[]).indexOf(cb) >= 0) return true;
  if ((SYM_MAP[sb]||[]).indexOf(ca) >= 0) return true;
  if ((SYM_MAP[sa]||[]).indexOf(sb) >= 0) return true;
  if ((SYM_MAP[sb]||[]).indexOf(sa) >= 0) return true;
  return false;
}

// ─── PIP SYSTEM ───────────────────────────────────────────────────────────────
// Returns: { pipSize, decimals, minPrice, maxPrice }
// pipSize  = price value of 1 pip
// decimals = decimal places to round SL/TP to
// minPrice / maxPrice = range used to detect if a value is a price vs pips
function symInfo(symbol) {
  var s = canon(symbol).replace(/[^A-Z0-9]/g,'');
  // Metals
  if (/^(GOLD|XAU|SILVER|XAG)/.test(s))
    return { pipSize:0.01,   decimals:2, minPrice:100,    maxPrice:5000  };
  // JPY pairs
  if (/JPY/.test(s))
    return { pipSize:0.01,   decimals:3, minPrice:50,     maxPrice:250   };
  // Indices
  if (/^(US30|USA30|DOW|DJIA|NAS|NDX|USTEC|SPX|US500|SP500|DAX|FTSE|CAC|GER|UK100|JP225|AUS200)/.test(s))
    return { pipSize:1.0,    decimals:1, minPrice:100,    maxPrice:50000 };
  // Oil
  if (/^(OIL|USOIL|UKOIL|WTI|BRENT|XTIUSD|XBRUSD|CL)/.test(s))
    return { pipSize:0.01,   decimals:2, minPrice:10,     maxPrice:200   };
  // Crypto BTC
  if (/^BTC/.test(s))
    return { pipSize:1.0,    decimals:0, minPrice:1000,   maxPrice:200000};
  // Crypto ETH
  if (/^ETH/.test(s))
    return { pipSize:0.1,    decimals:1, minPrice:50,     maxPrice:20000 };
  // Other crypto
  if (/^(LTC|XRP|ADA|SOL|BNB|DOGE)/.test(s))
    return { pipSize:0.0001, decimals:4, minPrice:0.001,  maxPrice:5000  };
  // Standard forex (5-digit)
  return   { pipSize:0.0001, decimals:5, minPrice:0.3,    maxPrice:30    };
}

// Returns true if value looks like a valid price for the symbol (not pips)
function isPrice(symbol, value) {
  if (value == null) return false;
  var v = parseFloat(value);
  if (isNaN(v) || v <= 0) return false;
  var info = symInfo(symbol);
  return v >= info.minPrice && v <= info.maxPrice;
}

// Calculate SL and TP price levels from entry + pip offsets
function calcLevels(symbol, direction, entry, slPips, tpPips) {
  var info = symInfo(symbol);
  var pip  = info.pipSize;
  var dec  = info.decimals;
  var sl = null, tp = null;
  var sp = (slPips != null) ? parseFloat(slPips) : null;
  var tp2= (tpPips != null) ? parseFloat(tpPips) : null;
  if (sp && isFinite(sp) && entry) {
    sl = direction === 'buy'
      ? parseFloat((entry - sp * pip).toFixed(dec))
      : parseFloat((entry + sp * pip).toFixed(dec));
  }
  if (tp2 && isFinite(tp2) && entry) {
    tp = direction === 'buy'
      ? parseFloat((entry + tp2 * pip).toFixed(dec))
      : parseFloat((entry - tp2 * pip).toFixed(dec));
  }
  return { sl:sl, tp:tp, pip:pip, decimals:dec };
}

// ─── EAT (UTC+3) ──────────────────────────────────────────────────────────────
function eatNow() {
  var d = new Date();
  return new Date(d.getTime() + d.getTimezoneOffset()*60000 + 10800000);
}
function eatStr(d) {
  d = d || eatNow();
  var p = function(n){ return String(n).padStart(2,'0'); };
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())+' EAT';
}
function toEatStr(iso) {
  if (!iso) return eatStr();
  var d = new Date(iso);
  if (isNaN(d)) return eatStr();
  return eatStr(new Date(d.getTime() + d.getTimezoneOffset()*60000 + 10800000));
}
// Parse EAT string back to a JS Date for age calculations
function eatStrToDate(s) {
  if (!s) return new Date(0);
  // "2026-03-03 10:36:20 EAT" → treat as UTC+3 → subtract 3h for UTC
  var clean = (s||'').replace(' EAT','').trim();
  var d = new Date(clean.replace(' ','T')+'+03:00');
  if (!isNaN(d)) return d;
  return new Date(0);
}

// ─── COLORS ───────────────────────────────────────────────────────────────────
var C = { reset:'',bold:'',dim:'',red:'',green:'',yellow:'',blue:'',magenta:'',cyan:'' };
if (process.stdout.isTTY) {
  C.reset='\x1b[0m'; C.bold='\x1b[1m'; C.dim='\x1b[2m';
  C.red='\x1b[31m'; C.green='\x1b[32m'; C.yellow='\x1b[33m';
  C.blue='\x1b[34m'; C.magenta='\x1b[35m'; C.cyan='\x1b[36m';
}
var S = { buy:'▲',sell:'▼',info:'◆',warn:'⚠',err:'✖',ok:'✔',trade:'⟳',money:'$',line:'─',ext:'⚡' };

// ─── LOGGER ───────────────────────────────────────────────────────────────────
var logStream = fs.createWriteStream(CFG.LOG, { flags:'a' });
function tsNow() { return eatStr().replace(' EAT',''); }
function _log(level, sym, col, args) {
  var msg = Array.prototype.slice.call(args).join(' ');
  console.log(C.dim+'['+tsNow()+']'+C.reset+' '+col+C.bold+sym+C.reset+' '+msg);
  logStream.write('['+tsNow()+'] ['+level+'] '+msg.replace(/\x1b\[[0-9;]*m/g,'')+'\n');
}
var L = {
  info:    function(){ _log('INFO', S.info,  C.cyan,    arguments); },
  ok:      function(){ _log('OK',   S.ok,    C.green,   arguments); },
  warn:    function(){ _log('WARN', S.warn,  C.yellow,  arguments); },
  err:     function(){ _log('ERR',  S.err,   C.red,     arguments); },
  trade:   function(){ _log('TRD',  S.trade, C.magenta, arguments); },
  buy:     function(){ _log('BUY',  S.buy,   C.green,   arguments); },
  sell:    function(){ _log('SELL', S.sell,  C.red,     arguments); },
  money:   function(){ _log('PNL',  S.money, C.yellow,  arguments); },
  ext:     function(){ _log('EXT',  S.ext,   C.magenta, arguments); },
  section: function(t){ console.log(''); console.log(C.blue+C.bold+'  ── '+t+' '+'─'.repeat(Math.max(0,62-t.length))+C.reset); },
};
function banner(txt) {
  var line = S.line.repeat(68);
  var pad  = txt.padStart(Math.floor((68+txt.length)/2)).padEnd(68);
  console.log(C.cyan+C.bold+'┌'+line+'┐\n│'+pad+'│\n└'+line+'┘'+C.reset);
}

// ─── DATABASE ─────────────────────────────────────────────────────────────────
function dbRead() {
  if (!fs.existsSync(CFG.DB)) {
    var init = { trades:[], stats:{ total:0, wins:0, losses:0, totalPnl:0 } };
    fs.writeFileSync(CFG.DB, JSON.stringify(init,null,2));
    return init;
  }
  try { return JSON.parse(fs.readFileSync(CFG.DB,'utf8')); }
  catch(e) { return { trades:[], stats:{ total:0,wins:0,losses:0,totalPnl:0 } }; }
}
function dbWrite(data) { fs.writeFileSync(CFG.DB, JSON.stringify(data,null,2)); }
function dbSave(trade) {
  var db = dbRead(), idx = db.trades.findIndex(function(t){ return t.id===trade.id; });
  if (idx >= 0) db.trades[idx] = trade; else db.trades.push(trade);
  dbWrite(db);
}
function dbClose(id, cd) {
  var db = dbRead(), idx = db.trades.findIndex(function(t){ return t.id===id; });
  if (idx < 0) return null;
  Object.assign(db.trades[idx], cd, { status:'closed' });
  var pnl = db.trades[idx].pnl || 0;
  db.stats.total++;
  db.stats.totalPnl = +(db.stats.totalPnl + pnl).toFixed(2);
  if (pnl >= 0) db.stats.wins++; else db.stats.losses++;
  dbWrite(db);
  return db.trades[idx];
}
function dbOpenAll()      { return dbRead().trades.filter(function(t){ return t.status==='open'; }); }
function dbOpenBySym(sym) { return dbOpenAll().find(function(t){ return sameInst(t.symbol, sym); }) || null; }
function dbOpenFirst()    { return dbOpenAll()[0] || null; }
function genId()          { return 'T'+Date.now()+'-'+Math.random().toString(36).slice(2,6).toUpperCase(); }

// ─── META API ─────────────────────────────────────────────────────────────────
function metaReq(method, endpoint, body, ms) {
  ms = ms || 20000;
  return new Promise(function(resolve, reject) {
    if (!CFG.TOKEN || !CFG.ACCOUNT) return reject(new Error('MetaAPI credentials not set'));
    var url  = CFG.API_BASE+'/users/current/accounts/'+CFG.ACCOUNT+endpoint;
    var parsed = new URL(url);
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: parsed.hostname, path: parsed.pathname+parsed.search, method: method,
      headers: Object.assign({ 'auth-token':CFG.TOKEN, 'Content-Type':'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    };
    var settled = false;
    function done(fn,v){ if(!settled){ settled=true; clearTimeout(timer); fn(v); } }
    var timer = setTimeout(function(){ try{req.destroy();}catch(e){} done(resolve,{status:0,data:null,timedOut:true}); }, ms);
    var req = https.request(opts, function(res) {
      var raw = '';
      res.on('data', function(c){ raw+=c; });
      res.on('end', function() {
        var parsed2 = {};
        try { parsed2 = raw ? JSON.parse(raw) : {}; } catch(e) { parsed2 = { _raw:raw }; }
        done(resolve, { status:res.statusCode, data:parsed2, timedOut:false });
      });
    });
    req.on('error', function(e){ done(reject,e); });
    if (data) req.write(data);
    req.end();
  });
}

// RETCODE values that mean success
var MT_SUCCESS_CODES = [10008, 10009]; // TRADE_RETCODE_PLACED, TRADE_RETCODE_DONE
var MT_SUCCESS_STRINGS = ['TRADE_RETCODE_DONE','TRADE_RETCODE_PLACED'];

// Classify MetaAPI response: is it an error?
function metaErr(r) {
  if (!r) return { yes:true, type:'NULL', msg:'No response' };
  if (r.timedOut) return { yes:false };
  if (r.status >= 400) return { yes:true, type:(r.data&&r.data.error)||('HTTP_'+r.status), msg:(r.data&&r.data.message)||JSON.stringify(r.data) };
  if (!r.data) return { yes:false };
  var d = r.data;
  // stringCode present — check if it's a known error
  if (d.stringCode && MT_SUCCESS_STRINGS.indexOf(d.stringCode) < 0) {
    return { yes:true, type:d.stringCode, msg:d.message||d.stringCode };
  }
  // numericCode present with no stringCode — check against success codes
  if (d.numericCode != null && !d.stringCode) {
    if (MT_SUCCESS_CODES.indexOf(d.numericCode) < 0) {
      // It's an error retcode
      return { yes:true, type:'RETCODE_'+d.numericCode, msg:d.message||('MT retcode '+d.numericCode) };
    }
  }
  if (d.error) return { yes:true, type:d.error, msg:d.message||JSON.stringify(d) };
  return { yes:false };
}

// Normalize position type field to 'buy'|'sell'
function normType(p) {
  var t = String(p.type||'').toLowerCase();
  if (t==='0'||t==='buy'||t==='position_type_buy') return 'buy';
  if (t==='1'||t==='sell'||t==='position_type_sell') return 'sell';
  return '';
}

async function mtGetAccount() {
  var r = await metaReq('GET','/account-information');
  return r.data || {};
}
async function mtGetPositions() {
  var r = await metaReq('GET','/positions');
  if (r.timedOut) throw new Error('Timed out fetching positions');
  if (r.status >= 400) throw new Error('Positions fetch error '+r.status+': '+((r.data&&r.data.message)||JSON.stringify(r.data)));
  if (!r.data) return [];
  return Array.isArray(r.data) ? r.data : [];
}
function mtPlace(symbol, type, lots, sl, tp) {
  var body = { symbol:symbol, volume:lots, actionType:type };
  if (sl != null) body.stopLoss   = parseFloat(sl);
  if (tp != null) body.takeProfit = parseFloat(tp);
  return metaReq('POST','/trade', body);
}
function mtClose(posId) {
  return metaReq('POST','/trade', { actionType:'POSITION_CLOSE_ID', positionId:String(posId) });
}
function mtModify(posId, sl, tp, trail) {
  var body = { actionType:'POSITION_MODIFY', positionId:String(posId) };
  if (sl    != null) body.stopLoss          = parseFloat(sl);
  if (tp    != null) body.takeProfit        = parseFloat(tp);
  if (trail != null) body.trailingStopLoss  = parseFloat(trail);
  return metaReq('POST','/trade', body);
}

// Poll MT positions to find a newly placed trade (used after timeout or missing positionId)
// Retries up to 3 times with increasing delays to handle MetaAPI cache staleness
async function pollForPosition(symbol, direction, waitMs) {
  waitMs = waitMs || 2000;
  var retries = [waitMs, 2000, 3000]; // wait, then retry after 2s, then 3s
  for (var attempt = 0; attempt < retries.length; attempt++) {
    var delay = retries[attempt];
    L.warn('Poll attempt '+(attempt+1)+'/'+retries.length+': waiting '+delay+'ms for '+direction.toUpperCase()+' '+symbol+'...');
    await new Promise(function(r){ setTimeout(r, delay); });
    var positions;
    try { positions = await mtGetPositions(); }
    catch(e) { L.err('Poll failed: '+e.message); if(attempt===retries.length-1) return null; continue; }

    L.info('MT positions ('+positions.length+'): '+
      (positions.map(function(p){ return p.symbol+'/'+normType(p)+'/id:'+p.id; }).join(', ')||'none'));

    // Match by symbol alias + direction
    var matches = positions.filter(function(p){
      return sameInst(p.symbol, symbol) && normType(p) === direction;
    });
    // Also try stripped suffix match in case broker uses variant not in alias map
    if (!matches.length) {
      matches = positions.filter(function(p){
        return stripSuffix(canon(p.symbol)) === stripSuffix(canon(symbol)) && normType(p) === direction;
      });
    }
    matches.sort(function(a,b){
      return new Date(b.time||b.openTime||0) - new Date(a.time||a.openTime||0);
    });
    if (matches[0]) {
      var m = matches[0];
      L.ok('Poll found (attempt '+(attempt+1)+'): '+m.symbol+' '+direction.toUpperCase()+' posId:'+m.id+' entry:'+m.openPrice);
      return { positionId:String(m.id), symbol:canon(m.symbol), entry:m.openPrice, raw:m };
    }
    L.warn('Not found yet (attempt '+(attempt+1)+'). Positions: '+
      (positions.map(function(p){ return p.symbol+'/'+normType(p); }).join(', ')||'none'));
  }
  L.err('Poll exhausted — no '+direction.toUpperCase()+' position for '+symbol+' after all retries');
  return null;
}

// ─── GROQ AI ──────────────────────────────────────────────────────────────────
function groqSummary(t) {
  return new Promise(function(resolve) {
    if (!CFG.GROQ_KEY) return resolve('');
    var prompt = 'Forex analyst: summarize this closed trade in 2-3 sentences — what happened, result, one lesson.\n'+
      'Symbol:'+t.symbol+' Dir:'+t.direction+' Entry:'+t.entry+' SL:'+t.sl+' TP:'+t.tp+
      ' Close:'+t.closePrice+' PnL:'+(t.pnl!=null?t.pnl:'?')+' Lot:'+t.lot+
      ' Opened:'+t.openTimeEAT+' Closed:'+t.closeTimeEAT+' Reason:'+t.closeReason;
    var body = JSON.stringify({ model:CFG.GROQ_MODEL, messages:[{role:'user',content:prompt}], max_tokens:200 });
    var req  = https.request({
      hostname:'api.groq.com', path:'/openai/v1/chat/completions', method:'POST',
      headers:{ 'Authorization':'Bearer '+CFG.GROQ_KEY, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) },
    }, function(res) {
      var raw=''; res.on('data',function(c){raw+=c;}); res.on('end',function(){
        try { resolve(JSON.parse(raw).choices[0].message.content.trim()); } catch(e){ resolve(''); }
      });
    });
    req.on('error',function(){ resolve(''); });
    req.setTimeout(15000,function(){ req.destroy(); resolve(''); });
    req.write(body); req.end();
  });
}

// ─── RECONCILE (two-way MT ↔ DB sync) ────────────────────────────────────────
async function reconcile(silent) {
  if (!CFG.TOKEN || !CFG.ACCOUNT) {
    if (!silent) L.warn('Reconcile skipped — credentials not set');
    return null;
  }
  var positions;
  try { positions = await mtGetPositions(); }
  catch(e) {
    (silent ? L.warn : L.err)('[RECONCILE] fetch failed: '+e.message+' — skipping to avoid false closes');
    return null;
  }

  if (!silent) {
    L.section('MT RECONCILE');
    L.info('MT live: '+positions.length+(positions.length?' — '+positions.map(function(p){return canon(p.symbol)+'/'+normType(p).toUpperCase()+' id:'+p.id;}).join(', '):'  (none)'));
  }

  var db     = dbRead();
  var dbOpen = db.trades.filter(function(t){ return t.status==='open'; });
  if (!silent) L.info('DB open: '+dbOpen.length+(dbOpen.length?' — '+dbOpen.map(function(t){return t.symbol+'/'+t.direction.toUpperCase()+' posId:'+t.positionId;}).join(', '):'  (none)'));

  var now = Date.now();

  // ── Step 1: For each DB open trade, find it on MT ──────────────────────────
  for (var i=0; i<dbOpen.length; i++) {
    var t = dbOpen[i];

    // Find on MT: exact positionId match first, then symbol+direction (alias-aware)
    var onMT = null;
    if (t.positionId) {
      onMT = positions.find(function(p){ return String(p.id)===String(t.positionId); }) || null;
    }
    if (!onMT) {
      // Symbol match: try alias, then stripped suffix
      onMT = positions.find(function(p){ return sameInst(p.symbol,t.symbol) && normType(p)===t.direction; }) || null;
    }
    if (!onMT) {
      // Last resort: stripped suffix match (e.g. XAUUSDm vs XAUUSD)
      onMT = positions.find(function(p){
        return stripSuffix(canon(p.symbol))===stripSuffix(canon(t.symbol)) && normType(p)===t.direction;
      }) || null;
    }

    if (onMT) {
      // Fix positionId/symbol mismatch silently
      var newPosId = String(onMT.id), newSym = canon(onMT.symbol);
      var needFix  = newPosId !== String(t.positionId) || newSym !== t.symbol;
      var upd = Object.assign({}, t, {
        positionId: newPosId, symbol: newSym,
        sl:    onMT.stopLoss   != null ? onMT.stopLoss   : t.sl,
        tp:    onMT.takeProfit != null ? onMT.takeProfit : t.tp,
        entry: onMT.openPrice  != null ? onMT.openPrice  : t.entry,
        pnl:   onMT.profit     != null ? onMT.profit     : t.pnl,
        lot:   onMT.volume     != null ? onMT.volume     : t.lot,
        updatedAt: eatStr(),
      });
      dbSave(upd);
      if (needFix && !silent) L.info('[SYNC] Fixed '+t.symbol+' posId:'+(t.positionId||'?')+' → '+newPosId+' sym → '+newSym);
      if (!silent) printTradeCard(upd, 'SYNCED — '+upd.symbol+(upd.source==='mt-external'?' [EXT]':''));

    } else {
      // Not on MT — grace period for very recently placed trades (might not have synced yet)
      var openedAt  = eatStrToDate(t.openTimeEAT);
      var ageSec    = isNaN(openedAt.getTime()) ? 999 : (now - openedAt.getTime()) / 1000;
      if (ageSec < 120) {
        L.warn('[GRACE] '+t.symbol+' '+t.direction.toUpperCase()+' posId:'+(t.positionId||'?')+
          ' — not on MT yet ('+Math.round(ageSec)+'s old) — will recheck next cycle');
        continue;
      }
      // Old enough → assume closed externally (SL/TP hit or manual close on terminal)
      L.warn(C.yellow+'[CLOSED EXTERNALLY] '+t.symbol+' '+t.direction.toUpperCase()+
        ' posId:'+(t.positionId||'?')+' ('+Math.round(ageSec)+'s old) — marking closed in DB'+C.reset);
      var ai = ''; try { ai = await groqSummary(Object.assign({},t,{closePrice:null,pnl:t.pnl,closeTimeEAT:eatStr(),closeReason:'closed externally on MT'})); } catch(e){}
      var closed = dbClose(t.id, { closePrice:null, pnl:t.pnl, closeReason:'closed externally on MT', closeTimeEAT:eatStr(), aiSummary:ai, updatedAt:eatStr() });
      printClosedCard(closed);
      L.money('External close PnL: '+(t.pnl!=null?t.pnl.toFixed(2)+' USD':'unknown'));
    }
  }

  // ── Step 2: MT positions not in DB → import as external trades ─────────────
  var freshDb = dbRead().trades;
  for (var j=0; j<positions.length; j++) {
    var pos    = positions[j];
    var posDir = normType(pos);
    if (posDir !== 'buy' && posDir !== 'sell') {
      if (!silent) L.warn('Skip unrecognised type: '+pos.id+' type='+pos.type);
      continue;
    }
    // Already in DB? Try: positionId → sameInst alias → stripped suffix
    var inDB = freshDb.find(function(t){ return String(t.positionId)===String(pos.id); });
    if (!inDB) inDB = freshDb.find(function(t){
      return t.status==='open' && sameInst(t.symbol,pos.symbol) && t.direction===posDir;
    });
    if (!inDB) inDB = freshDb.find(function(t){
      return t.status==='open' &&
        stripSuffix(canon(t.symbol))===stripSuffix(canon(pos.symbol)) &&
        t.direction===posDir;
    });
    if (!inDB) {
      // New trade not placed via this bot — import it
      var ext = {
        id:           genId(),
        positionId:   String(pos.id),
        symbol:       canon(pos.symbol),
        direction:    posDir,
        entry:        pos.openPrice  != null ? pos.openPrice  : null,
        sl:           pos.stopLoss   != null ? pos.stopLoss   : null,
        tp:           pos.takeProfit != null ? pos.takeProfit : null,
        trailingSl:   null,
        lot:          pos.volume     != null ? pos.volume     : null,
        status:       'open',
        pnl:          pos.profit     != null ? pos.profit     : null,
        closePrice:   null, closeReason:null, aiSummary:null,
        source:       'mt-external',
        openTimeEAT:  toEatStr(pos.time||pos.openTime||pos.openingTime),
        closeTimeEAT: null,
        updatedAt:    eatStr(),
      };
      dbSave(ext);
      freshDb = dbRead().trades;
      L.ext(C.magenta+C.bold+'⚡ EXTERNAL MT TRADE DETECTED & IMPORTED'+C.reset+
        ' — '+ext.symbol+' '+posDir.toUpperCase()+
        ' posId:'+pos.id+' entry:'+(ext.entry||'?')+' lot:'+(ext.lot||'?')+
        ' SL:'+(ext.sl||'—')+' TP:'+(ext.tp||'—')+' opened:'+ext.openTimeEAT);
      printTradeCard(ext, '⚡ EXTERNAL — '+ext.symbol);
    }
  }

  var allOpen = dbOpenAll();
  if (!silent) {
    if (allOpen.length === 0) console.log('\n  '+C.dim+'No open trades.'+C.reset+'\n');
    L.ok('Reconcile done. DB open: '+allOpen.length+' | MT positions: '+positions.length);
  }
  return { allOpen:allOpen, mtPositions:positions };
}

// ─── TRADE ENGINE ─────────────────────────────────────────────────────────────
async function handleSignal(payload) {
  L.section('SIGNAL');
  var action    = (payload.action||'').toLowerCase();
  var symbol    = (payload.symbol||'').trim();
  var lotRaw    = payload.lot;
  var slRaw     = payload.sl;
  var tpRaw     = payload.tp;
  var priceHint = payload.price;
  var tvTime    = payload.time;
  var lots      = parseFloat(lotRaw) || CFG.LOT;
  var sym       = canon(symbol);

  L.info('Signal: '+C.bold+action.toUpperCase()+C.reset+' '+sym+' lot:'+lots+' sl:'+(slRaw||'—')+' tp:'+(tpRaw||'—'));

  if (!CFG.ENABLED) { L.warn('Bot DISABLED — signal ignored'); return { ok:false, msg:'Bot disabled' }; }

  // Route close/update
  if (action === 'close')  return closeBySymbol(sym, 'webhook close signal');
  if (action === 'update') return updateBySymbol(sym, slRaw, tpRaw);

  if (action !== 'buy' && action !== 'sell') {
    L.err('Unknown action: "'+action+'"');
    return { ok:false, msg:'Unknown action: '+action };
  }
  if (!CFG.TOKEN || !CFG.ACCOUNT) {
    L.err('MetaAPI credentials missing — trade ABORTED');
    return { ok:false, msg:'MetaAPI credentials not configured' };
  }

  var dir = action; // 'buy' | 'sell'

  // Check for existing trade on this symbol
  var existing = dbOpenBySym(sym);

  // Same symbol + same direction → block
  if (existing && existing.direction === dir) {
    L.warn(C.yellow+C.bold+dir.toUpperCase()+' already open for '+sym+' — blocked'+C.reset);
    printTradeCard(existing, 'BLOCKED — ALREADY OPEN');
    return { ok:false, msg:dir.toUpperCase()+' already open for '+sym };
  }

  // Same symbol + opposite direction → flip
  if (existing && existing.direction !== dir) {
    L.trade('FLIP '+sym+': closing '+existing.direction.toUpperCase()+' → opening '+dir.toUpperCase());
    var flipResult = await closeTradeObj(existing, 'flipped to '+dir.toUpperCase());
    if (!flipResult.ok) {
      L.err(C.red+C.bold+'FLIP ABORTED — could not close existing '+existing.direction.toUpperCase()+' on '+sym+C.reset);
      return { ok:false, msg:'Flip aborted — close failed for '+sym };
    }
    L.ok('Flip: '+existing.direction.toUpperCase()+' closed ✔  Opening '+dir.toUpperCase()+'...');
  }

  // Different symbol → allow (multi-symbol)
  var allOpen = dbOpenAll();
  if (!existing && allOpen.length > 0)
    L.info('Other open: '+allOpen.map(function(t){ return t.symbol+' '+t.direction.toUpperCase(); }).join(', ')+' — adding '+sym);

  // ── Determine SL/TP strategy ──────────────────────────────────────────────
  // Signal values: could be price levels OR pip offsets
  var sigSl = slRaw != null ? parseFloat(slRaw) : null;
  var sigTp = tpRaw != null ? parseFloat(tpRaw) : null;

  // Detect if signal values are price levels
  var sigSlIsPrice = isPrice(sym, sigSl);
  var sigTpIsPrice = isPrice(sym, sigTp);

  // What to send with the initial order (only send if confirmed price level)
  var orderSl = sigSlIsPrice ? sigSl : null;
  var orderTp = sigTpIsPrice ? sigTp : null;

  // Will we need to set SL/TP after fill?
  // Only if: signal value is non-null but not a price (treat as pips), OR default pips are set
  var slPipsToUse = (!sigSlIsPrice && sigSl != null) ? sigSl : CFG.DEF_SL;
  var tpPipsToUse = (!sigTpIsPrice && sigTp != null) ? sigTp : CFG.DEF_TP;
  var needPostSl  = !sigSlIsPrice && slPipsToUse != null;
  var needPostTp  = !sigTpIsPrice && tpPipsToUse != null;

  L.section('PLACING '+dir.toUpperCase()+' ON METATRADER');
  var info = symInfo(sym);
  L.info('Symbol info: pip='+info.pipSize+' decimals='+info.decimals+' priceRange:['+info.minPrice+','+info.maxPrice+']');
  if (orderSl)      L.info('SL: '+orderSl+' [price-level from signal]');
  else if (sigSl)   L.info('SL signal '+sigSl+' treated as pips — will calc after fill');
  if (orderTp)      L.info('TP: '+orderTp+' [price-level from signal]');
  else if (sigTp)   L.info('TP signal '+sigTp+' treated as pips — will calc after fill');
  if (needPostSl)   L.info('SL: '+slPipsToUse+' pips from entry (will calc after fill)');
  if (needPostTp)   L.info('TP: '+tpPipsToUse+' pips from entry (will calc after fill)');
  if (CFG.TRAIL)    L.info('Trailing SL: '+CFG.TRAIL+' pips — will set after fill');
  if (!orderSl && !orderTp) L.info('→ Entering trade with NO SL/TP to avoid INVALID_STOPS');

  // ── Place order ─────────────────────────────────────────────────────────────
  var metaType   = dir === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
  var positionId = null;
  var entry      = priceHint ? parseFloat(priceHint) : null;

  try {
    var result = await mtPlace(sym, metaType, lots, orderSl, orderTp);
    L.info('MT response: '+C.dim+JSON.stringify(result.data)+C.reset);

    if (result.timedOut) {
      // Timed out — poll to see if order landed
      var poll = await pollForPosition(sym, dir, 4000);
      if (!poll) { L.err('Timeout: order not confirmed on MT'); return { ok:false, msg:'Timeout — order not confirmed' }; }
      positionId = poll.positionId;
      if (poll.entry) entry = poll.entry;
      sym = poll.symbol || sym;

    } else {
      var err = metaErr(result);
      if (err.yes) {
        // If INVALID_STOPS error AND we sent SL/TP, retry with no stops then apply via modify
        var isInvalidStops = err.type === 'TRADE_RETCODE_INVALID_STOPS' ||
                             err.type === 'RETCODE_10016' ||
                             (err.msg && err.msg.toLowerCase().indexOf('invalid stop') >= 0);
        if (isInvalidStops && (orderSl != null || orderTp != null)) {
          L.warn('INVALID_STOPS — retrying order with NO SL/TP, will set via modify after fill');
          orderSl = null; orderTp = null;
          needPostSl = true; needPostTp = true;
          var retry = await mtPlace(sym, metaType, lots, null, null);
          L.info('Retry MT response: '+JSON.stringify(retry.data));
          if (retry.timedOut) {
            var rp = await pollForPosition(sym, dir, 4000);
            if (!rp) { L.err('Retry timeout: order not confirmed'); return { ok:false, msg:'INVALID_STOPS retry timed out' }; }
            positionId = rp.positionId; if (rp.entry) entry = rp.entry; sym = rp.symbol || sym;
          } else {
            var re2 = metaErr(retry);
            if (re2.yes) { L.err('Retry also failed: '+re2.type+' — '+re2.msg); return { ok:false, msg:'MT error after retry: '+re2.type }; }
            var rd = retry.data || {};
            L.info('Retry raw: '+JSON.stringify(rd));
            var _rp = rd.positionId !== undefined ? rd.positionId : rd.orderId !== undefined ? rd.orderId : rd.position !== undefined ? rd.position : rd.id !== undefined ? rd.id : null;
            positionId = (_rp != null && String(_rp) !== 'undefined' && String(_rp) !== 'null') ? String(_rp) : null;
            if (!positionId) {
              var rpp = await pollForPosition(sym, dir, 2000);
              if (!rpp) { L.err('Cannot confirm retry order'); return { ok:false, msg:'Retry order not confirmed on MT' }; }
              positionId = rpp.positionId; if (rpp.entry) entry = rpp.entry; sym = rpp.symbol || sym;
            } else L.ok('Retry confirmed positionId:'+positionId);
          }
        } else {
          L.err(C.red+C.bold+'MT rejected order: '+err.type+C.reset);
          L.err('  Detail: '+err.msg);
          if (err.type==='UnauthorizedError') L.err('  Fix: new token at https://app.metaapi.cloud → update .env → restart');
          return { ok:false, msg:'MT error: '+err.type+' — '+err.msg };
        }
      }

      // Extract positionId from response — try all known MetaAPI field names
      var d = result.data || {};
      L.info('Raw MT response: '+JSON.stringify(d));
      var _pid = d.positionId !== undefined ? d.positionId :
                 d.orderId    !== undefined ? d.orderId    :
                 d.position   !== undefined ? d.position   :
                 d.id         !== undefined ? d.id         : null;
      positionId = (_pid != null && String(_pid) !== 'undefined' && String(_pid) !== 'null' && String(_pid) !== '0')
        ? String(_pid) : null;

      if (!positionId) {
        // No positionId in response — poll (some MetaAPI versions don't return it)
        L.warn('No positionId in response — polling...');
        var poll2 = await pollForPosition(sym, dir, 2000);
        if (!poll2) {
          L.err('Cannot confirm trade. ABORTED. Raw: '+JSON.stringify(d));
          return { ok:false, msg:'No positionId and not found on MT. Raw: '+JSON.stringify(d) };
        }
        positionId = poll2.positionId;
        if (poll2.entry) entry = poll2.entry;
        sym = poll2.symbol || sym;
      } else {
        L.ok('MT confirmed positionId:'+C.bold+positionId+C.reset);
      }
    }

  } catch(e) {
    L.err('mtPlace threw: '+e.message);
    return { ok:false, msg:'MetaAPI exception: '+e.message };
  }

  // ── Fetch actual fill price from MT ──────────────────────────────────────────
  try {
    var positions = await mtGetPositions();
    var pos = positions.find(function(p){ return String(p.id)===positionId; });
    if (!pos) pos = positions.find(function(p){ return sameInst(p.symbol,sym) && normType(p)===dir; });
    if (pos) {
      if (pos.openPrice) entry = pos.openPrice;
      if (pos.symbol) sym = canon(pos.symbol);
      if (pos.id) positionId = String(pos.id);
    }
  } catch(e) { L.warn('Fill price fetch error: '+e.message); }

  // ── Calculate SL/TP from fill price ─────────────────────────────────────────
  var finalSl  = orderSl;
  var finalTp  = orderTp;
  var finalTsl = CFG.TRAIL || null;

  if ((needPostSl || needPostTp || CFG.TRAIL) && entry) {
    var calc   = calcLevels(sym, dir, entry, slPipsToUse, tpPipsToUse);
    L.info('Pip calc for '+sym+': pip='+calc.pip+' entry='+entry+
      (slPipsToUse?' SL='+slPipsToUse+'pips→'+calc.sl:'')+
      (tpPipsToUse?' TP='+tpPipsToUse+'pips→'+calc.tp:''));
    if (needPostSl && calc.sl != null) finalSl = calc.sl;
    if (needPostTp && calc.tp != null) finalTp = calc.tp;
  } else if ((needPostSl || needPostTp) && !entry) {
    L.warn('No entry price — cannot calculate pip-based SL/TP. Skipping defaults.');
  }

  // Apply SL/TP/trailing via modify
  if ((finalSl != null || finalTp != null || finalTsl != null) && positionId) {
    var modR = await mtModify(positionId, finalSl, finalTp, finalTsl);
    var modE = metaErr(modR);
    if (modE.yes) {
      L.warn('Post-fill modify failed: '+modE.type+' — '+modE.msg);
      L.warn('Trade open, SL/TP NOT set. Use "update '+sym+'" to set manually.');
      finalSl = orderSl; finalTp = orderTp; finalTsl = null;
    } else {
      if (finalSl  != null) L.ok('SL applied: '+finalSl);
      if (finalTp  != null) L.ok('TP applied: '+finalTp);
      if (finalTsl != null) L.ok('Trailing SL applied: '+finalTsl+' pips');
    }
  }

  // ── Save to DB ───────────────────────────────────────────────────────────────
  var trade = {
    id:           genId(),
    positionId:   positionId,
    symbol:       sym,
    direction:    dir,
    entry:        entry,
    sl:           finalSl,
    tp:           finalTp,
    trailingSl:   finalTsl,
    slSource:     sigSlIsPrice?'signal-price':(sigSl?'signal-pips':(CFG.DEF_SL?'default-pips':null)),
    tpSource:     sigTpIsPrice?'signal-price':(sigTp?'signal-pips':(CFG.DEF_TP?'default-pips':null)),
    lot:          lots,
    status:       'open',
    pnl:          null, closePrice:null, closeReason:null, aiSummary:null,
    source:       'webhook',
    openTimeEAT:  toEatStr(tvTime),
    closeTimeEAT: null,
    updatedAt:    eatStr(),
  };
  dbSave(trade);

  var slLbl = (finalSl!=null?finalSl:'—')+(trade.slSource&&trade.slSource!=='signal-price'?' ['+trade.slSource+']':'');
  var tpLbl = (finalTp!=null?finalTp:'—')+(trade.tpSource&&trade.tpSource!=='signal-price'?' ['+trade.tpSource+']':'');
  if (dir==='buy')  L.buy(C.green+C.bold+'BUY OPENED'+C.reset+' '+sym+' entry:'+(entry||'market')+' SL:'+slLbl+' TP:'+tpLbl+' lot:'+lots+(finalTsl?' trail:'+finalTsl:''));
  else              L.sell(C.red+C.bold+'SELL OPENED'+C.reset+' '+sym+' entry:'+(entry||'market')+' SL:'+slLbl+' TP:'+tpLbl+' lot:'+lots+(finalTsl?' trail:'+finalTsl:''));
  printTradeCard(trade, 'OPENED ✔ — '+sym);

  // Deferred reconcile to fix any remaining positionId/symbol after MT processes order
  setTimeout(async function(){ try{ await reconcile(true); }catch(e){} }, 6000);

  return { ok:true, msg:'Trade opened', tradeId:trade.id };
}

// ─── CLOSE ───────────────────────────────────────────────────────────────────
async function closeTradeObj(t, reason) {
  reason = reason || 'manual';
  L.section('CLOSING '+t.symbol+' '+t.direction.toUpperCase());
  L.trade('posId:'+(t.positionId||'?')+' reason:'+reason);

  var closePrice = null, pnl = null;

  if (t.positionId) {
    var r = await mtClose(t.positionId);
    if (r.timedOut) {
      L.warn('Close timed out — verifying...');
      await new Promise(function(x){ setTimeout(x,3000); });
      var ps = await mtGetPositions().catch(function(){ return null; });
      if (ps && ps.find(function(p){ return String(p.id)===String(t.positionId); })) {
        L.err('Still open on MT — close FAILED');
        return { ok:false, msg:'Close timed out, position still open' };
      }
      L.ok('Confirmed closed despite timeout');
    } else {
      var e = metaErr(r);
      if (e.yes) {
        if (r.status===404||e.type.indexOf('NOT_FOUND')>=0) {
          L.warn('Not found on MT — already closed externally');
        } else {
          L.err('MT close error: '+e.type+' — '+e.msg);
          return { ok:false, msg:'Close failed: '+e.type };
        }
      } else {
        closePrice = (r.data&&(r.data.closePrice||r.data.price))||null;
        pnl        = (r.data&&r.data.profit!=null)?r.data.profit:null;
        L.ok('Closed. Price:'+(closePrice||'?')+' PnL:'+(pnl!=null?pnl:'?'));
      }
    }
  }

  if (pnl===null && t.entry && closePrice) {
    var diff = t.direction==='buy' ? closePrice-t.entry : t.entry-closePrice;
    pnl = +(diff*t.lot*100000).toFixed(2);
  }

  var ct = eatStr();
  var ai = ''; try { ai = await groqSummary(Object.assign({},t,{closePrice:closePrice,pnl:pnl,closeTimeEAT:ct,closeReason:reason})); } catch(e){}
  if (ai) L.info('AI: '+C.dim+ai+C.reset);

  var closed = dbClose(t.id, { closePrice:closePrice, pnl:pnl, closeReason:reason, closeTimeEAT:ct, aiSummary:ai, updatedAt:ct });
  printClosedCard(closed);
  var pc = (pnl||0)>=0?C.green:C.red;
  L.money('PnL: '+pc+C.bold+(pnl!=null?pnl.toFixed(2)+' USD':'N/A')+C.reset);
  return { ok:true, msg:'Closed', trade:closed };
}

async function closeBySymbol(sym, reason) {
  // First try DB
  var t = sym ? dbOpenBySym(sym) : dbOpenFirst();
  if (t) return closeTradeObj(t, reason||'manual');

  // Not in DB — try to find on MT directly (catches externally placed trades)
  L.warn('No open trade for '+sym+' in DB — searching MT directly...');
  try {
    var positions = await mtGetPositions();
    var pos = positions.find(function(p){ return sameInst(p.symbol, sym); });
    if (pos) {
      L.info('Found on MT: '+pos.symbol+' '+normType(pos)+' posId:'+pos.id+' — closing...');
      var r = await mtClose(String(pos.id));
      var e = metaErr(r);
      if (e.yes) { L.err('Close failed: '+e.type+' — '+e.msg); return { ok:false, msg:'Close failed: '+e.type }; }
      L.ok('Closed directly on MT: '+pos.symbol+' posId:'+pos.id);
      return { ok:true, msg:'Closed on MT directly' };
    }
  } catch(ex) { L.err('MT search error: '+ex.message); }
  L.warn('No open trade for '+sym+' found in DB or MT');
  return { ok:false, msg:'No open trade for '+sym };
}

async function updateBySymbol(sym, sl, tp) {
  var t = sym ? dbOpenBySym(sym) : dbOpenFirst();
  if (!t) { L.warn('No open trade for '+(sym||'any symbol')+' to update'); return { ok:false, msg:'No open trade' }; }
  L.section('UPDATING '+t.symbol);
  var r = await mtModify(t.positionId, sl, tp, null);
  var e = metaErr(r);
  if (r.timedOut) L.warn('Modify timed out — saving to DB anyway');
  else if (e.yes) L.err('Modify error: '+e.type+' — '+e.msg);
  else L.ok('MT modified SL:'+(sl||'—')+' TP:'+(tp||'—'));
  var upd = Object.assign({}, t, {
    sl: sl!=null?parseFloat(sl):t.sl, tp: tp!=null?parseFloat(tp):t.tp, updatedAt:eatStr()
  });
  dbSave(upd);
  L.ok('DB updated. SL:'+(upd.sl||'—')+' TP:'+(upd.tp||'—'));
  printTradeCard(upd, 'UPDATED — '+upd.symbol);
  return { ok:true, msg:'Updated' };
}

// ─── PRINT CARDS ──────────────────────────────────────────────────────────────
function printTradeCard(t, title) {
  title = title||'TRADE';
  var dc = t.direction==='buy'?C.green:C.red, ds = t.direction==='buy'?S.buy:S.sell;
  var sl_lbl = (t.sl!=null?t.sl:'—')+(t.slSource&&t.slSource!=='signal-price'?' ['+t.slSource+']':'');
  var tp_lbl = (t.tp!=null?t.tp:'—')+(t.tpSource&&t.tpSource!=='signal-price'?' ['+t.tpSource+']':'');
  console.log('');
  console.log(dc+C.bold+'  ┌─── '+title+' '+'─'.repeat(Math.max(0,52-title.length))+'┐'+C.reset);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'ID         :'+C.reset+' '+t.id+(t.source==='mt-external'?' '+C.magenta+'[EXTERNAL MT TRADE]'+C.reset:''));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Symbol     :'+C.reset+' '+t.symbol+'  '+dc+ds+' '+(t.direction||'').toUpperCase()+C.reset);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Position ID:'+C.reset+' '+(t.positionId||'—'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Entry      :'+C.reset+' '+(t.entry||'market'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Stop Loss  :'+C.reset+' '+sl_lbl);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Take Profit:'+C.reset+' '+tp_lbl);
  if (t.trailingSl) console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Trailing SL:'+C.reset+' '+t.trailingSl+' pips');
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Lot        :'+C.reset+' '+t.lot);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'PnL        :'+C.reset+' '+(t.pnl!=null?(t.pnl>=0?C.green:C.red)+t.pnl.toFixed(2)+' USD'+C.reset:'—'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Opened     :'+C.reset+' '+t.openTimeEAT);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Updated    :'+C.reset+' '+t.updatedAt);
  console.log(dc+C.bold+'  └'+'─'.repeat(56)+'┘'+C.reset);
  console.log('');
}
function printClosedCard(t) {
  var pnl = (t&&t.pnl!=null)?t.pnl:0;
  var dc  = pnl>=0?C.green:C.red, pfx = pnl>=0?'✔ PROFIT':'✖ LOSS';
  console.log('');
  console.log(dc+C.bold+'  ┌─── TRADE CLOSED ─────────────────────────────────────────┐'+C.reset);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Symbol     :'+C.reset+' '+t.symbol+' '+(t.direction||'').toUpperCase()+(t.source==='mt-external'?' [EXT]':''));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Position ID:'+C.reset+' '+(t.positionId||'—'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Entry      :'+C.reset+' '+(t.entry||'N/A'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Close Price:'+C.reset+' '+(t.closePrice||'N/A'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'SL / TP    :'+C.reset+' '+(t.sl!=null?t.sl:'—')+' / '+(t.tp!=null?t.tp:'—'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Lot        :'+C.reset+' '+t.lot);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'PnL        :'+C.reset+' '+dc+C.bold+pnl.toFixed(2)+' USD  '+pfx+C.reset);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Opened     :'+C.reset+' '+t.openTimeEAT);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Closed     :'+C.reset+' '+t.closeTimeEAT);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Reason     :'+C.reset+' '+t.closeReason);
  if (t.aiSummary) {
    var lines = t.aiSummary.match(/.{1,62}/g)||[];
    lines.forEach(function(l,i){
      if(i===0) console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'AI Notes   :'+C.reset+' '+C.dim+l+C.reset);
      else      console.log(dc+C.bold+'  │'+C.reset+'             '+C.dim+l+C.reset);
    });
  }
  console.log(dc+C.bold+'  └──────────────────────────────────────────────────────────┘'+C.reset);
  console.log('');
}

// ─── STATUS / HISTORY / ACCOUNT ───────────────────────────────────────────────
async function printStatus(fetchAcc) {
  L.section('BOT STATUS');
  var db = dbRead();
  console.log('  '+C.bold+'Bot Enabled :'+C.reset+' '+(CFG.ENABLED?C.green+'YES'+C.reset:C.red+'NO'+C.reset));
  console.log('  '+C.bold+'Lot         :'+C.reset+' '+CFG.LOT);
  console.log('  '+C.bold+'Defaults    :'+C.reset+' SL:'+(CFG.DEF_SL!=null?C.yellow+CFG.DEF_SL+' pips'+C.reset:'—')+'  TP:'+(CFG.DEF_TP!=null?C.yellow+CFG.DEF_TP+' pips'+C.reset:'—')+'  Trail:'+(CFG.TRAIL!=null?C.yellow+CFG.TRAIL+' pips'+C.reset:'—'));
  console.log('  '+C.bold+'Port        :'+C.reset+' '+CFG.PORT+'  |  '+C.bold+'Time:'+C.reset+' '+eatStr());
  console.log('  '+C.bold+'MetaAPI     :'+C.reset+' '+(CFG.TOKEN?C.green+'set'+C.reset:C.red+'NOT SET'+C.reset)+'  |  '+C.bold+'Account:'+C.reset+' '+(CFG.ACCOUNT||C.red+'NOT SET'+C.reset));
  console.log('  '+C.bold+'Groq AI     :'+C.reset+' '+(CFG.GROQ_KEY?C.green+'set'+C.reset:C.yellow+'not set'+C.reset));
  var tp = db.stats.totalPnl||0, pc = tp>=0?C.green:C.red;
  console.log('  '+C.bold+'Stats       :'+C.reset+' Trades:'+db.stats.total+'  '+C.green+'Wins:'+db.stats.wins+C.reset+'  '+C.red+'Losses:'+db.stats.losses+C.reset+'  PnL:'+pc+C.bold+tp.toFixed(2)+' USD'+C.reset);
  if (fetchAcc && CFG.TOKEN && CFG.ACCOUNT) {
    L.section('LIVE ACCOUNT');
    try {
      var acc = await mtGetAccount();
      if (acc && !acc.error) {
        console.log('  '+C.bold+'Name    :'+C.reset+' '+(acc.name||'—')+'  Login:'+acc.login+'  Server:'+acc.server);
        console.log('  '+C.bold+'Balance :'+C.reset+' '+C.green+(acc.balance!=null?acc.balance:'—')+' '+(acc.currency||'')+C.reset);
        console.log('  '+C.bold+'Equity  :'+C.reset+' '+(acc.equity!=null?acc.equity:'—')+' '+(acc.currency||''));
        console.log('  '+C.bold+'Margin  :'+C.reset+' Free:'+(acc.freeMargin!=null?acc.freeMargin:'—')+'  Leverage:1:'+(acc.leverage||'—'));
        console.log('  '+C.bold+'Platform:'+C.reset+' '+(acc.platform||'—')+'  Type:'+(acc.type||'—'));
      } else L.err('Account fetch failed: '+(acc&&acc.message?acc.message:'error'));
    } catch(e) { L.err('Account error: '+e.message); }
  }
  await reconcile(false);
}

function printHistory(n) {
  n = n||10;
  L.section('HISTORY (last '+n+')');
  var trades = dbRead().trades.slice().reverse().slice(0,n);
  if (!trades.length) { console.log('  '+C.dim+'No trades yet.'+C.reset+'\n'); return; }
  console.log('');
  trades.forEach(function(t,i){
    var dc   = t.direction==='buy'?C.green:C.red;
    var hasPnl = t.pnl!=null && t.pnl!==undefined;
    var pnlStr = hasPnl?(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+' USD':'open';
    var sc   = t.status==='open'?C.cyan:(hasPnl&&t.pnl>=0?C.green:C.red);
    var badge= t.status==='open'?C.cyan+'[OPEN]'+C.reset:sc+'[CLOSED]'+C.reset;
    var ext  = t.source==='mt-external'?' '+C.magenta+'[EXT]'+C.reset:'';
    console.log('  '+C.dim+(i+1)+'.'+C.reset+' '+C.bold+t.openTimeEAT+C.reset+'  '+dc+C.bold+(t.direction||'').padEnd(4)+C.reset+'  '+C.bold+(t.symbol||'').padEnd(10)+C.reset+ext);
    console.log('     Entry:'+(t.entry||'?')+'  SL:'+(t.sl!=null?t.sl:'—')+'  TP:'+(t.tp!=null?t.tp:'—')+'  Lot:'+t.lot+'  '+sc+C.bold+pnlStr+C.reset+'  '+badge);
    console.log('     PosID:'+(t.positionId||'—'));
    if (t.closeTimeEAT) console.log('     Closed:'+t.closeTimeEAT+'  Reason:'+(t.closeReason||'—'));
    if (t.aiSummary)    console.log('     '+C.dim+'AI: '+t.aiSummary.slice(0,120)+(t.aiSummary.length>120?'...':'')+C.reset);
    console.log('');
  });
}

// ─── WEBHOOK SERVER ───────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise(function(resolve,reject){
    var b='';
    req.on('data',function(c){b+=c;if(b.length>1e6)reject(new Error('Too large'));});
    req.on('end',function(){ try{resolve(JSON.parse(b));}catch(e){resolve({});} });
    req.on('error',reject);
  });
}

function createServer() {
  var handler = async function(req,res) {
    var u; try{u=new URL(req.url,'http://'+req.headers.host);}catch(e){u=new URL('http://x/');}
    res.setHeader('Content-Type','application/json');

    if (req.method==='GET' && u.pathname==='/') {
      res.writeHead(200);
      return res.end(JSON.stringify({ status:'running', botEnabled:CFG.ENABLED, time:eatStr(),
        openTrades:dbOpenAll().map(function(t){ return t.direction.toUpperCase()+' '+t.symbol+' posId:'+t.positionId+(t.source==='mt-external'?' [EXT]':''); }) }));
    }

    if (req.method==='POST' && u.pathname==='/webhook') {
      var payload; try{payload=await parseBody(req);}catch(e){res.writeHead(400);return res.end(JSON.stringify({ok:false,msg:'Bad body'}));}
      L.section('WEBHOOK HIT');
      L.info('Payload: '+C.dim+JSON.stringify(payload)+C.reset);
      if (CFG.SECRET) {
        if ((payload.secret||req.headers['x-secret'])!==CFG.SECRET) { L.warn('Bad secret'); res.writeHead(403); return res.end(JSON.stringify({ok:false,msg:'Forbidden'})); }
      }
      var result = await handleSignal(payload);
      res.writeHead(result.ok?200:400);
      return res.end(JSON.stringify(result));
    }

    if (req.method==='GET' && u.pathname==='/stats') {
      var db=dbRead(); res.writeHead(200);
      return res.end(JSON.stringify(Object.assign({},db.stats,{openTrades:dbOpenAll()})));
    }

    if (req.method==='GET' && u.pathname==='/debug') {
      try {
        var ps=await mtGetPositions(), ac=await mtGetAccount().catch(function(){return{};});
        res.writeHead(200);
        return res.end(JSON.stringify({ time:eatStr(), account:{ name:ac.name,login:ac.login,server:ac.server,balance:ac.balance,equity:ac.equity,currency:ac.currency },
          mtPositions:ps.map(function(p){ return {id:p.id,symbol:p.symbol,type:p.type,normType:normType(p),openPrice:p.openPrice,sl:p.stopLoss,tp:p.takeProfit,profit:p.profit,volume:p.volume,time:p.time||p.openTime}; }),
          dbOpenTrades:dbOpenAll() }, null,2));
      } catch(e){ res.writeHead(500); return res.end(JSON.stringify({error:e.message})); }
    }

    res.writeHead(404); res.end(JSON.stringify({ok:false,msg:'Not found'}));
  };
  var server = http.createServer(handler);
  server.on('error',function(e){
    if(e.code==='EACCES') L.err('Port '+CFG.PORT+' needs root. Use: sudo pm2 start bot.js');
    else L.err('Server error: '+e.message);
    process.exit(1);
  });
  return server;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function startCLI() {
  var rl = readline.createInterface({ input:process.stdin, output:process.stdout, prompt:C.cyan+C.bold+'bot> '+C.reset });
  console.log('\n  '+C.dim+'Type '+C.reset+C.bold+'help'+C.reset+C.dim+' for commands.'+C.reset+'\n');
  rl.prompt();
  rl.on('line', async function(line) {
    var parts = line.trim().split(/\s+/);
    var cmd   = (parts[0]||'').toLowerCase();
    switch(cmd) {
      case 'status': case 's':    await printStatus(false); break;
      case 'account': case 'acc': await printStatus(true);  break;
      case 'history': case 'h':   printHistory(parseInt(parts[1])||10); break;
      case 'sync':                await reconcile(false); break;
      case 'close':
        await closeBySymbol((parts[1]||'').toUpperCase()||null, 'CLI close');
        break;
      case 'update':
        // update [SYMBOL] [sl] [tp]  OR  update [sl] [tp]  (if only one trade open)
        if (parts[1] && isNaN(parseFloat(parts[1]))) {
          // first arg is a symbol
          await updateBySymbol(parts[1].toUpperCase(), parts[2]||null, parts[3]||null);
        } else {
          await updateBySymbol(null, parts[1]||null, parts[2]||null);
        }
        break;
      case 'mt': case 'positions':
        L.section('LIVE MT POSITIONS');
        try {
          var ps = await mtGetPositions();
          if (!ps.length) { console.log('  '+C.dim+'No positions on MT.'+C.reset+'\n'); break; }
          ps.forEach(function(p,i){
            var d=normType(p), dc=d==='buy'?C.green:C.red;
            console.log('  '+(i+1)+'. '+dc+C.bold+p.symbol+' '+(d||'?').toUpperCase()+C.reset+
              '  posId:'+p.id+'  entry:'+p.openPrice+'  lot:'+p.volume+
              '  SL:'+(p.stopLoss||'—')+'  TP:'+(p.takeProfit||'—')+
              '  PnL:'+((p.profit>=0?C.green:C.red)+(p.profit!=null?p.profit.toFixed(2):'?')+' USD'+C.reset)+
              '  '+C.dim+toEatStr(p.time||p.openTime)+C.reset);
          });
          console.log('');
        } catch(e){ L.err('MT fetch failed: '+e.message); }
        break;
      case 'enable':    CFG.ENABLED=true;  L.ok('Bot ENABLED'); break;
      case 'disable':   CFG.ENABLED=false; L.warn('Bot DISABLED'); break;
      case 'set-sl':
        if(!parts[1]){L.warn('Usage: set-sl <pips>  e.g. set-sl 50');break;}
        CFG.DEF_SL=parseFloat(parts[1]); L.ok('Default SL: '+CFG.DEF_SL+' pips'); break;
      case 'set-tp':
        if(!parts[1]){L.warn('Usage: set-tp <pips>  e.g. set-tp 100');break;}
        CFG.DEF_TP=parseFloat(parts[1]); L.ok('Default TP: '+CFG.DEF_TP+' pips'); break;
      case 'set-trail':
        if(!parts[1]){L.warn('Usage: set-trail <pips>  e.g. set-trail 20  (0 = disable)');break;}
        CFG.TRAIL=parseFloat(parts[1])||null; L.ok(CFG.TRAIL?'Trailing SL: '+CFG.TRAIL+' pips':'Trailing SL disabled'); break;
      case 'set-lot':
        if(!parts[1]){L.warn('Usage: set-lot <value>  e.g. set-lot 0.05');break;}
        CFG.LOT=parseFloat(parts[1]); L.ok('Default lot: '+CFG.LOT); break;
      case 'test-buy':
        await handleSignal({ action:'buy',  symbol:parts[1]||'EURUSD', sl:parts[2], tp:parts[3], lot:CFG.LOT }); break;
      case 'test-sell':
        await handleSignal({ action:'sell', symbol:parts[1]||'EURUSD', sl:parts[2], tp:parts[3], lot:CFG.LOT }); break;
      case 'config':
        L.section('CONFIG');
        console.log('  META_API_TOKEN  : '+(CFG.TOKEN?C.green+'set ('+CFG.TOKEN.slice(0,8)+'...)'+C.reset:C.red+'NOT SET'+C.reset));
        console.log('  META_ACCOUNT_ID : '+(CFG.ACCOUNT||C.red+'NOT SET'+C.reset));
        console.log('  GROQ_API_KEY    : '+(CFG.GROQ_KEY?C.green+'set'+C.reset:C.yellow+'not set'+C.reset));
        console.log('  LOT_SIZE        : '+CFG.LOT);
        console.log('  DEFAULT_SL      : '+(CFG.DEF_SL!=null?C.yellow+CFG.DEF_SL+' pips'+C.reset:C.dim+'not set'+C.reset));
        console.log('  DEFAULT_TP      : '+(CFG.DEF_TP!=null?C.yellow+CFG.DEF_TP+' pips'+C.reset:C.dim+'not set'+C.reset));
        console.log('  TRAILING_SL     : '+(CFG.TRAIL!=null?C.yellow+CFG.TRAIL+' pips'+C.reset:C.dim+'not set'+C.reset));
        console.log('  PORT            : '+CFG.PORT);
        console.log('  BOT_ENABLED     : '+(CFG.ENABLED?C.green+'true'+C.reset:C.red+'false'+C.reset));
        console.log('  WEBHOOK_SECRET  : '+(CFG.SECRET?C.green+'set'+C.reset:'none'));
        console.log('  POLL_INTERVAL   : '+CFG.POLL_SEC+'s');
        console.log('  DB_PATH         : '+CFG.DB);
        console.log('  LOG_PATH        : '+CFG.LOG);
        console.log('\n  Live commands: set-sl  set-tp  set-trail  set-lot  enable  disable');
        break;
      case 'db':
        L.section('RAW DB'); console.log(JSON.stringify(dbRead(),null,2)); break;
      case 'help': case '?':
        console.log('\n'+C.cyan+C.bold+'  Commands:'+C.reset);
        console.log('  '+C.bold+'status'+C.reset+'  (s)                   Show status + open trades');
        console.log('  '+C.bold+'account'+C.reset+' (acc)                 Live MT account: balance, equity');
        console.log('  '+C.bold+'history'+C.reset+' (h) [n]               Last n trades (default 10)');
        console.log('  '+C.bold+'sync'+C.reset+'                          Full two-way MT ↔ DB reconcile');
        console.log('  '+C.bold+'mt'+C.reset+' / '+C.bold+'positions'+C.reset+'                Show raw MT positions');
        console.log('  '+C.bold+'close'+C.reset+' [SYMBOL]               Close trade (e.g. close GOLD)');
        console.log('  '+C.bold+'update'+C.reset+' [SYMBOL] [sl] [tp]     Update SL/TP (e.g. update GOLD 2000 2100)');
        console.log('  '+C.bold+'set-sl'+C.reset+' <pips>                 Set default SL in pips');
        console.log('  '+C.bold+'set-tp'+C.reset+' <pips>                 Set default TP in pips');
        console.log('  '+C.bold+'set-trail'+C.reset+' <pips>              Set trailing SL in pips (0=off)');
        console.log('  '+C.bold+'set-lot'+C.reset+' <value>               Set default lot size');
        console.log('  '+C.bold+'enable'+C.reset+' / '+C.bold+'disable'+C.reset+'               Toggle bot on/off');
        console.log('  '+C.bold+'config'+C.reset+'                        Show all settings');
        console.log('  '+C.bold+'db'+C.reset+'                            Dump raw trades.json');
        console.log('  '+C.bold+'test-buy'+C.reset+'  [sym] [sl] [tp]     Simulate BUY webhook');
        console.log('  '+C.bold+'test-sell'+C.reset+' [sym] [sl] [tp]     Simulate SELL webhook');
        console.log('  '+C.bold+'exit'+C.reset+' / '+C.bold+'quit'+C.reset+'                   Shutdown\n');
        console.log('  '+C.dim+'Multi-symbol: each symbol independent. Same sym+dir = blocked.'+C.reset);
        console.log('  '+C.dim+'Same sym, opposite dir = flip. Different sym = runs alongside.'+C.reset+'\n');
        break;
      case 'exit': case 'quit': L.info('Shutting down'); process.exit(0); break;
      case '': break;
      default: L.warn('Unknown: "'+cmd+'" — type help');
    }
    rl.prompt();
  });
  rl.on('close',function(){ process.exit(0); });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  banner('  TRADINGVIEW → METATRADER CLI BOT  v3.0  ');
  console.log('  '+C.dim+'EAT (UTC+3) | Multi-Symbol | Auto-Detect External Trades | Zero Deps'+C.reset+'\n');

  if (!CFG.TOKEN)   L.warn('META_API_TOKEN not set in .env');
  if (!CFG.ACCOUNT) L.warn('META_ACCOUNT_ID not set in .env');
  if (!CFG.GROQ_KEY) L.warn('GROQ_API_KEY not set — AI summaries disabled');

  // Startup: show status + initial reconcile
  await printStatus(false);

  // Start HTTP server
  createServer().listen(CFG.PORT, function() {
    L.ok('Webhook server on port '+C.bold+CFG.PORT+C.reset);
    L.info('Webhook : '+C.cyan+'http://54.204.233.214/webhook'+C.reset);
    L.info('Health  : '+C.cyan+'http://54.204.233.214/'+C.reset);
    L.info('Debug   : '+C.cyan+'http://54.204.233.214/debug'+C.reset);
  });

  startCLI();

  // Background reconcile loop
  if (CFG.TOKEN && CFG.ACCOUNT) {
    L.info('Background reconcile every '+CFG.POLL_SEC+'s (detects external trades & SL/TP hits)');
    setInterval(async function() {
      try { await reconcile(true); } catch(e) { L.warn('[POLLER] '+e.message); }
    }, CFG.POLL_SEC * 1000);
  }
}

main().catch(function(e){ console.error(C.red+'FATAL: '+e.message+C.reset); process.exit(1); });
