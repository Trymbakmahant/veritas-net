/**
 * register-agent
 *
 * Permissionlessly registers a new oracle iNFT for an HTTP agent.
 *
 *   1. Reads an AgentManifest JSON from `--manifest <path>`.
 *   2. Validates against the on-chain `AgentManifestSchema`.
 *   3. Pins the manifest to 0G Storage (`pinJson` -> `0g://<root>`).
 *   4. Calls `OracleINFT.registerOracle(...)` from the configured signer.
 *
 * Required env (loaded from backend/.env via dotenv):
 *   - RPC_URL
 *   - ORACLE_INFT_ADDRESS
 *   - REGISTER_PRIVATE_KEY  (or COORDINATOR_PRIVATE_KEY as fallback)
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/register-agent.ts --manifest ./examples/my-agent.manifest.json
 */

import * as dotenv from "dotenv";
dotenv.config({ override: true }); // .env wins over stale shell-exported vars
import { ethers } from "ethers";
import * as fs from "node:fs/promises";
import { AgentManifestSchema } from "../src/types.js";
import { pinJson, zgMode } from "../src/zg.js";

const ABI = [
  "function registerOracle(string ens,string manifestUri,bytes32 manifestHash,bytes capabilities,address[] recipients,uint16[] bps) payable returns (uint256)",
  "function tokenIdByEnsHash(bytes32) view returns (uint256)",
  "function registrationFee() view returns (uint256)",
  "event Registered(uint256 indexed tokenId,address indexed owner,string ens,string manifestUri,bytes32 manifestHash)",
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const manifestPath = arg("manifest");
  if (!manifestPath) throw new Error("Missing --manifest <path>");

  const RPC = (process.env.RPC_URL ?? "").trim();
  const PK = (process.env.REGISTER_PRIVATE_KEY ?? process.env.COORDINATOR_PRIVATE_KEY ?? "").trim();
  const INFT = (process.env.ORACLE_INFT_ADDRESS ?? "").trim();
  if (!RPC || !PK || !INFT) {
    throw new Error("Set RPC_URL, ORACLE_INFT_ADDRESS, and REGISTER_PRIVATE_KEY (or COORDINATOR_PRIVATE_KEY)");
  }

  const raw = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  const manifest = AgentManifestSchema.parse(raw);

  const ens = `${manifest.name}.veritas.eth`;
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  const inft = new ethers.Contract(INFT, ABI, wallet);

  const ensHash = ethers.keccak256(ethers.toUtf8Bytes(ens));
  const existing: bigint = await inft.tokenIdByEnsHash(ensHash);
  if (existing !== 0n) throw new Error(`ENS already taken: ${ens} (tokenId=${existing})`);

  console.log(`Pinning manifest to 0G (mode=${zgMode}) ...`);
  const manifestUri = await pinJson(manifest);
  // Hash the JSON as it will be served (sorted keys would be even better; for now JSON.stringify).
  const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(manifest)));
  console.log(`  manifest URI : ${manifestUri}`);
  console.log(`  manifest hash: ${manifestHash}`);

  const capabilitiesPacked = ethers.toUtf8Bytes(manifest.capabilities.join(","));
  const fee: bigint = await inft.registrationFee();

  console.log(`Calling registerOracle(${ens}) (fee=${fee} wei) ...`);
  const tx = await inft.registerOracle(
    ens,
    manifestUri,
    manifestHash,
    capabilitiesPacked,
    [],
    [],
    { value: fee },
  );
  console.log(`  tx hash: ${tx.hash}`);
  const rcpt = await tx.wait();
  let tokenId: bigint | undefined;
  for (const log of rcpt?.logs ?? []) {
    try {
      const parsed = inft.interface.parseLog(log);
      if (parsed?.name === "Registered") {
        tokenId = parsed.args[0] as bigint;
        break;
      }
    } catch { /* not our event */ }
  }
  console.log(`Registered tokenId=${tokenId?.toString() ?? "?"} ens=${ens}`);
  console.log(`Tip: refresh coordinator registry now: curl -X POST $BACKEND/v1/agents/refresh`);
}

main().catch((e) => {
  console.error("register-agent FAILED:", e?.message ?? e);
  process.exit(1);
});
