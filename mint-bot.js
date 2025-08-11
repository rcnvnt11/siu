require("dotenv").config();
const { ethers } = require("ethers");

const toBN = (x) => ethers.BigNumber.from(x.toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODE = (process.env.MODE || "single").toLowerCase();
const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const MINT_FUNC = (process.env.MINT_FUNC || "mint").trim();
const MINT_AMOUNT = toBN(process.env.MINT_AMOUNT || 1);
const PRICE_WEI = ethers.utils.parseEther(String(process.env.MINT_PRICE || "0"));
const GAS_LIMIT = process.env.GAS_LIMIT ? toBN(process.env.GAS_LIMIT) : undefined;

// Retry config
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 5);
const RETRY_BACKOFF_MS = Number(process.env.RETRY_BACKOFF_MS || 2000);
const RETRY_BACKOFF_MULTIPLIER = Number(process.env.RETRY_BACKOFF_MULTIPLIER || 1.6);
const GAS_BUMP_PERCENT = Number(process.env.GAS_BUMP_PERCENT || 15);

// EIP-1559 (opsional)
const MAX_FEE_GWEI = process.env.MAX_FEE_GWEI;
const MAX_PRIORITY_GWEI = process.env.MAX_PRIORITY_GWEI;

function buildAbi() {
  const abiStr = process.env.ABI_OVERRIDE?.trim();
  if (abiStr) { try { return JSON.parse(abiStr); } catch {} }
  return [`function ${MINT_FUNC}(uint256 _count) payable`];
}

function baseOverrides(amountBN, fee) {
  const o = { value: PRICE_WEI.mul(amountBN) };
  if (GAS_LIMIT) o.gasLimit = GAS_LIMIT;

  if (fee && ("maxFeePerGas" in fee || "gasPrice" in fee)) {
    Object.assign(o, fee);
  }
  return o;
}

function bumpLegacyGas(gasPrice) {
  // +X% per retry
  return gasPrice.mul(100 + GAS_BUMP_PERCENT).div(100);
}

function bumpEip1559(fees) {
  const next = { ...fees };
  next.maxFeePerGas = next.maxFeePerGas.mul(100 + GAS_BUMP_PERCENT).div(100);
  next.maxPriorityFeePerGas = next.maxPriorityFeePerGas.mul(100 + GAS_BUMP_PERCENT).div(100);
  return next;
}

async function getStartingFees(provider) {
  // Jika user override, gunakan itu
  if (MAX_FEE_GWEI && MAX_PRIORITY_GWEI) {
    return {
      type: "eip1559",
      maxFeePerGas: ethers.utils.parseUnits(MAX_FEE_GWEI, "gwei"),
      maxPriorityFeePerGas: ethers.utils.parseUnits(MAX_PRIORITY_GWEI, "gwei"),
    };
  }
  if (process.env.GAS_PRICE_GWEI) {
    return {
      type: "legacy",
      gasPrice: ethers.utils.parseUnits(process.env.GAS_PRICE_GWEI, "gwei"),
    };
  }

  // Auto: pakai EIP-1559 dari network
  const fee = await provider.getFeeData();
  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
    return { type: "eip1559", maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas };
  }
  // Fallback legacy
  return { type: "legacy", gasPrice: fee.gasPrice || ethers.utils.parseUnits("20", "gwei") };
}

async function sendWithRetry(sendTx, provider) {
  let attempt = 0;
  let waitMs = RETRY_BACKOFF_MS;
  let fees = await getStartingFees(provider);

  while (true) {
    try {
      const tx = await sendTx(fees);
      console.log(`Tx sent: ${tx.hash} (attempt ${attempt + 1})`);
      const rc = await tx.wait();
      console.log(`✅ Success: ${rc.transactionHash} Block: ${rc.blockNumber}`);
      return rc;
    } catch (err) {
      attempt++;
      const msg = (err && err.message) ? err.message : String(err);
      console.warn(`❌ Attempt ${attempt} failed: ${msg}`);

      if (attempt >= RETRY_ATTEMPTS) throw err;

      // Bump gas
      if (fees.type === "legacy") {
        fees = { type: "legacy", gasPrice: bumpLegacyGas(fees.gasPrice) };
      } else {
        fees = bumpEip1559(fees);
        fees.type = "eip1559";
      }

      console.log(`⏳ Retrying in ${waitMs}ms with higher gas...`);
      await sleep(waitMs);
      waitMs = Math.ceil(waitMs * RETRY_BACKOFF_MULTIPLIER);
    }
  }
}

async function mintOnce(wallet, contract, provider) {
  return sendWithRetry(
    async (fees) => {
      const feeFields =
        fees.type === "legacy"
          ? { gasPrice: fees.gasPrice }
          : { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };

      return contract[MINT_FUNC](MINT_AMOUNT, baseOverrides(MINT_AMOUNT, feeFields));
    },
    provider
  );
}

async function runSimple(provider) {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const abi = ["function mint(uint256 _count) public payable"];
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);
  await mintOnce(wallet, contract, provider);
}

async function runAdvanced(provider) {
  const abi = buildAbi();

  if (MODE === "single") {
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);
    await mintOnce(wallet, contract, provider);
  } else if (MODE === "multi") {
    const keys = (process.env.PRIVATE_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
    const delay = Number(process.env.TX_DELAY_MS || 2000);
    for (const pk of keys) {
      try {
        const w = new ethers.Wallet(pk, provider);
        const c = new ethers.Contract(CONTRACT_ADDRESS, abi, w);
        await mintOnce(w, c, provider);
      } catch (e) {
        console.error("❌ Wallet error:", e.message || e);
      }
      if (delay > 0) await sleep(delay);
    }
  } else {
    throw new Error(`MODE tidak dikenal: ${MODE}`);
  }
}

async function main() {
  if (!RPC_URL) throw new Error("RPC_URL kosong");
  if (!CONTRACT_ADDRESS) throw new Error("CONTRACT_ADDRESS kosong");

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

  if (MODE === "simple") {
    await runSimple(provider);
  } else {
    await runAdvanced(provider);
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message || e);
  process.exit(1);
});
