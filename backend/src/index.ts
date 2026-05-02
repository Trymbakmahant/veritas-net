import "dotenv/config";
import express from "express";
import { ethers } from "ethers";
import {
  AgentRequest,
  AgentRequestSchema,
  AgentResponse,
  ClaimSpecSchema,
  CriticVerdict,
  Outcome,
  OracleIdentity,
  outcomeToEnum,
} from "./types.js";
import {
  callAuditorAgent,
  callGithubAgent,
  callSnapshotAgent,
} from "./agents.js";
import { decide, votePayloadFromResponse } from "./coordinator.js";
import { axl, axlMode, Channels } from "./axl.js";
import { identityFor, reputationOf, setupINFT } from "./inft.js";
import { buildAndPinProof, signVote } from "./proof.js";
import {
  appendLog,
  putKv,
  pinJson,
  ZgKeys,
  ZgStreams,
  zgKvReal,
  zgMode,
} from "./zg.js";
import { zgComputeMode } from "./zgCompute.js";

// ---------- env / wiring -----------------------------------------------------

const PORT = Number(process.env.PORT ?? "8787");
const RPC_URL = process.env.RPC_URL ?? "";
const PRIVATE_KEY = process.env.COORDINATOR_PRIVATE_KEY ?? "";
const ORACLE_ADDRESS = process.env.VERITAS_ORACLE_ADDRESS ?? "";
const INFT_ADDRESS = process.env.ORACLE_INFT_ADDRESS ?? "";

const GITHUB_AGENT_URL = process.env.GITHUB_AGENT_URL ?? "http://localhost:8801";
const SNAPSHOT_AGENT_URL = process.env.SNAPSHOT_AGENT_URL ?? "http://localhost:8802";
const AUDITOR_AGENT_URL = process.env.AUDITOR_AGENT_URL ?? "http://localhost:8803";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

const RESOLVABILITY_THRESHOLD = Number(process.env.RESOLVABILITY_THRESHOLD ?? "0.5");
const AGREEMENT_THRESHOLD     = Number(process.env.AGREEMENT_THRESHOLD ?? "0.67");

// Auto-resolve a claim once submitted+resolveBy reached (for demo).
const AUTO_RESOLVE = (process.env.AUTO_RESOLVE ?? "true") !== "false";

const ABI = [
  "event ClaimSubmitted(uint256 indexed claimId, address indexed requester, uint64 resolveBy, string text, string spec)",
  "event ClaimResolved(uint256 indexed claimId, uint8 outcome, uint64 resolvedAt, string proofUri, uint256[] participants)",
  "function resolveClaim(uint256 claimId, uint8 outcome, string proofUri, uint256[] participants, bool[] agreed) external",
  "function claims(uint256) view returns (address requester,uint64 resolveBy,uint64 resolvedAt,uint8 outcome,string text,string spec,string proofUri)",
  "function nextClaimId() view returns (uint256)",
  "function submitClaim(string text, string spec, uint64 resolveBy) external returns (uint256)",
];

function requireEnv(name: string, value: string) {
  if (!value) throw new Error(`Missing env ${name}`);
}

function parseSpec(specRaw: string) {
  try {
    return ClaimSpecSchema.parse(JSON.parse(specRaw));
  } catch (e) {
    throw new Error(`Invalid spec JSON: ${(e as Error).message}`);
  }
}

// ---------- agent dispatch (HTTP today, AXL-ready surface) -------------------
//
// Each "agent" returns an AgentResponse. The coordinator wraps it in a SignedVote
// and (if AXL is on) re-publishes on `veritas/vote/<claimId>` so any peer/dashboard
// can subscribe. In mock AXL mode this is a single-process pub/sub bus; in real
// AXL mode it becomes a P2P broadcast.

type AgentName = "github" | "snapshot";

async function callAgent(name: AgentName, req: AgentRequest): Promise<AgentResponse> {
  if (name === "github") return callGithubAgent(GITHUB_AGENT_URL, req, GITHUB_TOKEN || undefined);
  return callSnapshotAgent(SNAPSHOT_AGENT_URL, req);
}

function pickAgentSet(spec: AgentRequest["spec"]): AgentName[] {
  // Each spec.kind has a primary agent. We call it twice plus the auditor as a critic.
  // Replace this with a real swarm-selection policy later (e.g. iNFT capability filter).
  if (spec.kind === "github_pr_merged_before") return ["github", "github"];
  return ["snapshot", "snapshot"];
}

async function runSwarm(req: AgentRequest, claimId: bigint, signer: ethers.Signer) {
  const agentSet = pickAgentSet(req.spec);

  // Publish dispatch on AXL (informational; in mock mode there are no remote subs).
  await axl.publish(Channels.claimDispatch, { claimId: claimId.toString(), request: req });

  const responses: Array<AgentResponse & { identity: OracleIdentity; reputation?: number }> = [];

  // Fetch identities + reputations in parallel.
  const identities = await Promise.all(agentSet.map((n, i) => identityFor(`${n}#${i}` ).then(async (id) => {
    const baseId = await identityFor(n);
    // Use the canonical (unsuffixed) identity; the suffix is just to keep the loop unique.
    const rep = await reputationOf(baseId.tokenId);
    return { name: n, identity: baseId, reputation: rep };
  })));

  await Promise.all(
    identities.map(async ({ name, identity, reputation }) => {
      try {
        const resp = await callAgent(name, req);
        responses.push({ ...resp, identity, reputation });
        const vote = await signVote({
          signer,
          tokenId: identity.tokenId,
          claimId,
          outcome: resp.outcome,
          resolvable: resp.resolvable,
          confidence: resp.confidence,
          reasoning: resp.reasoning,
          evidence: resp.evidence,
          zgReceipt: resp.zgReceipt,
        });
        await axl.publish(Channels.vote(claimId), {
          ...vote,
          tokenId: vote.tokenId.toString(),
          claimId: vote.claimId.toString(),
        });
        await appendLog(ZgStreams.claimAgentResponses(claimId.toString()), {
          ens: identity.ens,
          tokenId: identity.tokenId.toString(),
          ...resp,
        });
      } catch (e) {
        // Agent down or refused. Synthesize an INVALID response so consensus continues.
        const reasoning = `Agent call failed: ${(e as Error).message}`;
        responses.push({
          agent: name,
          resolvable: false,
          outcome: "INVALID" as Outcome,
          confidence: 0.2,
          evidence: [],
          reasoning,
          identity,
          reputation,
        });
      }
    }),
  );

  return responses;
}

async function runCritic(args: {
  request: AgentRequest;
  tentative: Outcome;
  responses: AgentResponse[];
}): Promise<CriticVerdict | undefined> {
  try {
    const out = await callAuditorAgent(AUDITOR_AGENT_URL, {
      request: args.request,
      tentative: args.tentative,
      responses: args.responses,
    });
    return { verdict: out.verdict, reasoning: out.reasoning, zgReceipt: out.zgReceipt };
  } catch (e) {
    // Auditor offline -> skip critic step gracefully.
    return undefined;
  }
}

// ---------- one-shot resolution flow ----------------------------------------

async function resolveOnce(args: {
  claimId: bigint;
  text: string;
  specRaw: string;
  signer: ethers.Signer;
  contract: ethers.Contract;
}) {
  const spec = parseSpec(args.specRaw);
  const req: AgentRequest = AgentRequestSchema.parse({
    claimId: Number(args.claimId),
    text: args.text,
    spec,
  });

  // KV: mark verifying.
  await putKv(ZgKeys.claimStatus(args.claimId.toString()), "verifying");
  await appendLog(ZgStreams.claimEvents(args.claimId.toString()), { kind: "verifying" });

  // 1) Dispatch to swarm and collect signed votes.
  const responses = await runSwarm(req, args.claimId, args.signer);

  // 2) Tentative consensus.
  const tentative = decide({
    request: req,
    responses,
    thresholds: { resolvability: RESOLVABILITY_THRESHOLD, agreement: AGREEMENT_THRESHOLD },
  });

  // 3) Critic pass via auditor (best-effort; falls back if agent missing).
  await axl.publish(Channels.critic(args.claimId), {
    claimId: args.claimId.toString(),
    tentativeMajority: tentative.outcome,
  });
  const critic = await runCritic({
    request: req,
    tentative: tentative.outcome,
    responses,
  });
  if (critic) {
    await axl.publish(Channels.criticVerdict(args.claimId), critic);
  }

  // 4) Final consensus including critic.
  const final = decide({
    request: req,
    responses,
    critic,
    thresholds: { resolvability: RESOLVABILITY_THRESHOLD, agreement: AGREEMENT_THRESHOLD },
  });

  // 5) Build proof, pin to 0G Storage.
  const signedVotes = await Promise.all(
    responses.map((r) =>
      signVote({
        signer: args.signer,
        tokenId: r.identity.tokenId,
        claimId: args.claimId,
        outcome: r.outcome,
        resolvable: r.resolvable,
        confidence: r.confidence,
        reasoning: r.reasoning,
        evidence: r.evidence,
        zgReceipt: r.zgReceipt,
      }),
    ),
  );

  const { proofUri, bundle } = await buildAndPinProof({
    request: req,
    votes: signedVotes,
    critic,
    consensus: final.consensus,
    participants: final.participants,
  });

  // 6) Submit on-chain.
  const participantsArg = final.participants.map((p) => BigInt(p.tokenId));
  const agreedArg = final.participants.map((p) => p.agreed);

  let txHash: string | undefined;
  try {
    const tx = await args.contract.resolveClaim(
      args.claimId,
      outcomeToEnum(final.outcome),
      proofUri,
      participantsArg,
      agreedArg,
    );
    const rcpt = await tx.wait();
    txHash = rcpt?.hash ?? tx.hash;
  } catch (e) {
    console.warn(`resolveClaim on-chain submit failed (${(e as Error).message}); proof bundle was still pinned.`);
  }

  await axl.publish(Channels.reputationGossip, {
    claimId: args.claimId.toString(),
    deltas: final.participants.map((p) => ({ tokenId: p.tokenId, delta: p.agreed ? 10 : -5 })),
  });

  return { decision: final, bundle, proofUri, txHash };
}

// ---------- HTTP API + chain listener ---------------------------------------

async function main() {
  if (!RPC_URL || !PRIVATE_KEY || !ORACLE_ADDRESS) {
    console.warn("RPC_URL / COORDINATOR_PRIVATE_KEY / VERITAS_ORACLE_ADDRESS missing.");
    console.warn("Backend will start in DRY-RUN mode (HTTP /v1/verify works, /v1/resolve will fail).");
  }

  const provider = RPC_URL ? new ethers.JsonRpcProvider(RPC_URL) : null;
  const wallet = PRIVATE_KEY && provider
    ? new ethers.Wallet(PRIVATE_KEY, provider)
    : ethers.Wallet.createRandom(); // mock signer for local-only runs
  const contract = ORACLE_ADDRESS && provider
    ? new ethers.Contract(ORACLE_ADDRESS, ABI, wallet)
    : null;

  if (provider && INFT_ADDRESS) setupINFT(provider, INFT_ADDRESS);

  // Self-announce on AXL discovery (mock mode = noop, real mode = mesh discovery).
  await axl.publish(Channels.discovery, {
    role: "coordinator",
    peerId: axl.peerId,
    chain: provider ? (await provider.getNetwork()).chainId.toString() : "none",
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      modes: {
        axl: axlMode,
        zgStorage: zgMode,
        /** `real` only when ZG_STREAM_ID + Flow + KV URL are set AND writes succeed ACL. */
        zgKv: zgKvReal ? "real" : "mock",
        zgCompute: zgComputeMode,
      },
      onChain: !!contract,
    }),
  );

  app.post("/v1/verify", async (req, res) => {
    try {
      const { text, spec } = req.body ?? {};
      const specJson = typeof spec === "string" ? spec : JSON.stringify(spec);
      const parsedSpec = parseSpec(specJson);
      const claimId = BigInt(Date.now()); // synthetic; not on-chain
      const responses = await runSwarm(
        AgentRequestSchema.parse({ text: String(text), spec: parsedSpec }),
        claimId,
        wallet,
      );
      const tentative = decide({
        request: AgentRequestSchema.parse({ text: String(text), spec: parsedSpec }),
        responses,
        thresholds: { resolvability: RESOLVABILITY_THRESHOLD, agreement: AGREEMENT_THRESHOLD },
      });
      const critic = await runCritic({
        request: AgentRequestSchema.parse({ text: String(text), spec: parsedSpec }),
        tentative: tentative.outcome,
        responses,
      });
      const final = decide({
        request: AgentRequestSchema.parse({ text: String(text), spec: parsedSpec }),
        responses,
        critic,
        thresholds: { resolvability: RESOLVABILITY_THRESHOLD, agreement: AGREEMENT_THRESHOLD },
      });
      const responseOut = responses.map((r) => ({
        agent: r.agent,
        ens: r.identity.ens,
        tokenId: r.identity.tokenId.toString(),
        outcome: r.outcome,
        resolvable: r.resolvable,
        confidence: r.confidence,
        reasoning: r.reasoning,
        evidence: r.evidence,
      }));

      // Pin a verify snapshot to 0G (indexer.upload) — works without KV stream id; judges can look up root on Storage Scan.
      let proofUri: string | undefined;
      let proofPinError: string | undefined;
      if (zgMode === "real") {
        try {
          proofUri = await pinJson({
            schema: "veritas.verify.v1",
            decidedAtIso: new Date().toISOString(),
            request: { text: String(text), spec: parsedSpec },
            decision: {
              outcome: final.outcome,
              confidence: final.confidence,
              resolvable: final.resolvable,
              agreement: final.agreement,
              consensus: final.consensus,
              participants: final.participants,
            },
            critic: critic ?? null,
            responses: responseOut,
          });
        } catch (e) {
          proofPinError = (e as Error).message;
          console.warn("pinJson (/v1/verify) failed:", proofPinError);
        }
      }

      res.json({
        decision: final,
        critic,
        responses: responseOut,
        proofUri,
        ...(proofPinError ? { proofPinError } : {}),
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/v1/resolve/:claimId", async (req, res) => {
    if (!contract) {
      return res.status(400).json({ error: "Backend not configured for on-chain (set RPC_URL + VERITAS_ORACLE_ADDRESS)." });
    }
    try {
      const claimId = BigInt(req.params.claimId);
      const c = await contract.claims(claimId);
      const out = await resolveOnce({
        claimId,
        text: c.text,
        specRaw: c.spec,
        signer: wallet,
        contract,
      });
      res.json({
        claimId: claimId.toString(),
        outcome: out.decision.outcome,
        proofUri: out.proofUri,
        txHash: out.txHash,
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get("/v1/claims/:claimId", async (req, res) => {
    if (!contract) return res.status(400).json({ error: "Not configured for on-chain reads." });
    try {
      const id = BigInt(req.params.claimId);
      const c = await contract.claims(id);
      res.json({
        claimId: id.toString(),
        requester: c.requester,
        resolveBy: c.resolveBy.toString(),
        resolvedAt: c.resolvedAt.toString(),
        outcome: ["NO", "YES", "INVALID", "ESCALATE"][Number(c.outcome)],
        text: c.text,
        spec: c.spec,
        proofUri: c.proofUri,
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.listen(PORT, () => {
    console.log(`\nVeritas coordinator on :${PORT}`);
    console.log(`  axl:        ${axlMode}`);
    console.log(`  zgStorage:  ${zgMode} (blob upload proofs)`);
    console.log(`  zgKV:       ${zgKvReal ? "real" : "mock"} (claim logs / KV; needs stream write perms)`);
    console.log(`  zgCompute:  ${zgComputeMode}`);
    console.log(`  onChain:    ${!!contract} (oracle=${ORACLE_ADDRESS || "-"})`);
  });

  if (contract) {
    contract.on("ClaimSubmitted", async (claimId: bigint, requester: string, resolveBy: bigint, text: string, spec: string) => {
      console.log(`event ClaimSubmitted #${claimId} by ${requester}`);
      await appendLog(ZgStreams.claimEvents(claimId.toString()), {
        kind: "submitted",
        requester,
        resolveBy: resolveBy.toString(),
      });
      await putKv(ZgKeys.claimStatus(claimId.toString()), "pending");

      if (!AUTO_RESOLVE) return;

      // Wait until resolveBy then run the swarm.
      const waitMs = Math.max(0, Number(resolveBy) * 1000 - Date.now()) + 1000;
      setTimeout(async () => {
        try {
          const out = await resolveOnce({
            claimId,
            text,
            specRaw: spec,
            signer: wallet,
            contract,
          });
          console.log(`auto-resolved #${claimId} -> ${out.decision.outcome} tx=${out.txHash}`);
        } catch (e) {
          console.warn(`auto-resolve #${claimId} failed: ${(e as Error).message}`);
        }
      }, waitMs);
    });

    contract.on("ClaimResolved", (claimId: bigint, outcome: bigint, _resolvedAt: bigint, proofUri: string) => {
      console.log(`event ClaimResolved #${claimId} -> ${["NO","YES","INVALID","ESCALATE"][Number(outcome)]} ${proofUri}`);
    });
  }
}

await main();
