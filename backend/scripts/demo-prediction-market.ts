/**
 * demo-prediction-market
 *
 * End-to-end story for judges:
 *
 *   1. Deploy `PredictionMarket` (or reuse PREDICTION_MARKET_ADDRESS).
 *   2. Open a market that asks: "Will PR <X> be merged before <deadline>?"
 *      `createMarket` triggers `submitClaimWithConsumer` on VeritasOracle and
 *      registers the market itself as the consumer.
 *   3. Place tiny YES + NO bets (so payouts are non-trivial).
 *   4. Wait for the coordinator's AUTO_RESOLVE timer to fire after `resolveBy`,
 *      which calls `resolveClaim` AND fans the result back into the market via
 *      `onClaimResolved`.
 *   5. Print the explorer links + the GET /v1/claims/:id snapshot, and (if YES
 *      won) call `claimPayout` from the YES bettor.
 *
 * Required env (loaded from backend/.env):
 *   - RPC_URL
 *   - COORDINATOR_PRIVATE_KEY  (must be funded; resolves + bets from this key)
 *   - VERITAS_ORACLE_ADDRESS
 *
 * Optional env:
 *   - PREDICTION_MARKET_ADDRESS  reuse an existing market deployment.
 *   - BACKEND_URL                default http://localhost:8787
 *   - CLOSES_IN_S, RESOLVE_IN_S  default 30, 60.
 *   - YES_BET_ETH, NO_BET_ETH    default 0.0001, 0.0001.
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/demo-prediction-market.ts
 */

import * as dotenv from "dotenv";
dotenv.config({ override: true });

import * as fs from "node:fs";
import * as path from "node:path";
import { ethers } from "ethers";

const ORACLE_ABI = [
  "event ClaimSubmitted(uint256 indexed claimId, address indexed requester, uint64 resolveBy, string text, string spec)",
  "event ConsumerRegistered(uint256 indexed claimId, address indexed consumer)",
  "event ClaimResolved(uint256 indexed claimId, uint8 outcome, uint64 resolvedAt, string proofUri, uint256[] participants)",
  "event ConsumerNotified(uint256 indexed claimId, address indexed consumer, bool ok, bytes returnData)",
  "function claims(uint256) view returns (address requester,uint64 resolveBy,uint64 resolvedAt,uint8 outcome,string text,string spec,string proofUri,address consumer)",
];

// Minimal market ABI; we deploy via the Hardhat artifact so we always pick up the
// freshly compiled bytecode (and avoid a hard dep on hardhat at runtime).
const MARKET_ARTIFACT = path.resolve(
  __dirname,
  "..",
  "..",
  "contract",
  "artifacts",
  "contracts",
  "examples",
  "PredictionMarket.sol",
  "PredictionMarket.json",
);

const MARKET_ABI = [
  "constructor(address veritas)",
  "function nextMarketId() view returns (uint256)",
  "function markets(uint256) view returns (uint256 claimId,uint64 closesAt,uint64 resolveBy,uint8 status,uint8 outcome,string proofUri,uint256 stakeYes,uint256 stakeNo)",
  "function createMarket(string text,string spec,uint64 closesAt,uint64 resolveBy) returns (uint256)",
  "function bet(uint256 marketId,uint8 side) payable",
  "function claimPayout(uint256 marketId)",
  "function claimRefund(uint256 marketId)",
  "event MarketCreated(uint256 indexed marketId,uint256 indexed claimId,uint64 closesAt,uint64 resolveBy,string text)",
  "event MarketResolved(uint256 indexed marketId,uint8 outcome,string proofUri)",
  "event MarketVoided(uint256 indexed marketId,uint8 outcome)",
  "event Paid(uint256 indexed marketId,address indexed trader,uint256 amount)",
];

const STATUS_NAMES = ["Open", "Resolved", "Voided"] as const;
const OUTCOME_NAMES = ["NO", "YES", "INVALID", "ESCALATE"] as const;

function need(name: string, val: string | undefined): string {
  if (!val || !val.trim()) throw new Error(`Missing env ${name}`);
  return val.trim();
}

async function deployMarket(wallet: ethers.Wallet, oracleAddr: string): Promise<ethers.Contract> {
  if (!fs.existsSync(MARKET_ARTIFACT)) {
    throw new Error(`Missing artifact: ${MARKET_ARTIFACT}\nRun 'npm --workspace contract run build' first.`);
  }
  const artifact = JSON.parse(fs.readFileSync(MARKET_ARTIFACT, "utf-8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  console.log("Deploying PredictionMarket ...");
  const c = await factory.deploy(oracleAddr);
  await c.waitForDeployment();
  return new ethers.Contract(await c.getAddress(), MARKET_ABI, wallet);
}

async function main() {
  const RPC = need("RPC_URL", process.env.RPC_URL);
  const PK = need("COORDINATOR_PRIVATE_KEY", process.env.COORDINATOR_PRIVATE_KEY);
  const ORACLE = need("VERITAS_ORACLE_ADDRESS", process.env.VERITAS_ORACLE_ADDRESS);
  const BACKEND = (process.env.BACKEND_URL ?? "http://localhost:8787").replace(/\/$/, "");

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  const oracle = new ethers.Contract(ORACLE, ORACLE_ABI, provider);

  console.log(`network: ${(await provider.getNetwork()).chainId}`);
  console.log(`signer:  ${wallet.address}`);
  console.log(`oracle:  ${ORACLE}`);

  // ---- 1. PredictionMarket ----------------------------------------------
  let market: ethers.Contract;
  if (process.env.PREDICTION_MARKET_ADDRESS) {
    market = new ethers.Contract(process.env.PREDICTION_MARKET_ADDRESS.trim(), MARKET_ABI, wallet);
    console.log(`reusing market at ${await market.getAddress()}`);
  } else {
    market = await deployMarket(wallet, ORACLE);
    console.log(`market deployed at ${await market.getAddress()}`);
  }

  // ---- 2. Coordinator must be online ------------------------------------
  try {
    const r = await fetch(`${BACKEND}/health`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    throw new Error(`Coordinator not reachable at ${BACKEND}: ${(e as Error).message}. Start it with 'cd backend && npm run dev' and ensure AUTO_RESOLVE=true.`);
  }

  // ---- 3. Create a market ------------------------------------------------
  const closesIn = Number(process.env.CLOSES_IN_S ?? "30");
  const resolveIn = Number(process.env.RESOLVE_IN_S ?? "60");
  const now = Math.floor(Date.now() / 1000);
  const closesAt = BigInt(now + closesIn);
  const resolveBy = BigInt(now + resolveIn);

  const text = "DEMO: Will PR octocat/Hello-World#1 be merged before deadline?";
  const spec = JSON.stringify({
    kind: "github_pr_merged_before",
    repo: "octocat/Hello-World",
    prNumber: 1,
    deadlineIso: new Date((now + resolveIn) * 1000).toISOString(),
  });

  console.log(`\ncreating market (closes in ${closesIn}s, resolveBy +${resolveIn}s) ...`);
  const ctx = await market.createMarket(text, spec, closesAt, resolveBy);
  const crc = await ctx.wait();
  let marketId: bigint | undefined;
  let claimId: bigint | undefined;
  for (const log of crc?.logs ?? []) {
    try {
      const p = market.interface.parseLog(log);
      if (p?.name === "MarketCreated") {
        marketId = p.args[0] as bigint;
        claimId = p.args[1] as bigint;
        break;
      }
    } catch { /* ignore non-market logs */ }
  }
  if (marketId === undefined || claimId === undefined) throw new Error("MarketCreated log not found");
  console.log(`  marketId=${marketId} claimId=${claimId} tx=${ctx.hash}`);

  // ---- 4. Place tiny YES / NO bets --------------------------------------
  const yesAmt = ethers.parseEther(process.env.YES_BET_ETH ?? "0.0001");
  const noAmt  = ethers.parseEther(process.env.NO_BET_ETH  ?? "0.0001");
  console.log(`\nplacing YES=${ethers.formatEther(yesAmt)} ETH and NO=${ethers.formatEther(noAmt)} ETH ...`);
  await (await market.bet(marketId, 1, { value: yesAmt })).wait();
  await (await market.bet(marketId, 0, { value: noAmt  })).wait();
  console.log("  bets placed.");

  // ---- 5. Wait for the coordinator to auto-resolve ----------------------
  const waitMs = Math.max(0, Number(resolveBy) * 1000 - Date.now()) + 30_000;
  console.log(`\nwaiting up to ${(waitMs / 1000).toFixed(0)}s for coordinator AUTO_RESOLVE ...`);
  const resolved: { outcome: number; proofUri: string } = await new Promise((resolve) => {
    const off = (event: ethers.Listener) => oracle.off("ClaimResolved", event);
    const timer = setTimeout(() => {
      off(handler as unknown as ethers.Listener);
      resolve({ outcome: 2, proofUri: "(timeout — set AUTO_RESOLVE=true and verify the github agent is reachable)" });
    }, waitMs);
    const handler = (cid: bigint, outcome: bigint, _t: bigint, proofUri: string) => {
      if (cid === claimId) {
        clearTimeout(timer);
        off(handler as unknown as ethers.Listener);
        resolve({ outcome: Number(outcome), proofUri });
      }
    };
    oracle.on("ClaimResolved", handler);
  });

  console.log(`\nresolved: outcome=${OUTCOME_NAMES[resolved.outcome]} proofUri=${resolved.proofUri}`);

  // ---- 6. Show market state via backend & on-chain ----------------------
  try {
    const snap = await (await fetch(`${BACKEND}/v1/claims/${claimId.toString()}`)).json();
    console.log(`/v1/claims/${claimId} -> ${JSON.stringify(snap, null, 2)}`);
  } catch (e) {
    console.warn(`  (could not fetch /v1/claims/${claimId}: ${(e as Error).message})`);
  }

  const m = await market.markets(marketId);
  console.log(
    `\nmarket #${marketId}: status=${STATUS_NAMES[Number(m.status)]} outcome=${OUTCOME_NAMES[Number(m.outcome)]}`
    + ` stakeYes=${ethers.formatEther(m.stakeYes)} stakeNo=${ethers.formatEther(m.stakeNo)}`,
  );

  // ---- 7. Pay out / refund ----------------------------------------------
  if (Number(m.status) === 1) {
    console.log("claiming payout for the bettor ...");
    try {
      const tx = await market.claimPayout(marketId);
      const r = await tx.wait();
      console.log(`  paid in tx=${tx.hash} (gasUsed=${r?.gasUsed})`);
    } catch (e) {
      console.warn(`  payout failed: ${(e as Error).message}`);
    }
  } else if (Number(m.status) === 2) {
    console.log("market voided — claiming refund ...");
    try {
      const tx = await market.claimRefund(marketId);
      const r = await tx.wait();
      console.log(`  refunded in tx=${tx.hash} (gasUsed=${r?.gasUsed})`);
    } catch (e) {
      console.warn(`  refund failed: ${(e as Error).message}`);
    }
  } else {
    console.log("market still Open (resolution not received).");
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error("demo-prediction-market FAILED:", e?.message ?? e); process.exit(1); });
