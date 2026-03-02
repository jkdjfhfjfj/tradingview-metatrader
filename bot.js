#!/usr/bin/env node

/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║           TRADINGVIEW → METATRADER CLI TRADING BOT                  ║
 * ║           Single-File | JSON Storage | EAT Timezone                 ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ─── LOAD .ENV ────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const i = t.indexOf('=');
    if (i === -1) return;
    const key = t.slice(0, i).trim();
    const val = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  });
}
loadEnv();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  META_API_TOKEN:  process.env.META_API_TOKEN  || '',
  META_ACCOUNT_ID: process.env.META_ACCOUNT_ID || '',
  META_API_BASE:   'https://mt-client-api-v1.london.agiliumtrade.ai',
  GROQ_API_KEY:    process.env.GROQ_API_KEY    || '',
  GROQ_MODEL:      process.env.GROQ_MODEL      || 'llama3-70b-8192',
  LOT_SIZE:        parseFloat(process.env.LOT_SIZE || '0.01'),
  WEBHOOK_SECRET:  process.env.WEBHOOK_SECRET  || '',
  BOT_ENABLED:     process.env.BOT_ENABLED     !== 'false',
  PORT:            parseInt(process.env.PORT   || '80'),
  DB_PATH:         path.join(__dirname, 'trades.json'),
  LOG_PATH:        path.join(__dirname, 'bot.log'),
};

// ─── EAT TIMEZONE (UTC+3) ─────────────────────────────────────────────────────
function toEAT(date) {
  date = date || new Date();
  return new Date(date.getTime() + date.getTimezoneOffset() * 60000 + 3 * 3600000);
}
function eatString(date) {
  const d = toEAT(date);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' EAT';
}
function parseToEAT(s) {
  if (!s) return eatString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? eatString() : eatString(d);
}

// ─── COLORS ───────────────────────────────────────────────────────────────────
const C = {
  reset:'',   bold:'',   dim:'',
  red:'',   green:'',   yellow:'',
  blue:'',   magenta:'',   cyan:'',
};
// Only apply ANSI if TTY
if (process.stdout.isTTY) {
  C.reset='\x1b[0m'; C.bold='\x1b[1m'; C.dim='\x1b[2m';
  C.red='\x1b[31m'; C.green='\x1b[32m'; C.yellow='\x1b[33m';
  C.blue='\x1b[34m'; C.magenta='\x1b[35m'; C.cyan='\x1b[36m';
}
const S = { buy:'▲', sell:'▼', info:'◆', warn:'⚠', err:'✖', ok:'✔', trade:'⟳', money:'$', line:'─' };

// ─── LOGGER ───────────────────────────────────────────────────────────────────
const logStream = fs.createWriteStream(CONFIG.LOG_PATH, { flags: 'a' });
function ts() { return eatString().replace(' EAT',''); }
function log(level, sym, color, args) {
  const msg = args.join(' ');
  console.log(C.dim+'['+ts()+']'+C.reset+' '+color+C.bold+sym+C.reset+' '+msg);
  logStream.write('['+ts()+'] ['+level+'] '+msg.replace(/\x1b\[[0-9;]*m/g,'')+'\n');
}
const logger = {
  info:    function() { log('INFO',  S.info,  C.cyan,    Array.from(arguments)); },
  success: function() { log('OK',    S.ok,    C.green,   Array.from(arguments)); },
  warn:    function() { log('WARN',  S.warn,  C.yellow,  Array.from(arguments)); },
  error:   function() { log('ERR',   S.err,   C.red,     Array.from(arguments)); },
  trade:   function() { log('TRADE', S.trade, C.magenta, Array.from(arguments)); },
  buy:     function() { log('BUY',   S.buy,   C.green,   Array.from(arguments)); },
  sell:    function() { log('SELL',  S.sell,  C.red,     Array.from(arguments)); },
  money:   function() { log('PNL',   S.money, C.yellow,  Array.from(arguments)); },
  section: function(t) {
    console.log('');
    console.log(C.blue+C.bold+'  ── '+t+' '+'─'.repeat(Math.max(0,60-t.length))+C.reset);
  },
};
function banner(txt, color) {
  color = color || C.cyan;
  const line = S.line.repeat(68);
  const pad  = txt.padStart(Math.floor((68+txt.length)/2)).padEnd(68);
  console.log(color+C.bold+'┌'+line+'┐\n│'+pad+'│\n└'+line+'┘'+C.reset);
}

// ─── JSON DATABASE ────────────────────────────────────────────────────────────
function dbRead() {
  if (!fs.existsSync(CONFIG.DB_PATH)) {
    const init = { trades:[], stats:{ total:0, wins:0, losses:0, totalPnl:0 } };
    fs.writeFileSync(CONFIG.DB_PATH, JSON.stringify(init,null,2));
    return init;
  }
  try { return JSON.parse(fs.readFileSync(CONFIG.DB_PATH,'utf8')); }
  catch(e) { return { trades:[], stats:{ total:0, wins:0, losses:0, totalPnl:0 } }; }
}
function dbWrite(data) { fs.writeFileSync(CONFIG.DB_PATH, JSON.stringify(data,null,2)); }
function dbGetOpenTrade() { return dbRead().trades.find(function(t){ return t.status==='open'; }) || null; }
function dbSaveTrade(trade) {
  const db = dbRead();
  const idx = db.trades.findIndex(function(t){ return t.id===trade.id; });
  if (idx >= 0) db.trades[idx] = trade; else db.trades.push(trade);
  dbWrite(db);
}
function dbCloseTrade(id, closeData) {
  const db  = dbRead();
  const idx = db.trades.findIndex(function(t){ return t.id===id; });
  if (idx < 0) return null;
  Object.assign(db.trades[idx], closeData, { status:'closed' });
  const pnl = db.trades[idx].pnl || 0;
  db.stats.total++;
  db.stats.totalPnl = +(db.stats.totalPnl + pnl).toFixed(2);
  if (pnl >= 0) db.stats.wins++; else db.stats.losses++;
  dbWrite(db);
  return db.trades[idx];
}

// ─── META API CLIENT ──────────────────────────────────────────────────────────
function metaRequest(method, endpoint, body, timeoutMs) {
  body       = body       || null;
  timeoutMs  = timeoutMs  || 20000;

  return new Promise(function(resolve, reject) {
    if (!CONFIG.META_API_TOKEN || !CONFIG.META_ACCOUNT_ID)
      return reject(new Error('MetaAPI credentials not configured'));

    const url    = CONFIG.META_API_BASE+'/users/current/accounts/'+CONFIG.META_ACCOUNT_ID+endpoint;
    const parsed = new URL(url);
    const data   = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   method,
      headers: Object.assign({
        'auth-token':   CONFIG.META_API_TOKEN,
        'Content-Type': 'application/json',
      }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    };

    let settled = false;
    function done(fn, v) { if (!settled) { settled=true; clearTimeout(timer); fn(v); } }

    const timer = setTimeout(function() {
      try { req.destroy(); } catch(e) {}
      done(resolve, { status:0, data:null, timedOut:true });
    }, timeoutMs);

    const req = https.request(options, function(res) {
      let raw = '';
      res.on('data', function(c){ raw += c; });
      res.on('end', function() {
        let parsed2 = null;
        try { parsed2 = raw ? JSON.parse(raw) : {}; } catch(e) { parsed2 = { _raw:raw }; }
        done(resolve, { status:res.statusCode, data:parsed2, timedOut:false });
      });
    });
    req.on('error', function(e){ done(reject, e); });
    if (data) req.write(data);
    req.end();
  });
}

// ── KEY FIX: only treat response as error if "error" field OR HTTP 4xx/5xx.
// NEVER use "message" field as error signal — MetaAPI success responses
// also include a "message" field, which was causing false aborts.
function isMetaError(result) {
  if (!result) return { yes:true, type:'NullResponse', msg:'No response' };
  if (result.timedOut) return { yes:false };
  if (result.status >= 400) {
    return {
      yes:  true,
      type: (result.data && result.data.error) || ('HTTP_'+result.status),
      msg:  (result.data && result.data.message) || JSON.stringify(result.data),
    };
  }
  if (result.data && result.data.error) {
    return { yes:true, type:result.data.error, msg:result.data.message || JSON.stringify(result.data) };
  }
  return { yes:false };
}

function metaGetAccount() {
  return metaRequest('GET','/account-information').then(function(r){ return r.data || {}; });
}
function metaGetPositions() {
  return metaRequest('GET','/positions').then(function(r){
    if (!r.data || r.timedOut) return [];
    return Array.isArray(r.data) ? r.data : [];
  });
}
function metaPlaceOrder(symbol, type, lots, sl, tp) {
  const body = { symbol:symbol, volume:lots, actionType:type };
  if (sl) body.stopLoss   = parseFloat(sl);
  if (tp) body.takeProfit = parseFloat(tp);
  return metaRequest('POST','/trade', body);
}
function metaClosePosition(positionId) {
  return metaRequest('POST','/trade', { actionType:'POSITION_CLOSE_ID', positionId:positionId });
}
function metaModifyPosition(positionId, sl, tp) {
  const body = { actionType:'POSITION_MODIFY', positionId:positionId };
  if (sl != null) body.stopLoss   = parseFloat(sl);
  if (tp != null) body.takeProfit = parseFloat(tp);
  return metaRequest('POST','/trade', body);
}

// ── After timeout: wait then poll positions to confirm order landed ───────────
function confirmOrderAfterTimeout(symbol, direction) {
  logger.warn('MetaAPI timed out — waiting 4s then polling MT positions...');
  return new Promise(function(resolve) { setTimeout(resolve, 4000); }).then(function() {
    return metaGetPositions().then(function(positions) {
      const metaType = direction === 'buy' ? 'POSITION_TYPE_BUY' : 'POSITION_TYPE_SELL';
      const sym      = (symbol || '').toUpperCase();
      const matches  = positions.filter(function(p){ return p.symbol===sym && p.type===metaType; });
      matches.sort(function(a,b){ return new Date(b.time||0)-new Date(a.time||0); });
      const match    = matches[0];
      if (match) {
        logger.success('Order confirmed via poll! ID:'+C.bold+match.id+C.reset+' Entry:'+match.openPrice);
        return { found:true, positionId:match.id, entryPrice:match.openPrice, raw:match };
      }
      logger.error('No matching '+direction.toUpperCase()+' position found on MT after timeout.');
      return { found:false };
    }).catch(function(e) {
      logger.error('Position poll failed: '+e.message);
      return { found:false };
    });
  });
}

// ─── GROQ AI ──────────────────────────────────────────────────────────────────
function groqSummary(trade) {
  return new Promise(function(resolve) {
    if (!CONFIG.GROQ_API_KEY) return resolve('(Groq not configured)');
    const prompt =
      'You are a forex analyst. Summarize this closed trade in 2-3 sentences: what happened, result, lesson.\n\n' +
      'Symbol:'+trade.symbol+' Direction:'+trade.direction+' Entry:'+trade.entry+
      ' SL:'+trade.sl+' TP:'+trade.tp+' Close:'+trade.closePrice+
      ' PnL:'+(trade.pnl!=null?trade.pnl:'N/A')+' USD Lot:'+trade.lot+
      ' Opened:'+trade.openTimeEAT+' Closed:'+trade.closeTimeEAT+' Reason:'+trade.closeReason;

    const body = JSON.stringify({ model:CONFIG.GROQ_MODEL, messages:[{role:'user',content:prompt}], max_tokens:200 });
    const req  = https.request({
      hostname:'api.groq.com', path:'/openai/v1/chat/completions', method:'POST',
      headers:{ 'Authorization':'Bearer '+CONFIG.GROQ_API_KEY, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) },
    }, function(res) {
      let raw='';
      res.on('data',function(c){raw+=c;});
      res.on('end',function(){
        try { resolve(JSON.parse(raw).choices[0].message.content.trim()); }
        catch(e) { resolve('(AI parse error)'); }
      });
    });
    req.on('error', function(){ resolve('(AI request failed)'); });
    req.setTimeout(15000, function(){ req.destroy(); resolve('(AI timed out)'); });
    req.write(body);
    req.end();
  });
}

// ─── TRADE ENGINE ─────────────────────────────────────────────────────────────
function genId() { return 'T'+Date.now()+'-'+Math.random().toString(36).slice(2,6).toUpperCase(); }

async function handleSignal(payload) {
  logger.section('INCOMING SIGNAL');
  const action    = payload.action;
  const symbol    = payload.symbol;
  const sl        = payload.sl;
  const tp        = payload.tp;
  const lot       = payload.lot;
  const price     = payload.price;
  const time      = payload.time;
  const direction = action ? action.toLowerCase() : '';
  const lot_size  = parseFloat(lot) || CONFIG.LOT_SIZE;

  logger.info('Signal: '+C.bold+direction.toUpperCase()+C.reset+' '+symbol+' | Lot:'+lot_size+' | SL:'+(sl||'—')+' | TP:'+(tp||'—'));

  if (!CONFIG.BOT_ENABLED) {
    logger.warn(C.yellow+C.bold+'Bot DISABLED — signal ignored.'+C.reset);
    return { ok:false, msg:'Bot disabled' };
  }
  if (direction === 'close')  return closeCurrent('manual close signal');
  if (direction === 'update') return updateCurrent(sl, tp);
  if (direction !== 'buy' && direction !== 'sell') {
    logger.error('Unknown action: "'+direction+'"');
    return { ok:false, msg:'Unknown action: '+direction };
  }
  if (!CONFIG.META_API_TOKEN || !CONFIG.META_ACCOUNT_ID) {
    logger.error(C.red+C.bold+'MetaAPI credentials missing — trade ABORTED.'+C.reset);
    return { ok:false, msg:'MetaAPI credentials not configured' };
  }

  const openTrade = dbGetOpenTrade();

  // ── Same direction: block ────────────────────────────────────────────────────
  if (openTrade && openTrade.direction === direction) {
    const warn = direction.toUpperCase()+' already running! ID:'+openTrade.id+' ('+openTrade.symbol+')';
    logger.warn(C.yellow+C.bold+warn+C.reset);
    printTradeCard(openTrade, 'BLOCKED — ALREADY OPEN');
    return { ok:false, msg:warn };
  }

  // ── Opposite direction: flip ─────────────────────────────────────────────────
  if (openTrade && openTrade.direction !== direction) {
    logger.trade('FLIP: closing '+openTrade.direction.toUpperCase()+' → opening '+direction.toUpperCase());
    const closeResult = await closeCurrent('flipped to '+direction.toUpperCase());
    if (!closeResult.ok) {
      logger.error(C.red+C.bold+'FLIP ABORTED — existing trade could not be closed.'+C.reset);
      return { ok:false, msg:'Flip aborted — close of '+openTrade.direction.toUpperCase()+' failed' };
    }
    logger.success('Flip: '+openTrade.direction.toUpperCase()+' closed ✔  Opening '+direction.toUpperCase()+'...');
  }

  // ── Place order ───────────────────────────────────────────────────────────────
  logger.section('PLACING '+direction.toUpperCase()+' ON METATRADER');
  let metaPositionId = null;
  let entryPrice     = price ? parseFloat(price) : null;

  try {
    const metaType = direction === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
    const result   = await metaPlaceOrder(symbol, metaType, lot_size, sl, tp);

    if (result.timedOut) {
      // ── Timeout: poll to confirm ─────────────────────────────────────────────
      const confirm = await confirmOrderAfterTimeout(symbol, direction);
      if (!confirm.found) {
        logger.warn(C.yellow+'Could not confirm order after timeout. Trade NOT saved.'+C.reset);
        return { ok:false, msg:'Timeout — no matching position found on MT' };
      }
      metaPositionId = confirm.positionId;
      entryPrice     = confirm.entryPrice || entryPrice;

    } else {
      // ── Check for hard error ─────────────────────────────────────────────────
      const err = isMetaError(result);
      if (err.yes) {
        logger.error(C.red+C.bold+'MetaTrader REJECTED the order!'+C.reset);
        logger.error('  Type  : '+C.red+err.type+C.reset);
        logger.error('  Detail: '+C.red+err.msg+C.reset);
        if (err.type === 'UnauthorizedError')
          logger.error('  Fix   : Get a new token at https://app.metaapi.cloud → update .env → restart');
        logger.warn('Trade ABORTED — nothing saved to DB.');
        return { ok:false, msg:'MetaTrader error: '+err.type+' — '+err.msg };
      }

      // ── Extract positionId ───────────────────────────────────────────────────
      metaPositionId = (result.data && (result.data.positionId || result.data.orderId)) || null;

      if (!metaPositionId) {
        // Some MetaAPI deployments don't return positionId in the trade response
        logger.warn('No positionId in trade response — polling positions...');
        await new Promise(function(r){ setTimeout(r,2000); });
        const confirm = await confirmOrderAfterTimeout(symbol, direction);
        if (confirm.found) {
          metaPositionId = confirm.positionId;
          entryPrice     = confirm.entryPrice || entryPrice;
        } else {
          logger.error('Cannot confirm trade on MT. ABORTED.');
          return { ok:false, msg:'No positionId and position not found on MT' };
        }
      } else {
        logger.success('Order confirmed! positionId:'+C.bold+metaPositionId+C.reset);
        // Fetch actual fill price
        try {
          const positions = await metaGetPositions();
          const pos = positions.find(function(p){ return p.id===metaPositionId; });
          if (pos) entryPrice = pos.openPrice || entryPrice;
        } catch(e) {}
      }
    }

  } catch(e) {
    logger.error('MetaAPI threw: '+C.red+e.message+C.reset);
    logger.warn('Trade ABORTED — nothing saved.');
    return { ok:false, msg:'MetaAPI exception: '+e.message };
  }

  // ── Save only after MT confirmed ─────────────────────────────────────────────
  const trade = {
    id:           genId(),
    positionId:   metaPositionId,
    symbol:       (symbol||'').toUpperCase(),
    direction:    direction,
    entry:        entryPrice,
    sl:           sl != null ? parseFloat(sl) : null,
    tp:           tp != null ? parseFloat(tp) : null,
    lot:          lot_size,
    status:       'open',
    pnl:          null,
    closePrice:   null,
    closeReason:  null,
    aiSummary:    null,
    openTimeEAT:  parseToEAT(time),
    closeTimeEAT: null,
    updatedAt:    eatString(),
  };

  dbSaveTrade(trade);

  if (direction === 'buy')
    logger.buy(C.green+C.bold+'BUY OPENED'+C.reset+' '+symbol+' | Entry:'+(entryPrice||'market')+' | SL:'+(sl||'—')+' | TP:'+(tp||'—')+' | Lot:'+lot_size);
  else
    logger.sell(C.red+C.bold+'SELL OPENED'+C.reset+' '+symbol+' | Entry:'+(entryPrice||'market')+' | SL:'+(sl||'—')+' | TP:'+(tp||'—')+' | Lot:'+lot_size);

  printTradeCard(trade, 'TRADE OPENED ✔');
  return { ok:true, msg:'Trade opened', tradeId:trade.id };
}

// ─── CLOSE CURRENT ────────────────────────────────────────────────────────────
async function closeCurrent(reason) {
  reason = reason || 'manual';
  const openTrade = dbGetOpenTrade();
  if (!openTrade) {
    logger.warn('No open trade in DB.');
    return { ok:false, msg:'No open trade' };
  }

  logger.section('CLOSING TRADE');
  logger.trade('Closing '+openTrade.direction.toUpperCase()+' '+openTrade.symbol+' | Reason: '+reason);

  let closePrice = null;
  let pnl        = null;

  if (openTrade.positionId) {
    try {
      const result = await metaClosePosition(openTrade.positionId);

      if (result.timedOut) {
        logger.warn('Close timed out — verifying on MT...');
        await new Promise(function(r){ setTimeout(r,3000); });
        const positions = await metaGetPositions();
        const stillOpen = positions.find(function(p){ return p.id===openTrade.positionId; });
        if (stillOpen) {
          logger.error('Position STILL open on MT. Close failed.');
          return { ok:false, msg:'Close timed out — position still open on MT' };
        }
        logger.success('Position gone from MT — confirmed closed despite timeout.');

      } else {
        const err = isMetaError(result);
        if (err.yes) {
          // 404 / NOT_FOUND means already closed on MT — still mark closed in DB
          if (result.status === 404 || (err.type && err.type.indexOf('NOT_FOUND') >= 0)) {
            logger.warn('Position not found on MT — already closed externally. Marking in DB.');
          } else {
            logger.error('MT close error: '+err.type+' — '+err.msg);
            return { ok:false, msg:'Close failed: '+err.type };
          }
        } else {
          closePrice = (result.data && (result.data.closePrice || result.data.price)) || null;
          pnl        = (result.data && result.data.profit != null) ? result.data.profit : null;
          logger.success('MT closed. Price:'+(closePrice||'N/A')+' PnL:'+(pnl!=null?pnl:'N/A'));
        }
      }
    } catch(e) {
      logger.error('Close threw: '+e.message);
      return { ok:false, msg:'Close exception: '+e.message };
    }
  }

  // Estimate PnL if MT didn't return it
  if (pnl === null && openTrade.entry && closePrice) {
    const diff = openTrade.direction === 'buy'
      ? closePrice - openTrade.entry
      : openTrade.entry - closePrice;
    pnl = +(diff * openTrade.lot * 100000).toFixed(2);
  }

  const closeTimeEAT = eatString();
  logger.info('Getting AI summary...');
  const aiSummary = await groqSummary(Object.assign({}, openTrade, { closePrice:closePrice, pnl:pnl, closeTimeEAT:closeTimeEAT, closeReason:reason }));
  if (aiSummary && aiSummary[0] !== '(') logger.info('AI: '+C.dim+aiSummary+C.reset);

  const closed = dbCloseTrade(openTrade.id, { closePrice:closePrice, pnl:pnl, closeReason:reason, closeTimeEAT:closeTimeEAT, aiSummary:aiSummary, updatedAt:closeTimeEAT });
  printClosedCard(closed);

  const pc = (pnl||0) >= 0 ? C.green : C.red;
  logger.money('Final PnL: '+pc+C.bold+(pnl!=null ? pnl.toFixed(2)+' USD' : 'N/A')+C.reset);
  return { ok:true, msg:'Trade closed', trade:closed };
}

// ─── UPDATE CURRENT ───────────────────────────────────────────────────────────
async function updateCurrent(sl, tp) {
  const openTrade = dbGetOpenTrade();
  if (!openTrade) {
    logger.warn('No open trade in DB to update.');
    return { ok:false, msg:'No open trade' };
  }
  logger.section('UPDATING TRADE SL/TP');

  if (openTrade.positionId) {
    try {
      const result = await metaModifyPosition(openTrade.positionId, sl, tp);
      if (result.timedOut) {
        logger.warn('Modify timed out — saved to DB anyway.');
      } else {
        const err = isMetaError(result);
        if (err.yes) logger.error('MT modify error: '+err.type+' — '+err.msg);
        else logger.success('MT position modified. SL:'+(sl||'—')+' TP:'+(tp||'—'));
      }
    } catch(e) { logger.error('Modify threw: '+e.message); }
  }

  const updated = Object.assign({}, openTrade, {
    sl:        sl != null ? parseFloat(sl) : openTrade.sl,
    tp:        tp != null ? parseFloat(tp) : openTrade.tp,
    updatedAt: eatString(),
  });
  dbSaveTrade(updated);
  logger.success('DB updated. SL:'+(updated.sl||'—')+' TP:'+(updated.tp||'—'));
  printTradeCard(updated, 'TRADE UPDATED');
  return { ok:true, msg:'Trade updated' };
}

// ─── PRINT HELPERS ────────────────────────────────────────────────────────────
function printTradeCard(t, title) {
  title = title || 'TRADE';
  const dc = t.direction === 'buy' ? C.green : C.red;
  const ds = t.direction === 'buy' ? S.buy : S.sell;
  const bar = '─'.repeat(Math.max(0, 50-title.length));
  console.log('');
  console.log(dc+C.bold+'  ┌─── '+title+' '+bar+'┐'+C.reset);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'ID          :'+C.reset+' '+t.id);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Symbol      :'+C.reset+' '+t.symbol+'  '+dc+ds+' '+t.direction.toUpperCase()+C.reset);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Position ID :'+C.reset+' '+(t.positionId||'—'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Entry       :'+C.reset+' '+(t.entry||'market'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Stop Loss   :'+C.reset+' '+(t.sl!=null?t.sl:'—'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Take Profit :'+C.reset+' '+(t.tp!=null?t.tp:'—'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Lot         :'+C.reset+' '+t.lot);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Opened      :'+C.reset+' '+t.openTimeEAT);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Updated     :'+C.reset+' '+t.updatedAt);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Status      :'+C.reset+' '+(t.status||'').toUpperCase());
  console.log(dc+C.bold+'  └'+'─'.repeat(56)+'┘'+C.reset);
  console.log('');
}

function printClosedCard(t) {
  const pnl = (t && t.pnl != null) ? t.pnl : 0;
  const dc  = pnl >= 0 ? C.green : C.red;
  const pfx = pnl >= 0 ? '✔ PROFIT' : '✖ LOSS';
  console.log('');
  console.log(dc+C.bold+'  ┌─── TRADE CLOSED ──────────────────────────────────────┐'+C.reset);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'ID          :'+C.reset+' '+t.id);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Symbol      :'+C.reset+' '+t.symbol+' '+(t.direction||'').toUpperCase());
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Position ID :'+C.reset+' '+(t.positionId||'—'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Entry       :'+C.reset+' '+(t.entry||'N/A'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Close Price :'+C.reset+' '+(t.closePrice||'N/A'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'SL / TP     :'+C.reset+' '+(t.sl!=null?t.sl:'—')+' / '+(t.tp!=null?t.tp:'—'));
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Lot         :'+C.reset+' '+t.lot);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'PnL         :'+C.reset+' '+dc+C.bold+pnl.toFixed(2)+' USD  '+pfx+C.reset);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Opened      :'+C.reset+' '+t.openTimeEAT);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Closed      :'+C.reset+' '+t.closeTimeEAT);
  console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'Reason      :'+C.reset+' '+t.closeReason);
  if (t.aiSummary && t.aiSummary[0] !== '(') {
    const lines = t.aiSummary.match(/.{1,60}/g) || [];
    lines.forEach(function(l,i){
      if (i===0) console.log(dc+C.bold+'  │'+C.reset+' '+C.bold+'AI Notes    :'+C.reset+' '+C.dim+l+C.reset);
      else       console.log(dc+C.bold+'  │'+C.reset+'               '+C.dim+l+C.reset);
    });
  }
  console.log(dc+C.bold+'  └──────────────────────────────────────────────────────┘'+C.reset);
  console.log('');
}

// ─── CLI STATUS ───────────────────────────────────────────────────────────────
async function printStatus(fetchAccount) {
  logger.section('BOT STATUS');
  const open = dbGetOpenTrade();
  const db   = dbRead();

  console.log('  '+C.bold+'Bot Enabled  :'+C.reset+' '+(CONFIG.BOT_ENABLED ? C.green+'YES'+C.reset : C.red+'NO (signals ignored)'+C.reset));
  console.log('  '+C.bold+'Default Lot  :'+C.reset+' '+CONFIG.LOT_SIZE);
  console.log('  '+C.bold+'Port         :'+C.reset+' '+CONFIG.PORT);
  console.log('  '+C.bold+'Time (EAT)   :'+C.reset+' '+eatString());
  console.log('  '+C.bold+'MetaAPI      :'+C.reset+' '+(CONFIG.META_API_TOKEN ? C.green+'token set'+C.reset : C.red+'NOT SET'+C.reset));
  console.log('  '+C.bold+'Account ID   :'+C.reset+' '+(CONFIG.META_ACCOUNT_ID||C.red+'NOT SET'+C.reset));
  console.log('  '+C.bold+'Groq AI      :'+C.reset+' '+(CONFIG.GROQ_API_KEY ? C.green+'configured'+C.reset : C.yellow+'not set (optional)'+C.reset));

  if (fetchAccount && CONFIG.META_API_TOKEN && CONFIG.META_ACCOUNT_ID) {
    logger.section('METATRADER LIVE ACCOUNT');
    try {
      const acc = await metaGetAccount();
      if (acc && !acc.error) {
        console.log('  '+C.bold+'Name         :'+C.reset+' '+(acc.name||'—'));
        console.log('  '+C.bold+'Login        :'+C.reset+' '+(acc.login||'—'));
        console.log('  '+C.bold+'Broker/Server:'+C.reset+' '+(acc.server||'—'));
        console.log('  '+C.bold+'Balance      :'+C.reset+' '+C.green+(acc.balance!=null?acc.balance:'—')+' '+(acc.currency||'')+C.reset);
        console.log('  '+C.bold+'Equity       :'+C.reset+' '+(acc.equity!=null?acc.equity:'—')+' '+(acc.currency||''));
        console.log('  '+C.bold+'Free Margin  :'+C.reset+' '+(acc.freeMargin!=null?acc.freeMargin:'—'));
        console.log('  '+C.bold+'Leverage     :'+C.reset+' 1:'+(acc.leverage||'—'));
        console.log('  '+C.bold+'Platform     :'+C.reset+' '+(acc.platform||'—'));
        console.log('  '+C.bold+'Type         :'+C.reset+' '+(acc.type||'—'));
      } else {
        console.log('  '+C.red+'Could not fetch account info: '+(acc && acc.message ? acc.message : 'error')+C.reset);
      }
    } catch(e) {
      console.log('  '+C.red+'Account fetch error: '+e.message+C.reset);
    }
  }

  logger.section('STATISTICS');
  const totalPnl = db.stats.totalPnl || 0;
  const pc       = totalPnl >= 0 ? C.green : C.red;
  console.log('  '+C.bold+'Total Trades :'+C.reset+' '+db.stats.total);
  console.log('  '+C.bold+'Wins         :'+C.reset+' '+C.green+db.stats.wins+C.reset);
  console.log('  '+C.bold+'Losses       :'+C.reset+' '+C.red+db.stats.losses+C.reset);
  console.log('  '+C.bold+'Total PnL    :'+C.reset+' '+pc+C.bold+totalPnl.toFixed(2)+' USD'+C.reset);

  if (open) printTradeCard(open, 'CURRENT OPEN TRADE');
  else console.log('\n  '+C.dim+'No open trade.'+C.reset+'\n');
}

// ─── CLI HISTORY ─────────────────────────────────────────────────────────────
function printHistory(n) {
  n = n || 10;
  logger.section('TRADE HISTORY (last '+n+')');
  const db     = dbRead();
  const trades = db.trades.slice().reverse().slice(0, n);

  if (!trades.length) { console.log('  '+C.dim+'No trades recorded yet.'+C.reset+'\n'); return; }

  console.log('');
  trades.forEach(function(t, i) {
    const dc     = t.direction === 'buy' ? C.green : C.red;
    // FIX: safely handle null pnl (open trades)
    const hasPnl = t.pnl !== null && t.pnl !== undefined;
    const pnlStr = hasPnl ? (t.pnl >= 0 ? '+' : '')+t.pnl.toFixed(2)+' USD' : '  open  ';
    const sc     = t.status === 'open' ? C.cyan : (hasPnl && t.pnl >= 0 ? C.green : C.red);
    const badge  = t.status === 'open' ? C.cyan+'[OPEN]'+C.reset : sc+'[CLOSED]'+C.reset;

    console.log('  '+C.dim+String(i+1).padStart(2)+'.'+C.reset+' '+C.bold+t.openTimeEAT+C.reset+'  '+dc+C.bold+(t.direction||'').padEnd(4)+C.reset+'  '+C.bold+(t.symbol||'').padEnd(10)+C.reset);
    console.log('      Entry:'+(t.entry||'?')+'  SL:'+(t.sl!=null?t.sl:'—')+'  TP:'+(t.tp!=null?t.tp:'—')+'  Lot:'+t.lot+'  '+sc+C.bold+pnlStr+C.reset+'  '+badge);
    console.log('      PosID:'+(t.positionId||'—')+'  ID:'+t.id);
    if (t.closeTimeEAT) console.log('      Closed:'+t.closeTimeEAT+'  Reason:'+(t.closeReason||'—'));
    if (t.aiSummary && t.aiSummary[0] !== '(')
      console.log('      '+C.dim+'AI: '+t.aiSummary.slice(0,120)+(t.aiSummary.length>120?'...':'')+C.reset);
    console.log('');
  });
}

// ─── CLI SYNC ────────────────────────────────────────────────────────────────
async function cliSync() {
  logger.section('SYNC FROM METATRADER');
  const open = dbGetOpenTrade();
  if (!open) { logger.warn('No open trade in DB to sync.'); return; }
  try {
    const positions = await metaGetPositions();
    const pos = positions.find(function(p){ return p.id===open.positionId; });
    if (!pos) {
      logger.warn('Position '+open.positionId+' not found on MT — may be closed externally.');
      logger.warn('Use "close" to mark it closed in DB.');
      return;
    }
    const updated = Object.assign({}, open, {
      sl:        pos.stopLoss   != null ? pos.stopLoss   : open.sl,
      tp:        pos.takeProfit != null ? pos.takeProfit : open.tp,
      entry:     pos.openPrice  || open.entry,
      pnl:       pos.profit     != null ? pos.profit     : open.pnl,
      updatedAt: eatString(),
    });
    dbSaveTrade(updated);
    logger.success('Synced from MT successfully.');
    printTradeCard(updated, 'SYNCED TRADE');
  } catch(e) { logger.error('Sync failed: '+e.message); }
}

// ─── WEBHOOK SERVER ───────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise(function(resolve, reject) {
    let body = '';
    req.on('data', function(c){ body += c; if (body.length > 1e6) reject(new Error('Too large')); });
    req.on('end', function(){ try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}

function createServer() {
  const handler = async function(req, res) {
    let u;
    try { u = new URL(req.url, 'http://'+req.headers.host); }
    catch(e) { u = new URL('http://localhost/'); }
    res.setHeader('Content-Type','application/json');

    if (req.method === 'GET' && u.pathname === '/') {
      const open = dbGetOpenTrade();
      res.writeHead(200);
      return res.end(JSON.stringify({
        status:'running', botEnabled:CONFIG.BOT_ENABLED, time:eatString(),
        openTrade: open ? open.direction.toUpperCase()+' '+open.symbol+' posId:'+open.positionId : 'none',
      }));
    }

    if (req.method === 'POST' && u.pathname === '/webhook') {
      let payload;
      try { payload = await parseBody(req); }
      catch(e) { res.writeHead(400); return res.end(JSON.stringify({ok:false,msg:'Bad body'})); }

      logger.section('WEBHOOK HIT');
      logger.info('Payload: '+C.dim+JSON.stringify(payload)+C.reset);

      if (CONFIG.WEBHOOK_SECRET) {
        const secret = payload.secret || req.headers['x-secret'];
        if (secret !== CONFIG.WEBHOOK_SECRET) {
          logger.warn('Invalid webhook secret!');
          res.writeHead(403);
          return res.end(JSON.stringify({ok:false,msg:'Forbidden'}));
        }
      }
      const result = await handleSignal(payload);
      res.writeHead(result.ok ? 200 : 400);
      return res.end(JSON.stringify(result));
    }

    if (req.method === 'GET' && u.pathname === '/stats') {
      const db = dbRead();
      res.writeHead(200);
      return res.end(JSON.stringify(Object.assign({}, db.stats, { openTrade:dbGetOpenTrade() })));
    }

    res.writeHead(404);
    res.end(JSON.stringify({ok:false,msg:'Not found'}));
  };

  const server = http.createServer(handler);
  server.on('error', function(err) {
    if (err.code === 'EACCES') logger.error('Port '+CONFIG.PORT+' needs root. Use: sudo pm2 start bot.js');
    else logger.error('Server error: '+err.message);
    process.exit(1);
  });
  return server;
}

// ─── CLI PROMPT ───────────────────────────────────────────────────────────────
function startCLIPrompt() {
  const rl = readline.createInterface({ input:process.stdin, output:process.stdout, prompt:C.cyan+C.bold+'bot> '+C.reset });
  console.log('\n  '+C.dim+'Type '+C.reset+C.bold+'help'+C.reset+C.dim+' for commands.'+C.reset+'\n');
  rl.prompt();

  rl.on('line', async function(line) {
    const parts = line.trim().split(/\s+/);
    const cmd   = (parts[0]||'').toLowerCase();
    switch(cmd) {
      case 'status': case 's':  await printStatus(false); break;
      case 'account': case 'acc': await printStatus(true); break;
      case 'history': case 'h': printHistory(parseInt(parts[1])||10); break;
      case 'sync':    await cliSync(); break;
      case 'close':   await closeCurrent('CLI manual close'); break;
      case 'enable':  CONFIG.BOT_ENABLED=true;  logger.success('Bot ENABLED.'); break;
      case 'disable': CONFIG.BOT_ENABLED=false; logger.warn('Bot DISABLED — signals ignored.'); break;
      case 'test-buy':
        await handleSignal({ action:'buy',  symbol:parts[1]||'EURUSD', sl:parts[2], tp:parts[3], lot:CONFIG.LOT_SIZE });
        break;
      case 'test-sell':
        await handleSignal({ action:'sell', symbol:parts[1]||'EURUSD', sl:parts[2], tp:parts[3], lot:CONFIG.LOT_SIZE });
        break;
      case 'update': await updateCurrent(parts[1]||null, parts[2]||null); break;
      case 'config':
        logger.section('CONFIGURATION');
        console.log('  META_API_TOKEN  : '+(CONFIG.META_API_TOKEN  ? C.green+'set ('+CONFIG.META_API_TOKEN.slice(0,8)+'...)'+C.reset : C.red+'NOT SET'+C.reset));
        console.log('  META_ACCOUNT_ID : '+(CONFIG.META_ACCOUNT_ID || C.red+'NOT SET'+C.reset));
        console.log('  GROQ_API_KEY    : '+(CONFIG.GROQ_API_KEY    ? C.green+'set'+C.reset : C.yellow+'not set'+C.reset));
        console.log('  LOT_SIZE        : '+CONFIG.LOT_SIZE);
        console.log('  PORT            : '+CONFIG.PORT);
        console.log('  BOT_ENABLED     : '+(CONFIG.BOT_ENABLED ? C.green+'true'+C.reset : C.red+'false'+C.reset));
        console.log('  WEBHOOK_SECRET  : '+(CONFIG.WEBHOOK_SECRET ? C.green+'set'+C.reset : 'none (open)'));
        console.log('  DB_PATH         : '+CONFIG.DB_PATH);
        console.log('  LOG_PATH        : '+CONFIG.LOG_PATH);
        break;
      case 'db':
        logger.section('RAW DATABASE');
        console.log(JSON.stringify(dbRead(), null, 2));
        break;
      case 'help': case '?':
        console.log('\n'+C.cyan+C.bold+'  Commands:'+C.reset);
        console.log('  '+C.bold+'status'+C.reset+'  (s)                 Show open trade + stats');
        console.log('  '+C.bold+'account'+C.reset+' (acc)               Live MT account: balance, equity, margin');
        console.log('  '+C.bold+'history'+C.reset+' (h) [n]             Last n trades with AI notes (default 10)');
        console.log('  '+C.bold+'sync'+C.reset+'                        Sync SL/TP/PnL from MetaTrader');
        console.log('  '+C.bold+'close'+C.reset+'                       Manually close open trade');
        console.log('  '+C.bold+'update'+C.reset+' [sl] [tp]            Update SL/TP on open trade');
        console.log('  '+C.bold+'enable'+C.reset+' / '+C.bold+'disable'+C.reset+'             Toggle bot on/off live');
        console.log('  '+C.bold+'config'+C.reset+'                      Show .env config');
        console.log('  '+C.bold+'db'+C.reset+'                          Dump raw trades.json');
        console.log('  '+C.bold+'test-buy'+C.reset+'  [sym] [sl] [tp]   Simulate BUY signal');
        console.log('  '+C.bold+'test-sell'+C.reset+' [sym] [sl] [tp]   Simulate SELL signal');
        console.log('  '+C.bold+'exit'+C.reset+' / '+C.bold+'quit'+C.reset+'                Shutdown\n');
        break;
      case 'exit': case 'quit': logger.info('Shutting down.'); process.exit(0); break;
      case '': break;
      default: logger.warn('Unknown command: "'+cmd+'" — type '+C.bold+'help'+C.reset);
    }
    rl.prompt();
  });
  rl.on('close', function(){ process.exit(0); });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  banner('  TRADINGVIEW → METATRADER CLI BOT  ', C.cyan);
  console.log('  '+C.dim+'EAT (UTC+3)  |  JSON Storage  |  Zero Dependencies'+C.reset+'\n');

  if (!CONFIG.META_API_TOKEN)  logger.warn('META_API_TOKEN not set in .env');
  if (!CONFIG.META_ACCOUNT_ID) logger.warn('META_ACCOUNT_ID not set in .env');
  if (!CONFIG.GROQ_API_KEY)    logger.warn('GROQ_API_KEY not set — AI summaries disabled');

  await printStatus(false);

  const server = createServer();
  server.listen(CONFIG.PORT, function() {
    logger.success('Webhook server on port '+C.bold+CONFIG.PORT+C.reset);
    logger.info('Webhook URL : '+C.cyan+'http://54.204.233.214/webhook'+C.reset);
    logger.info('Health check: '+C.cyan+'http://54.204.233.214/'+C.reset);
    logger.info('Log file    : '+C.dim+CONFIG.LOG_PATH+C.reset);
  });

  startCLIPrompt();
}

main().catch(function(e){ console.error(C.red+'Fatal: '+e.message+C.reset); process.exit(1); });
