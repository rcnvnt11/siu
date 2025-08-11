#!/usr/bin/env node
/**
 * SUI MEME COIN AUTO-SELLER (Multi-Token, Menu, Aggregator)
 * - Ready-to-run: RPC/HTTP default → Sui mainnet (resmi Mysten)
 * - Kamu cukup isi PRIVATE_KEY di .env, lalu tambah token target dari menu
 * - DEX: Cetus Aggregator (aggressgator ON), FlowX, BlueMove (via aggregator)
 */

import 'dotenv/config';
import inquirer from 'inquirer';
import { performance } from 'node:perf_hooks';
import { SuiClient, getFullnodeUrl, Transaction as TransactionBlock } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { fromHEX } from '@mysten/sui.js/utils';
import { decode as b64decode } from 'base64-arraybuffer';

// --- Aggregator SDKs (pakai sesuai menu DEX) ---
import { AggregatorClient as CetusAggClient } from '@cetusprotocol/aggregator-sdk';
import { AggregatorQuoter, NETWORK as FLOWX_NET, TradeBuilder } from '@flowx-finance/sdk';

// ---------- DEFAULT RPC (siap pakai) ----------
const DEFAULT_HTTP = getFullnodeUrl('mainnet');     // ex: https://fullnode.mainnet.sui.io:443

// ---------- ENV ----------
const HTTP_URL = process.env.HTTP_URL || DEFAULT_HTTP;
const OWNER_ENV = process.env.OWNER_ADDRESS || '';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY belum diisi di .env');
  process.exit(1);
}

const DEFAULTS = {
  sellPercent: Number(process.env.DEFAULT_SELL_PERCENT || 100),
  minSellRaw: BigInt(process.env.DEFAULT_MIN_SELL_RAW || '0'),
  cooldownMs: Number(process.env.DEFAULT_COOLDOWN_MS || 3000),
  slippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS || 100), // 1%
  quoteCoin: process.env.QUOTE_COIN || '0x2::sui::SUI', // Pair SUI/XXXX
  dexPref: (process.env.DEX_PREF || 'cetus_agg'),       // cetus_agg | flowx | bluemove
};

// ---------- SUI CLIENT ----------
const client = new SuiClient({ url: HTTP_URL });

function keypairFromEnv(pk) {
  if (pk.startsWith('0x')) return Ed25519Keypair.fromSeed(fromHEX(pk).slice(0, 32));
  const raw = new Uint8Array(b64decode(pk));
  return Ed25519Keypair.fromSeed(raw.slice(-32));
}
const keypair = keypairFromEnv(PRIVATE_KEY);
const OWNER = OWNER_ENV || keypair.toSuiAddress();

// ---------- STATE ----------
const tokenMap = new Map(); // coinType => { sellPercent, minSellRaw, cooldownMs, slippageBps, dex, running, lastSellMs, _unsub }

// ---------- UTIL ----------
async function getBalanceRaw(owner, coinType) {
  const r = await client.getBalance({ owner, coinType });
  return BigInt(r.totalBalance || '0');
}
const now = () => Date.now();
const msSince = (t) => now() - (t || 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- DEX ADAPTERS ----------
async function sellViaCetusAgg({ coinIn, amountIn, coinOut, slippageBps }) {
  const agg = new CetusAggClient({
    fullnodeUrl: HTTP_URL,
    networkType: 'mainnet',
  });

  const routers = await agg.findRouters({
    from: coinIn,
    target: coinOut,
    amount: String(amountIn),
    byAmountIn: true,
  });
  if (!routers?.length) throw new Error('No route from Cetus Aggregator');

  const txb = new TransactionBlock();
  await agg.fastRouterSwap({
    routers,
    txb,
    slippage: slippageBps / 1e4, // 100 bps => 0.01
  });

  const res = await client.signAndExecuteTransactionBlock({
    signer: keypair,
    transactionBlock: txb,
    options: { showEffects: true, showEvents: true },
    requestType: 'WaitForLocalExecution',
  });
  if (res?.effects?.status?.status !== 'success') throw new Error('CetusAgg tx failed');
  return res;
}

async function sellViaFlowX({ coinIn, amountIn, coinOut, slippageBps }) {
  const quoter = new AggregatorQuoter('mainnet');
  const routes = await quoter.getRoutes({
    tokenIn: coinIn,
    tokenOut: coinOut,
    amountIn: String(amountIn),
  });
  if (!routes?.length) throw new Error('No FlowX route');

  const builder = new TradeBuilder(FLOWX_NET.MAINNET, routes);
  const trade = builder
    .sender(OWNER)
    .amountIn(String(amountIn))
    .slippage(slippageBps * 1e4)      // FlowX expects 1e6 scale
    .deadline(Date.now() + 60 * 1000)
    .build();

  const txb = trade.swap({ client });
  const res = await client.signAndExecuteTransactionBlock({
    signer: keypair,
    transactionBlock: txb,
    options: { showEffects: true, showEvents: true },
    requestType: 'WaitForLocalExecution',
  });
  if (res?.effects?.status?.status !== 'success') throw new Error('FlowX tx failed');
  return res;
}

async function sellViaBlueMoveFallback(p) {
  // BlueMove fallback via Cetus Aggregator
  return sellViaCetusAgg(p);
}

async function sellOnce({ coinType, cfg }) {
  const bal = await getBalanceRaw(OWNER, coinType);
  if (bal <= 0n) return { skipped: 'no_balance' };

  let amount = (bal * BigInt(cfg.sellPercent)) / 100n;
  if (amount < cfg.minSellRaw) return { skipped: 'below_min' };

  const params = {
    coinIn: coinType,
    amountIn: amount,
    coinOut: DEFAULTS.quoteCoin,
    slippageBps: cfg.slippageBps ?? DEFAULTS.slippageBps,
  };

  if (cfg.dex === 'cetus_agg') return sellViaCetusAgg(params);
  if (cfg.dex === 'flowx')     return sellViaFlowX(params);
  if (cfg.dex === 'bluemove')  return sellViaBlueMoveFallback(params);
  throw new Error(`Unknown DEX: ${cfg.dex}`);
}

// ---------- BUY detector ----------
async function startListener(coinType) {
  const cfg = tokenMap.get(coinType);
  if (!cfg || cfg.running) return;
  cfg.running = true;
  cfg.lastSellMs = 0;

  const handler = async (evt) => {
    try {
      const t0 = performance.now();
      const etype = (evt.type || '').toLowerCase();
      if (!etype.includes('swap')) return;

      const blob = JSON.stringify(evt.parsedJson || evt.fields || evt);
      if (!blob.includes(coinType)) return;

      if (msSince(cfg.lastSellMs) < cfg.cooldownMs) return;

      const res = await sellOnce({ coinType, cfg });
      if (res?.effects?.status?.status === 'success') {
        cfg.lastSellMs = now();
        console.log(`[SELL OK] ${coinType} via ${cfg.dex} tx=${res.digest} in ${(performance.now()-t0).toFixed(0)}ms`);
      }
    } catch (e) {
      console.warn(`[SELL ERR] ${coinType}:`, e?.message || e);
    }
  };

  // subscribe broad; SDK akan handle WS sendiri dari HTTP_URL base
  const unsub = await client.subscribeEvent({ filter: { All: [] } }, handler);
  cfg._unsub = unsub;
  console.log(`[RUN] listening BUY for ${coinType} on ${cfg.dex}…`);
}

async function stopListener(coinType) {
  const cfg = tokenMap.get(coinType);
  if (!cfg?.running) return;
  cfg.running = false;
  if (cfg._unsub) {
    try { await cfg._unsub(); } catch {}
    cfg._unsub = null;
  }
  console.log(`[STOP] ${coinType}`);
}

// ---------- MENU ----------
async function promptAddOrEdit(existing) {
  const base = existing || {};
  const ans = await inquirer.prompt([
    { name: 'coinType', message: 'Full coin type (0x..::mod::SYMBOL)', default: base.coinType, when: !existing },
    { name: 'sellPercent', message: 'Sell %', default: base.sellPercent ?? DEFAULTS.sellPercent, filter: Number },
    { name: 'minSellRaw', message: 'Min sell (raw units)', default: base.minSellRaw ?? DEFAULTS.minSellRaw.toString(), filter: v => BigInt(v) },
    { name: 'cooldownMs', message: 'Cooldown (ms)', default: base.cooldownMs ?? DEFAULTS.cooldownMs, filter: Number },
    {
      type: 'list', name: 'dex', message: 'DEX',
      choices: [
        { name: 'Cetus Aggregator (recommended)', value: 'cetus_agg' },
        { name: 'FlowX', value: 'flowx' },
        { name: 'BlueMove (via Aggregator)', value: 'bluemove' },
      ],
      default: base.dex ?? DEFAULTS.dexPref,
    },
    { name: 'slippageBps', message: 'Slippage (bps, 100=1%)', default: base.slippageBps ?? DEFAULTS.slippageBps, filter: Number },
  ]);
  return ans;
}

function renderTable() {
  const rows = [];
  for (const [k, v] of tokenMap) {
    rows.push({
      coinType: k,
      sellPct: v.sellPercent,
      minRaw: v.minSellRaw.toString(),
      cooldownMs: v.cooldownMs,
      slippageBps: v.slippageBps,
      dex: v.dex,
      running: !!v.running,
      lastSell: v.lastSellMs ? new Date(v.lastSellMs).toLocaleTimeString() : '-',
    });
  }
  console.table(rows);
}

async function menu() {
  console.log('RPC:', HTTP_URL);
  console.log('Owner:', OWNER);

  while (true) {
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: 'Pilih menu',
      choices: [
        { name: '➕ Tambah token target', value: 'add' },
        { name: '✏️  Ubah token target', value: 'edit' },
        { name: '🗑️  Hapus token', value: 'remove' },
        { name: '▶️  Start semua token', value: 'start_all' },
        { name: '⏸️  Stop token tertentu', value: 'stop_one' },
        { name: '📋 Lihat status token', value: 'list' },
        { name: '🚀 Test SELL sekali (token tertentu)', value: 'oneshot' },
        { name: 'Keluar', value: 'exit' },
      ],
    });

    if (action === 'add') {
      const ans = await promptAddOrEdit();
      if (tokenMap.has(ans.coinType)) {
        console.log('Token sudah ada. Gunakan menu Ubah.');
      } else {
        tokenMap.set(ans.coinType, { ...ans, running: false, lastSellMs: 0 });
        console.log(`[ADD] ${ans.coinType}`);
      }
    }

    if (action === 'edit') {
      if (tokenMap.size === 0) { console.log('Belum ada token.'); continue; }
      const { key } = await inquirer.prompt({ type: 'list', name: 'key', message: 'Pilih token', choices: [...tokenMap.keys()] });
      const cur = tokenMap.get(key);
      const upd = await promptAddOrEdit(cur);
      tokenMap.set(key, { ...cur, ...upd });
      console.log(`[EDIT] ${key}`);
    }

    if (action === 'remove') {
      if (tokenMap.size === 0) { console.log('Belum ada token.'); continue; }
      const { key } = await inquirer.prompt({ type: 'list', name: 'key', message: 'Pilih token', choices: [...tokenMap.keys()] });
      await stopListener(key);
      tokenMap.delete(key);
      console.log(`[DEL] ${key}`);
    }

    if (action === 'start_all') {
      if (tokenMap.size === 0) { console.log('Belum ada token.'); continue; }
      for (const key of tokenMap.keys()) startListener(key);
      console.log('Bot berjalan di background (listener tetap running).');
    }

    if (action === 'stop_one') {
      if (tokenMap.size === 0) { console.log('Belum ada token.'); continue; }
      const { key } = await inquirer.prompt({ type: 'list', name: 'key', message: 'Pilih token', choices: [...tokenMap.keys()] });
      await stopListener(key);
    }

    if (action === 'list') {
      renderTable();
    }

    if (action === 'oneshot') {
      if (tokenMap.size === 0) { console.log('Belum ada token.'); continue; }
      const { key } = await inquirer.prompt({ type: 'list', name: 'key', message: 'Pilih token', choices: [...tokenMap.keys()] });
      const cfg = tokenMap.get(key);
      console.log(`[TEST SELL] ${key}…`);
      try {
        const res = await sellOnce({ coinType: key, cfg });
        if (res?.effects?.status?.status === 'success') console.log(`[OK] ${key} tx=${res.digest}`);
        else if (res?.skipped) console.log(`[SKIP] ${key}: ${res.skipped}`);
        else console.log(`[WARN] ${key}: unknown result`);
      } catch (e) {
        console.log(`[ERR] ${key}:`, e?.message || e);
      }
    }

    if (action === 'exit') {
      console.log('Bye');
      process.exit(0);
    }
  }
}

menu().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
