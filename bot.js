#!/usr/bin/env node
/**
 * SUI AUTO-SELL — Aftermath Router (ultra-fast)
 * ---------------------------------------------
 * - Deteksi BUY via 0x2::coin::TransferEvent<COIN> + checkpoint walker cepat.
 * - TX panas (prebuild) adaptif: submit ~<2s setelah trigger (tergantung RPC).
 * - ON/OFF per token; saat ON diminta Sell% dan disimpan ke tokens.json.
 *
 * ENV:
 *   PRIVATE_KEY=0x...              # ed25519 hex (64/32 bytes OK)
 *   HTTP_URL=https://fullnode.mainnet.sui.io:443
 *
 * Install:
 *   npm i aftermath-ts-sdk@1.3.17 --legacy-peer-deps @mysten/sui inquirer dotenv
 */

import 'dotenv/config';
import inquirer from 'inquirer';
import { performance } from 'node:perf_hooks';
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHEX } from '@mysten/sui/utils';

const SUI = '0x2::sui::SUI';
const HTTP_URL = process.env.HTTP_URL || 'https://fullnode.mainnet.sui.io:443';
const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').trim();
if (!PRIVATE_KEY) { console.error('❌ PRIVATE_KEY belum diisi di .env'); process.exit(1); }

const client = new SuiClient({ url: HTTP_URL });
function keypairFromEnv(pk) {
  const hex = pk.startsWith('0x') ? pk.slice(2) : pk;
  const bytes = fromHEX(hex);
  const sk = bytes.length === 64 ? bytes.slice(32) : bytes;
  return Ed25519Keypair.fromSecretKey(sk);
}
const keypair = keypairFromEnv(PRIVATE_KEY);
const OWNER = keypair.getPublicKey().toSuiAddress();

// ---------- IO ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const TOKENS_PATH = join(__dirname, 'tokens.json');
const LOG_PATH    = join(__dirname, 'activity.log');

async function readJsonSafe(p, d){ try{ return JSON.parse(await readFile(p,'utf8')); }catch{ return d; } }
async function writeJson(p,v){ await writeFile(p, JSON.stringify(v,null,2)); }
async function logActivity(line){
  const ts = new Date().toISOString();
  const row = `[${ts}] ${line}\n`;
  try{
    await appendFile(LOG_PATH, row).catch(async()=>{ await mkdir(dirname(LOG_PATH),{recursive:true}); await appendFile(LOG_PATH,row); });
  }catch{}
}

// ---------- utils ----------
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const toBig = (v)=> { try{ return typeof v==='bigint'? v : BigInt(v??0); }catch{ return 0n; } };
const toNum = (v,d=0)=> Number.isFinite(Number(v)) ? Number(v) : d;
const now = ()=> Date.now();
function isCoinType(s){ return /^0x[0-9a-fA-F]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/.test(s||''); }
async function getBalanceRaw(owner, coinType){ const r = await client.getBalance({ owner, coinType }); return BigInt(r.totalBalance||'0'); }
async function getSuiBalanceStr(){ const raw = await getBalanceRaw(OWNER,SUI); const s=raw.toString().padStart(10,'0'); const i=s.slice(0,-9)||'0', f=s.slice(-9).replace(/0+$/,''); return f?`${i}.${f}`:i; }

// ---------- tokens store (persist) ----------
function normalizeCfg(raw={}){
  return {
    sellPercent: Math.min(100, Math.max(1, toNum(raw.sellPercent, 100))),
    minSellRaw:  toBig(raw.minSellRaw ?? 0),
    cooldownMs:  Math.max(200, toNum(raw.cooldownMs, 900)),
    slippageBps: Math.max(1, toNum(raw.slippageBps, 200)),  // 2%
    running:     !!raw.running,
    lastSellMs:  toNum(raw.lastSellMs, 0),
  };
}
async function loadTokens(){
  const data = await readJsonSafe(TOKENS_PATH, {});
  const map = new Map();
  if (Array.isArray(data)) {
    for (const it of data) if (it?.coinType && isCoinType(it.coinType)) map.set(it.coinType, normalizeCfg(it));
  } else if (data && typeof data==='object') {
    for (const [k,v] of Object.entries(data)) if (isCoinType(k)) map.set(k, normalizeCfg(v));
  }
  return map;
}
let TOKENS = await loadTokens();
async function saveTokens(){
  const obj = {};
  for (const [k,vRaw] of TOKENS){
    const v = normalizeCfg(vRaw);
    obj[k] = { sellPercent:v.sellPercent, minSellRaw:v.minSellRaw.toString(), cooldownMs:v.cooldownMs, slippageBps:v.slippageBps, running:v.running, lastSellMs:v.lastSellMs };
  }
  await writeJson(TOKENS_PATH, obj);
}

// ---------- Aftermath dynamic import ----------
let AF = null, ROUTER = null;
async function ensureAftermath(){
  if (ROUTER) return ROUTER;
  const mod = await import('aftermath-ts-sdk'); // v1.3.17
  AF = mod.Aftermath;
  ROUTER = new AF('MAINNET').Router();
  return ROUTER;
}

// ---------- HOT TX (prebuild) ----------
/**
 * HOT.get(coinType) -> { bytes, amountIn, slippageBps, ts }
 */
const HOT = new Map();
const HOT_TTL_MS = 6000;
const MIN_CHANGE_BPS = 50;      // 0.5%
const PREP_MIN_MS = 600, PREP_MAX_MS = 5000;

const PREP_STATE = new Map();   // coinType -> { intervalMs, lastAmountIn, stop }
async function prepareHotTx(coinType, cfgRaw){
  const cfg = normalizeCfg(cfgRaw);
  try{
    const bal = await getBalanceRaw(OWNER, coinType);
    const amountIn = (bal * BigInt(cfg.sellPercent)) / 100n;
    if (amountIn <= 0n || amountIn < cfg.minSellRaw) { HOT.set(coinType,null); return { skipped:true }; }

    const st = PREP_STATE.get(coinType) || { lastAmountIn:0n, intervalMs:1000 };
    const last = HOT.get(coinType);
    const delta = st.lastAmountIn? (amountIn>st.lastAmountIn? amountIn-st.lastAmountIn : st.lastAmountIn-amountIn) : 0n;
    const deltaBps = st.lastAmountIn? Number((delta*10000n)/st.lastAmountIn) : 10000;
    const valid = last && (Date.now()-last.ts) <= HOT_TTL_MS;
    if (valid && deltaBps < MIN_CHANGE_BPS) return { skipped:true };

    const router = await ensureAftermath();
    const route = await router.getCompleteTradeRouteGivenAmountIn({ coinInType: coinType, coinOutType: SUI, coinInAmount: amountIn });
    if (!route || !route.routes?.length){ HOT.set(coinType,null); return { skipped:true }; }

    const tx = await router.getTransactionForCompleteTradeRoute({
      walletAddress: OWNER,
      completeRoute: route,
      slippage: Math.max(1, Number(cfg.slippageBps))/10_000, // bps -> decimal
    });
    const bytes = await tx.build({ client });
    HOT.set(coinType, { bytes, amountIn, slippageBps: cfg.slippageBps, ts: Date.now() });
    PREP_STATE.set(coinType, { ...st, lastAmountIn: amountIn });
    return { ok:true };
  }catch(e){
    const m = String(e?.message||e);
    if (m.includes('429')) return { rateLimited:true };
    return { skipped:true };
  }
}
async function startPrebuilder(coinType){
  if (PREP_STATE.has(coinType)) return;
  let alive = true;
  PREP_STATE.set(coinType, { intervalMs: 1000, lastAmountIn: 0n, stop:()=>{ alive=false; } });
  (async()=>{
    while(alive){
      const cfg = TOKENS.get(coinType) || {};
      const st  = PREP_STATE.get(coinType) || { intervalMs: 1000, lastAmountIn:0n };
      const r = await prepareHotTx(coinType, cfg);
      let next = st.intervalMs;
      if (r?.rateLimited) next = Math.min(PREP_MAX_MS, Math.round(st.intervalMs*1.8)+(Math.random()*200|0));
      else if (r?.ok)    next = Math.max(PREP_MIN_MS, Math.round(st.intervalMs*0.85));
      else               next = Math.max(PREP_MIN_MS, Math.round(st.intervalMs*0.95));
      PREP_STATE.set(coinType, { ...(PREP_STATE.get(coinType)||{}), intervalMs: next });
      await sleep(next);
    }
  })();
}
async function stopPrebuilder(coinType){
  const st = PREP_STATE.get(coinType);
  if (st?.stop){ try{ st.stop(); }catch{} }
  PREP_STATE.delete(coinType);
  HOT.delete(coinType);
}

// ---------- submit (pakai HOT; retry 429) ----------
async function submitHotOrCold(coinType){
  const cfg = normalizeCfg(TOKENS.get(coinType) || {});
  const cached = HOT.get(coinType);
  const t0 = performance.now();

  async function submitBytes(bytes){
    // Paling cepat: requestType 'Submit' + no effects.
    for(let i=0;i<3;i++){
      try{
        const res = await client.signAndExecuteTransaction({
          signer: keypair,
          transaction: bytes,
          options: { showEffects: false },
          requestType: 'Submit',
        });
        return res;
      }catch(e){
        const m = String(e?.message||e);
        if (!m.includes('429')) throw e;
        await sleep(180 + i*140);
      }
    }
    // Fallback (lebih lambat, tapi lebih stabil)
    return await client.signAndExecuteTransaction({
      signer: keypair, transaction: bytes,
      options: { showEffects: true }, requestType: 'WaitForLocalExecution',
    });
  }

  try{
    if (cached && (Date.now()-cached.ts) <= HOT_TTL_MS){
      const res = await submitBytes(cached.bytes);
      const ms = (performance.now()-t0).toFixed(0);
      console.log(`[SELL SUBMITTED/HOT] ${coinType} amountRaw=${cached.amountIn} digest=${res?.digest||'(submitted)'} (~${ms}ms)`);
      await logActivity(`[SELL SUBMITTED/HOT] ${coinType} raw=${cached.amountIn} dig=${res?.digest||'(submitted)'} ~${ms}ms`);
      return;
    }

    // Cold path (kalau tidak ada HOT)
    const bal = await getBalanceRaw(OWNER, coinType);
    const amountIn = (bal * BigInt(cfg.sellPercent)) / 100n;
    if (amountIn <= 0n || amountIn < cfg.minSellRaw) { console.log(`[SKIP] ${coinType}: saldo 0 / < minSellRaw`); return; }

    const router = await ensureAftermath();
    const route = await router.getCompleteTradeRouteGivenAmountIn({ coinInType:coinType, coinOutType:SUI, coinInAmount:amountIn });
    if (!route || !route.routes?.length){ console.log(`[FAIL] ${coinType}: No route`); return; }

    const tx = await router.getTransactionForCompleteTradeRoute({
      walletAddress: OWNER, completeRoute: route,
      slippage: Math.max(1, Number(cfg.slippageBps))/10_000,
    });
    const bytes = await tx.build({ client });
    const res = await submitBytes(bytes);
    const ms = (performance.now()-t0).toFixed(0);
    console.log(`[SELL SUBMITTED/COLD] ${coinType} amountRaw=${amountIn} digest=${res?.digest||'(submitted)'} (~${ms}ms)`);
    await logActivity(`[SELL SUBMITTED/COLD] ${coinType} raw=${amountIn} dig=${res?.digest||'(submitted)'} ~${ms}ms`);
  }catch(e){
    const m = e?.message || String(e);
    console.log(`[SELL FAIL] ${coinType}: ${m}`);
    await logActivity(`[SELL FAIL] ${coinType}: ${m}`);
  }
}

// ---------- detector (event + checkpoint) ----------
const RUNNERS = new Map();             // coinType -> stop()
const POLL_MS = 80;                    // target ~80ms

function transferEventType(ct){ return `0x2::coin::TransferEvent<${ct}>`; }

async function detectLoop(coinType){
  let cursor = null, nextCp = null;
  let seenEv = new Set(), seenTx = new Set();

  while (RUNNERS.has(coinType)) {
    let triggered = false;

    // 1) Event spesifik TransferEvent<coinType>
    try{
      const resp = await client.queryEvents({
        query: { MoveEventType: transferEventType(coinType) },
        cursor: cursor??null, limit: 40, order: 'descending',
      });
      const evs = resp?.data || [];
      if (evs.length) cursor = evs[0].id;

      for (const ev of evs){
        if (seenEv.has(ev.id)) continue; seenEv.add(ev.id);
        if (seenEv.size>1200) seenEv = new Set([...seenEv].slice(-400));

        const pj = ev.parsedJson || {};
        const to = String(pj.to || pj.recipient || '').toLowerCase();
        const amt = toBig(pj.amount ?? pj.value ?? 0);
        const mine = OWNER.toLowerCase();
        if (amt>0n && to && to!==mine) {
          const cfg = normalizeCfg(TOKENS.get(coinType) || {});
          if (Date.now() - (cfg.lastSellMs||0) >= cfg.cooldownMs) {
            TOKENS.set(coinType,{...cfg,lastSellMs:Date.now(),running:true}); await saveTokens();
            submitHotOrCold(coinType).catch(()=>{});
            triggered = true; break;
          }
        }
      }
    }catch{}

    // 2) Checkpoint walker (ambil 3 cp)
    if (!triggered){
      try{
        const latest = Number(await client.getLatestCheckpointSequenceNumber());
        if (nextCp==null) nextCp = Math.max(0, latest-2);
        let steps = 0;
        while(steps<3 && nextCp<=latest){
          const cp = await client.getCheckpoint({ id:String(nextCp) }); nextCp++; steps++;
          const digs = cp?.transactions || [];
          if (!digs.length) continue;
          const txs = await client.multiGetTransactionBlocks({ digests:digs, options:{ showBalanceChanges:true, showEvents:false } });
          for (const tx of (txs||[])){
            if (!tx?.digest || seenTx.has(tx.digest)) continue; seenTx.add(tx.digest);
            if (seenTx.size>2000) seenTx = new Set([...seenTx].slice(-700));
            for (const bc of (tx.balanceChanges||[])){
              if (bc?.coinType!==coinType) continue;
              const recv = (bc?.owner?.AddressOwner || '').toLowerCase();
              const amt  = toBig(bc.amount||'0');
              if (amt>0n && recv && recv!==OWNER.toLowerCase()){
                const cfg = normalizeCfg(TOKENS.get(coinType)||{});
                if (Date.now()-(cfg.lastSellMs||0) >= cfg.cooldownMs){
                  TOKENS.set(coinType,{...cfg,lastSellMs:Date.now(),running:true}); await saveTokens();
                  submitHotOrCold(coinType).catch(()=>{});
                  triggered = true; break;
                }
              }
            }
            if (triggered) break;
          }
          if (triggered) break;
        }
      }catch{}
    }

    await sleep(POLL_MS);
  }
}

// ---------- ON/OFF ----------
async function startAutoSell(coinType){
  if (RUNNERS.has(coinType)) return;
  await startPrebuilder(coinType);
  RUNNERS.set(coinType, { stop: async()=>{ RUNNERS.delete(coinType); await stopPrebuilder(coinType); } });
  const cfg = normalizeCfg(TOKENS.get(coinType)||{});
  TOKENS.set(coinType,{...cfg,running:true}); await saveTokens();
  // fire & forget
  detectLoop(coinType).catch(async e=>{ await logActivity(`[DETECT ERROR] ${coinType}: ${e?.message||e}`); });
  console.log(`▶️  Auto-sell ON untuk ${coinType} (events ~${POLL_MS}ms, TX panas adaptif)…`);
}
async function stopAutoSell(coinType){
  const r = RUNNERS.get(coinType); if (r){ try{ await r.stop(); }catch{} }
  RUNNERS.delete(coinType); await stopPrebuilder(coinType);
  const cfg = normalizeCfg(TOKENS.get(coinType)||{});
  TOKENS.set(coinType,{...cfg,running:false}); await saveTokens();
  console.log(`⏸️  Auto-sell OFF untuk ${coinType}`);
}

// ---------- MENU ----------
async function promptAddOrEdit(existing){
  const base = normalizeCfg(existing||{});
  const ans = await inquirer.prompt([
    { name:'coinType', message:'Coin type (0x..::mod::SYMBOL)', when: !existing, validate:v=>isCoinType(v)||'Format salah' },
    { name:'sellPercent', message:'Sell %', default: base.sellPercent, filter:Number },
    { name:'minSellRaw', message:'Min sell (raw units)', default: base.minSellRaw.toString(), filter:v=>BigInt(v) },
    { name:'cooldownMs', message:'Cooldown antar SELL (ms)', default: base.cooldownMs, filter:Number },
    { name:'slippageBps', message:'Slippage (bps)', default: base.slippageBps, filter:Number },
  ]);
  return ans;
}
function renderTable(){
  const rows=[];
  for (const [k,vr] of TOKENS){
    const v = normalizeCfg(vr);
    rows.push({ coinType:k, sellPct:v.sellPercent, minRaw:v.minSellRaw.toString(), cooldownMs:v.cooldownMs, slippageBps:v.slippageBps, running:!!v.running, lastSell:v.lastSellMs? new Date(v.lastSellMs).toLocaleTimeString():'-'});
  }
  console.table(rows);
}
async function viewActivityLog(){
  const buf = await readFile(LOG_PATH,'utf8').catch(()=> '');
  const lines = buf? buf.trim().split('\n'): [];
  console.log('\n===== ACTIVITY LOG (last 200) =====');
  console.log(lines.slice(-200).join('\n') || '(log kosong)');
  console.log('===================================\n');
  await inquirer.prompt([{ type:'input', name:'ok', message:'Enter untuk kembali' }]);
}
async function autoStartSaved(){
  // normalisasi + auto-ON yg tersimpan
  const fixed = new Map();
  for (const [k,v] of TOKENS) fixed.set(k, normalizeCfg(v));
  TOKENS = fixed; await saveTokens();
  for (const [k,v] of TOKENS) if (v.running) startAutoSell(k);
}

async function menu(){
  await autoStartSaved();
  while(true){
    const suiBal = await getSuiBalanceStr();
    console.log(`\nRPC: ${HTTP_URL}`);
    console.log(`Owner: ${OWNER}`);
    console.log(`SUI Balance: ${suiBal}`);

    const { action } = await inquirer.prompt({
      type:'list', name:'action', message:'Pilih menu', pageSize:12, choices:[
        { name:'➕ Tambah token', value:'add' },
        { name:'✏️  Ubah token', value:'edit' },
        { name:'🚀 Test SELL sekali (submit sekarang)', value:'oneshot' },
        { name:'⚡ Auto-sell ON/OFF (pilih & tentukan %)', value:'toggle' },
        { name:'📋 Lihat status token', value:'list' },
        { name:'📜 Lihat activity.log (last 200)', value:'log' },
        { name:'Keluar', value:'exit' },
      ]
    });

    if (action==='add'){
      const a = await promptAddOrEdit();
      if (TOKENS.has(a.coinType)) console.log('Token sudah ada. Pakai menu Ubah.');
      else { TOKENS.set(a.coinType,{...normalizeCfg(a), running:false, lastSellMs:0}); await saveTokens(); console.log(`[ADD] ${a.coinType}`); }
    }

    if (action==='edit'){
      if (!TOKENS.size){ console.log('Belum ada token.'); continue; }
      const {key} = await inquirer.prompt({ type:'list', name:'key', message:'Pilih token', choices:[...TOKENS.keys()] });
      const cur = TOKENS.get(key);
      const upd = await promptAddOrEdit(cur);
      TOKENS.set(key, { ...normalizeCfg(cur), ...normalizeCfg(upd) }); await saveTokens(); console.log(`[EDIT] ${key}`);
    }

    if (action==='oneshot'){
      if (!TOKENS.size){ console.log('Belum ada token.'); continue; }
      const {key} = await inquirer.prompt({ type:'list', name:'key', message:'Pilih token', choices:[...TOKENS.keys()] });
      console.log(`[SUBMIT SELL] ${key}…`);
      await submitHotOrCold(key);
    }

    if (action==='toggle'){
      if (!TOKENS.size){ console.log('Belum ada token.'); continue; }
      const {key} = await inquirer.prompt({ type:'list', name:'key', message:'Pilih token', choices:[...TOKENS.keys()] });
      const cur = normalizeCfg(TOKENS.get(key)||{});
      if (!cur.running){
        const { pct } = await inquirer.prompt([{ name:'pct', message:'Sell % saat Auto-sell', default: cur.sellPercent, filter:Number }]);
        const newCfg = { ...cur, sellPercent: Math.min(100, Math.max(1, Number(pct)||cur.sellPercent)) };
        TOKENS.set(key, newCfg); await saveTokens();
        await startAutoSell(key);
      } else {
        await stopAutoSell(key);
      }
    }

    if (action==='list') renderTable();
    if (action==='log') await viewActivityLog();
    if (action==='exit'){ console.log('Bye'); process.exit(0); }
  }
}

// ---------- safety ----------
process.on('unhandledRejection', async(e)=>{ await logActivity(`[WARN] UnhandledRejection: ${e?.message||e}`); });
process.on('uncaughtException', async(e)=>{ await logActivity(`[WARN] UncaughtException: ${e?.message||e}`); });

// ---------- run ----------
menu().catch(async(e)=>{ console.error('Fatal:', e?.message||e); await logActivity(`[FATAL] ${e?.message||String(e)}`); process.exit(1); });
