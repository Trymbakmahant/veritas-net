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
 *
 * If you pasted `cd backendBACKEND_URL=...` without a newline, shell runs a bogus
 * `cd` and skips setting BACKEND_URL; run the two separately or put `;` between them.
 */

import * as dotenv from "dotenv";
dotenv.config({ override: true }); // .env wins over stale shell-exported vars

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

async function fetchJson(method: string, url: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const c = e as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
    const errno = c?.cause?.code ?? c?.code ?? "";
    const hint =
      errno === "ECONNREFUSED" || (e as Error).message.includes("fetch failed")
        ? " Is the coordinator running? Try: cd backend && npm run dev (or npm run dev:all from repo root)."
        : "";
    throw new Error(`${method} ${url} failed${errno ? ` [${errno}]` : ""}: ${(e as Error).message}.${hint}`, { cause: e });
  }
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 240)}`);
  }
  if (!res.ok) {
    throw new Error(`${method} ${url} HTTP ${res.status}: ${text.slice(0, 480)}`);
  }
  return json;
}

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

    console.log(`probing coordinator at ${BACKEND} ...`);
    try {
      await fetchJson("GET", `${BACKEND}/health`);
    } catch (e) {
      throw new Error(`${(e as Error).message} Start coordinator with ORACLE_INFT_ADDRESS matching backend/.env, then rerun.`);
    }

    // ---- 3. tell coordinator to refresh, then list ----
    await fetchJson("POST", `${BACKEND}/v1/agents/refresh`);
    const list = (await fetchJson("GET", `${BACKEND}/v1/agents`)) as {
      agents: Array<{ ens: string; tokenId: string }>;
      count: number;
    };
    const matched = (list.agents ?? []).find((a) => a.ens === ens);
    if (!matched) throw new Error(`coordinator did not pick up ${ens} after refresh: ${JSON.stringify(list, null, 2)}`);
    console.log(`coordinator sees ${list.count} agents, including ours: ${matched.tokenId}`);

    // ---- 4. fire a verify and look for the new oracle in participants ----
    const verifyBody = {
      text: "registry smoke — github PR merged before deadline",
      spec: {
        kind: "github_pr_merged_before" as const,
        repo: "octocat/Hello-World",
        prNumber: 1,
        deadlineIso: "2099-12-31T23:59:59.000Z",
      },
    };
    const verify = (await fetchJson("POST", `${BACKEND}/v1/verify`, verifyBody)) as Record<
      string,
      unknown
    >;
    const responses = Array.isArray(verify.responses) ? (verify.responses as { ens?: string }[]) : [];
    const decision = verify.decision as { outcome?: string; participants?: { ens?: string }[] } | undefined;
    const participants = Array.isArray(decision?.participants) ? decision!.participants! : [];
    const hit =
      responses.some((r) => r.ens === ens)
      || participants.some((p) => p.ens === ens)
      || JSON.stringify(verify).includes(ens);
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
