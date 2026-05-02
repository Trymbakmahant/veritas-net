/**
 * deploy-example-market
 *
 * Deploys the example `PredictionMarket` contract pointed at the existing
 * VeritasOracle, optionally creates a market, and (when `--bet` is set) places
 * tiny YES/NO bets so judges can see a full prediction-market lifecycle on
 * the testnet explorer.
 *
 * Usage:
 *   cd contract
 *   npx hardhat run --network zgGalileo scripts/deploy-example-market.ts
 *
 * Env (loaded from contract/.env, with same fallbacks as deploy.ts):
 *   - VERITAS_ORACLE_ADDRESS  (auto-read from deployments/<network>.json if unset)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ethers, network } from "hardhat";

function loadOracleAddress(): string {
  const fromEnv = process.env.VERITAS_ORACLE_ADDRESS;
  if (fromEnv && ethers.isAddress(fromEnv)) return fromEnv;
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployments file at ${file}; pass VERITAS_ORACLE_ADDRESS or run deploy.ts first.`);
  const json = JSON.parse(fs.readFileSync(file, "utf-8"));
  const addr = json?.contracts?.VeritasOracle;
  if (!addr || !ethers.isAddress(addr)) throw new Error(`Missing VeritasOracle in ${file}`);
  return addr;
}

async function main() {
  const oracleAddr = loadOracleAddress();
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying PredictionMarket on ${network.name} as ${deployer.address}`);
  console.log(`  VeritasOracle: ${oracleAddr}`);

  const Market = await ethers.getContractFactory("PredictionMarket");
  const market = await Market.deploy(oracleAddr);
  await market.waitForDeployment();
  const marketAddr = await market.getAddress();
  console.log(`  PredictionMarket: ${marketAddr}`);

  const wantMarket = process.env.CREATE_SAMPLE_MARKET !== "false";
  if (!wantMarket) {
    console.log("Skipping sample market (set CREATE_SAMPLE_MARKET=true to create).");
    return;
  }

  // ---- Create one sample market ------------------------------------------
  const closesIn = Number(process.env.CLOSES_IN_S ?? "60");
  const resolveIn = Number(process.env.RESOLVE_IN_S ?? "120");
  const now = Math.floor(Date.now() / 1000);
  const closesAt = BigInt(now + closesIn);
  const resolveBy = BigInt(now + resolveIn);

  const text = "Will PR octocat/Hello-World#1 be merged before deadline?";
  const spec = JSON.stringify({
    kind: "github_pr_merged_before",
    repo: "octocat/Hello-World",
    prNumber: 1,
    deadlineIso: new Date((now + resolveIn) * 1000).toISOString(),
  });

  console.log(`\nCreating sample market: "${text}"`);
  const tx = await market.createMarket(text, spec, closesAt, resolveBy);
  const rcpt = await tx.wait();
  let marketId: bigint | undefined;
  let claimId: bigint | undefined;
  for (const log of rcpt?.logs ?? []) {
    try {
      const p = market.interface.parseLog(log);
      if (p?.name === "MarketCreated") {
        marketId = p.args[0] as bigint;
        claimId = p.args[1] as bigint;
        break;
      }
    } catch { /* not our event */ }
  }
  console.log(`  marketId=${marketId?.toString()}  claimId=${claimId?.toString()}  tx=${tx.hash}`);

  // Optional: tiny bets so the demo has movement.
  if (process.env.PLACE_SAMPLE_BETS === "true" && marketId !== undefined) {
    const yesAmt = ethers.parseEther(process.env.YES_BET_ETH ?? "0.0001");
    const noAmt  = ethers.parseEther(process.env.NO_BET_ETH  ?? "0.0001");
    console.log(`Placing sample bets YES=${ethers.formatEther(yesAmt)} NO=${ethers.formatEther(noAmt)} ETH ...`);
    const t1 = await market.bet(marketId, 1, { value: yesAmt }); await t1.wait();
    const t2 = await market.bet(marketId, 0, { value: noAmt  }); await t2.wait();
    console.log(`  bets placed.`);
  }

  console.log("\nDone.");
  console.log("Watch the coordinator log for ConsumerNotified once the resolveBy time passes (AUTO_RESOLVE=true).");
  console.log(`Then call:  market.claimPayout(${marketId?.toString()})  for the winning side.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
