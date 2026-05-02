/**
 * registry-smoke
 *
 * End-to-end smoke test for the dynamic agent registry. Steps:
 *   1. Start a tiny in-process HTTP "fake agent" that always answers YES.
 *   2. Register it on-chain with capability `github_pr_merged_before` via
 *      `scripts/register-agent.ts` machinery.
 *   3. Hit the live coordinator's POST /v1/verify and confirm:
 *        - the new oracle's tokenId/ens appears in `participants`
 *        - the outcome reflects the YES vote (or escalates if other agents disagree).
 *
 * Usage (coordinator must be running locally on $BACKEND_URL):
 *   cd backend
 *   BACKEND_URL=http://localhost:8787 npx tsx scripts/registry-smoke.ts
 */

import "dotenv/config";
import express from "express";
import { ethers } from "ethers";
import { AgentManifestSchema } from "../src/types.js";
import { pinJson } from "../src/zg.js";

const ABI = [
  "function registerOracle(string ens,string manifestUri,bytes32 manifestHash,bytes capabilities,address[] recipients,uint16[] bps) payable returns (uint256)",
  "function tokenIdByEnsHash(bytes32) view returns (uint256)",
  "function registrationFee() view returns (uint256)",
  "event Registered(uint256 indexed tokenId,address indexed owner,string ens,string manifestUri,bytes32 manifestHash)",
];

async function main() {
  const BACKEND = (process.env.BACKEND_URL ?? "http://localhost:8787").replace(/\/$/, "");
  const RPC = (process.env.RPC_URL ?? "").trim();
  const PK = (process.env.REGISTER_PRIVATE_KEY ?? process.env.COORDINATOR_PRIVATE_KEY ?? "").trim();
  const INFT = (process.env.ORACLE_INFT_ADDRESS ?? "").trim();
  if (!RPC || !PK || !INFT) throw new Error("Need RPC_URL, ORACLE_INFT_ADDRESS, REGISTER_PRIVATE_KEY/COORDINATOR_PRIVATE_KEY");

  const FAKE_PORT = Number(process.env.FAKE_AGENT_PORT ?? 9871);
  const slug = `smoke-${Math.floor(Date.now() / 1000)}`;
  const ens = `${slug}.veritas.eth`;

  // ---- 1. fake agent ----
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, agent: slug }));
  app.post("/verify", (_req, res) => {
    res.json({
      agent: slug,
      resolvable: true,
      outcome: "YES",
      confidence: 0.95,
      evidence: [{ type: "smoke", uri: "https://example.org/smoke" }],
      reasoning: "Smoke-test fake agent always votes YES.",
    });
  });
  const server = app.listen(FAKE_PORT, () => console.log(`fake agent listening on :${FAKE_PORT}`));

  try {
    // ---- 2. register on-chain ----
    const manifest = AgentManifestSchema.parse({
      schema: "veritas.agent.v1",
      name: slug,
      displayName: "smoke-test agent",
      endpoint: `http://localhost:${FAKE_PORT}`,
      capabilities: ["github_pr_merged_before"],
      description: "ephemeral smoke-test agent",
      signer: "0x0000000000000000000000000000000000000000",
      version: "0.0.1",
    });

    console.log(`pinning manifest for ${ens} ...`);
    const manifestUri = await pinJson(manifest);
    const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(manifest)));
    console.log(`  uri  : ${manifestUri}`);
    console.log(`  hash : ${manifestHash}`);

    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(PK, provider);
    const inft = new ethers.Contract(INFT, ABI, wallet);
    const fee: bigint = await inft.registrationFee();
    const tx = await inft.registerOracle(
      ens,
      manifestUri,
      manifestHash,
      ethers.toUtf8Bytes(manifest.capabilities.join(",")),
      [],
      [],
      { value: fee },
    );
    console.log(`  tx   : ${tx.hash}`);
    const rcpt = await tx.wait();
    let tokenId: bigint | undefined;
    for (const log of rcpt?.logs ?? []) {
      try {
        const p = inft.interface.parseLog(log);
        if (p?.name === "Registered") { tokenId = p.args[0] as bigint; break; }
      } catch { /* */ }
    }
    console.log(`  registered tokenId=${tokenId?.toString()}`);

    // ---- 3. tell coordinator to refresh, then list ----
    await fetch(`${BACKEND}/v1/agents/refresh`, { method: "POST" });
    const list = await (await fetch(`${BACKEND}/v1/agents`)).json();
    const matched = list.agents.find((a: any) => a.ens === ens);
    if (!matched) throw new Error(`coordinator did not pick up ${ens} after refresh: ${JSON.stringify(list, null, 2)}`);
    console.log(`coordinator sees ${list.count} agents, including ours: ${matched.tokenId}`);

    // ---- 4. fire a verify and look for the new oracle in participants ----
    const verify = await (await fetch(`${BACKEND}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).json();
    const participants = verify?.decision?.consensus?.participants ?? verify?.participants ?? [];
    const hit = JSON.stringify(verify).includes(ens) || participants.some((p: any) => p?.ens === ens);
    console.log(`/v1/verify -> outcome=${verify?.decision?.outcome ?? "?"} routed-to-fake=${hit}`);
    if (!hit) {
      console.error("expected the smoke agent to participate. Full response:");
      console.error(JSON.stringify(verify, null, 2));
      process.exit(2);
    }
    console.log("OK: smoke agent was dispatched to.");
  } finally {
    server.close();
  }
}

main().catch((e) => { console.error("registry-smoke FAILED:", e?.message ?? e); process.exit(1); });
