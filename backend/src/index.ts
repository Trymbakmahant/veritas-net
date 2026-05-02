import "dotenv/config";
import express from "express";
import { ethers } from "ethers";
import {
  AgentRequest,
  AgentRequestSchema,
  AgentResponse,
  AgentResponseSchema,
  ClaimSpecSchema,
  CriticVerdict,
  Outcome,
  OracleIdentity,
  outcomeToEnum,
} from "./types.js";
import {
  callAuditorAgent,
  callAgentByManifest,
  callGithubAgent,
  callSnapshotAgent,
} from "./agents.js";
import { decide, votePayloadFromResponse } from "./coordinator.js";
import { axl, axlMode, Channels } from "./axl.js";
import { identityFor, reputationOf, setupINFT } from "./inft.js";
import { AgentRegistry, envFallback } from "./registry.js";
import type { RegistryEntry } from "./types.js";
import { AgentManifestSchema } from "./types.js";
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
const AXL_VOTE_WINDOW_MS      = Number(process.env.AXL_VOTE_WINDOW_MS ?? "4000");

// Auto-resolve a claim once submitted+resolveBy reached (for demo).
const AUTO_RESOLVE = (process.env.AUTO_RESOLVE ?? "true") !== "false";

const ABI = [
  "event ClaimSubmitted(uint256 indexed claimId, address indexed requester, uint64 resolveBy, string text, string spec)",
  "event ConsumerRegistered(uint256 indexed claimId, address indexed consumer)",
  "event ClaimResolved(uint256 indexed claimId, uint8 outcome, uint64 resolvedAt, string proofUri, uint256[] participants)",
  "event ConsumerNotified(uint256 indexed claimId, address indexed consumer, bool ok, bytes returnData)",
  "event ClaimDisputed(uint256 indexed claimId, address indexed disputer, uint256 bond, uint64 disputedAt)",
  "event ClaimReResolved(uint256 indexed claimId, uint8 outcome, string proofUri, bool flipped, uint256 bondRefunded, uint256[] participants)",
  "function resolveClaim(uint256 claimId, uint8 outcome, string proofUri, uint256[] participants, bool[] agreed) external",
  "function reResolve(uint256 claimId, uint8 outcome, string proofUri, uint256[] participants, bool[] agreed) external",
  "function claims(uint256) view returns (address requester,uint64 resolveBy,uint64 resolvedAt,uint8 outcome,string text,string spec,string proofUri,address consumer,address disputer,uint96 disputeBondLocked,uint64 disputedAt)",
  "function nextClaimId() view returns (uint256)",
  "function submitClaim(string text, string spec, uint64 resolveBy) external returns (uint256)",
  "function submitClaimWithConsumer(string text, string spec, uint64 resolveBy, address consumer) external returns (uint256)",
  "function disputeBond() view returns (uint256)",
  "function disputeWindow() view returns (uint64)",
];

const OUTCOME_NAMES = ["NO", "YES", "INVALID", "ESCALATE"] as const;

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
//
// Selection is **registry-driven**: at boot we walk OracleINFT, fetch each agent's
// AgentManifest from 0G Storage, and index by `capabilities`. Dispatch picks the
// top-N entries by reputation that can answer `spec.kind`. If nothing is registered
// for a capability we fall back to the hardcoded GITHUB/SNAPSHOT URLs so existing
// dev loops keep working.

const registry = new AgentRegistry(envFallback());

function pickRegistry(spec: AgentRequest["spec"]): RegistryEntry[] {
  return registry.pickFor(spec.kind, 2);
}

type SwarmResponse = AgentResponse & { identity: OracleIdentity; reputation?: number };

type Candidate = {
  name: string;
  aliases: string[];
  identity: OracleIdentity;
  reputation?: number;
  entry?: RegistryEntry;
};

function candidateForEntry(entry: RegistryEntry): Candidate {
  return {
    name: entry.manifest.name,
    aliases: [
      entry.manifest.name,
      `${entry.manifest.name}-agent`,
      entry.ens.replace(/\.veritas\.eth$/, ""),
    ],
    identity: {
      tokenId: entry.tokenId,
      ens: entry.ens,
      version: entry.version,
    },
    reputation: entry.reputation,
    entry,
  };
}

function matchCandidate(candidates: Candidate[], agent: string): Candidate | undefined {
  const normalized = agent.toLowerCase();
  return candidates.find((c) => c.aliases.map((a) => a.toLowerCase()).includes(normalized));
}

async function publishSignedVote(args: {
  signer: ethers.Signer;
  claimId: bigint;
  response: AgentResponse;
  identity: OracleIdentity;
}) {
  const vote = await signVote({
    signer: args.signer,
    tokenId: args.identity.tokenId,
    claimId: args.claimId,
    outcome: args.response.outcome,
    resolvable: args.response.resolvable,
    confidence: args.response.confidence,
    reasoning: args.response.reasoning,
    evidence: args.response.evidence,
    zgReceipt: args.response.zgReceipt,
  });
  await axl.publish(Channels.vote(args.claimId), {
    kind: "signed_vote",
    ...vote,
    tokenId: vote.tokenId.toString(),
    claimId: vote.claimId.toString(),
  });
  await appendLog(ZgStreams.claimAgentResponses(args.claimId.toString()), {
    ens: args.identity.ens,
    tokenId: args.identity.tokenId.toString(),
    ...args.response,
  });
}

async function collectAxlAgentResponses(args: {
  request: AgentRequest;
  claimId: bigint;
  candidates: Candidate[];
  signer: ethers.Signer;
}): Promise<SwarmResponse[]> {
  if (axlMode !== "real" || args.candidates.length === 0) return [];

  return new Promise<SwarmResponse[]>((resolve) => {
    const out: SwarmResponse[] = [];
    const seen = new Set<string>();
    const off = axl.subscribe(Channels.vote(args.claimId), (msg) => {
      const payload = (msg as any)?.kind ? msg : (msg as any)?.payload;
      if (!payload || payload.kind !== "agent_response") return;
      if (String(payload.claimId) !== args.claimId.toString()) return;

      const parsed = AgentResponseSchema.safeParse(payload.response);
      if (!parsed.success) {
        console.warn(`AXL vote ignored: invalid AgentResponse from ${payload.agent ?? "unknown"}`);
        return;
      }
      const candidate = matchCandidate(args.candidates, parsed.data.agent)
        ?? matchCandidate(args.candidates, String(payload.agent ?? ""));
      if (!candidate) {
        console.warn(`AXL vote ignored: no registered identity for agent=${parsed.data.agent}`);
        return;
      }
      const key = candidate.identity.tokenId.toString();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...parsed.data, identity: candidate.identity, reputation: candidate.reputation });
    });

    void axl.publish(Channels.claimDispatch, {
      claimId: args.claimId.toString(),
      request: args.request,
      expectedAgents: args.candidates.map((c) => ({
        name: c.name,
        ens: c.identity.ens,
        tokenId: c.identity.tokenId.toString(),
        capabilities: c.entry?.manifest.capabilities ?? [],
      })),
    }).catch((e) => console.warn(`AXL dispatch failed: ${(e as Error).message}`));

    setTimeout(() => {
      off();
      resolve(out);
    }, AXL_VOTE_WINDOW_MS);
  }).then(async (responses) => {
    await Promise.all(
      responses.map((r) =>
        publishSignedVote({
          signer: args.signer,
          claimId: args.claimId,
          response: r,
          identity: r.identity,
        }),
      ),
    );
    return responses;
  });
}

async function runSwarm(req: AgentRequest, claimId: bigint, signer: ethers.Signer) {
  const entries = pickRegistry(req.spec);

  const responses: SwarmResponse[] = [];

  // ---- Path A: registry-backed dispatch ---------------------------------
  if (entries.length > 0) {
    const candidates = entries.map(candidateForEntry);
    const axlResponses = await collectAxlAgentResponses({ request: req, claimId, candidates, signer });
    if (axlResponses.length > 0) {
      console.log(`AXL swarm #${claimId}: collected ${axlResponses.length}/${candidates.length} registry response(s)`);
      return axlResponses;
    }
    await axl.publish(Channels.claimDispatch, { claimId: claimId.toString(), request: req, fallback: "http" });

    await Promise.all(
      entries.map(async (entry) => {
        const identity: OracleIdentity = {
          tokenId: entry.tokenId,
          ens: entry.ens,
          version: entry.version,
        };
        try {
          const resp = await callAgentByManifest(entry.manifest, req);
          responses.push({ ...resp, identity, reputation: entry.reputation });
          await publishSignedVote({
            signer,
            claimId,
            response: resp,
            identity,
          });
        } catch (e) {
          responses.push({
            agent: entry.manifest.name,
            resolvable: false,
            outcome: "INVALID" as Outcome,
            confidence: 0.2,
            evidence: [],
            reasoning: `Agent call failed: ${(e as Error).message}`,
            identity,
            reputation: entry.reputation,
          });
        }
      }),
    );
    return responses;
  }

  // ---- Path B: legacy hardcoded fallback (no registered agent matched) --
  type AgentName = "github" | "snapshot";
  const fallbackSet: AgentName[] = req.spec.kind === "github_pr_merged_before"
    ? ["github", "github"]
    : ["snapshot", "snapshot"];

  const identities = await Promise.all(fallbackSet.map((n) => identityFor(n).then(async (id) => {
    const rep = await reputationOf(id.tokenId);
    return { name: n, identity: id, reputation: rep };
  })));

  const fallbackCandidates: Candidate[] = identities.map(({ name, identity, reputation }) => ({
    name,
    aliases: [name, `${name}-agent`],
    identity,
    reputation,
  }));
  const axlResponses = await collectAxlAgentResponses({ request: req, claimId, candidates: fallbackCandidates, signer });
  if (axlResponses.length > 0) {
    console.log(`AXL swarm #${claimId}: collected ${axlResponses.length}/${fallbackCandidates.length} fallback response(s)`);
    return axlResponses;
  }
  await axl.publish(Channels.claimDispatch, { claimId: claimId.toString(), request: req, fallback: "http" });

  await Promise.all(
    identities.map(async ({ name, identity, reputation }) => {
      try {
        const resp = name === "github"
          ? await callGithubAgent(GITHUB_AGENT_URL, req, GITHUB_TOKEN || undefined)
          : await callSnapshotAgent(SNAPSHOT_AGENT_URL, req);
        responses.push({ ...resp, identity, reputation });
        await publishSignedVote({
          signer,
          claimId,
          response: resp,
          identity,
        });
      } catch (e) {
        responses.push({
          agent: name,
          resolvable: false,
          outcome: "INVALID" as Outcome,
          confidence: 0.2,
          evidence: [],
          reasoning: `Agent call failed: ${(e as Error).message}`,
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
  /** When true, calls reResolve instead of resolveClaim (after a dispute). */
  reResolve?: boolean;
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
    const fn = args.reResolve ? args.contract.reResolve : args.contract.resolveClaim;
    const tx = await fn(
      args.claimId,
      outcomeToEnum(final.outcome),
      proofUri,
      participantsArg,
      agreedArg,
    );
    const rcpt = await tx.wait();
    txHash = rcpt?.hash ?? tx.hash;
  } catch (e) {
    const which = args.reResolve ? "reResolve" : "resolveClaim";
    console.warn(`${which} on-chain submit failed (${(e as Error).message}); proof bundle was still pinned.`);
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
  registry.attach(provider, INFT_ADDRESS);
  await registry.whenReady();

  // Self-announce on AXL discovery (mock mode = noop, real mode = mesh discovery).
  await axl.publish(Channels.discovery, {
    role: "coordinator",
    peerId: axl.peerId,
    chain: provider ? (await provider.getNetwork()).chainId.toString() : "none",
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Permissive CORS for the dashboard / dev tooling. Tighten via CORS_ALLOWED_ORIGIN
  // (comma list, e.g. "http://localhost:3000,https://veritas.example") in production.
  const corsAllowed = (process.env.CORS_ALLOWED_ORIGIN ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    const allow =
      corsAllowed.includes("*")
        ? "*"
        : origin && corsAllowed.includes(origin)
        ? origin
        : "";
    if (allow) {
      res.setHeader("access-control-allow-origin", allow);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      res.setHeader(
        "access-control-allow-headers",
        "content-type,authorization",
      );
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", async (_req, res) =>
    res.json({
      ok: true,
      modes: {
        axl: axlMode,
        zgStorage: zgMode,
        /** `real` only when ZG_STREAM_ID + Flow + KV URL are set AND writes succeed ACL. */
        zgKv: zgKvReal ? "real" : "mock",
        zgCompute: zgComputeMode,
      },
      axl: await axl.health(),
      onChain: !!contract,
      registeredAgents: registry.list().length,
    }),
  );

  app.get("/v1/agents", (_req, res) => {
    res.json({
      count: registry.list().length,
      agents: registry.list().map((e) => ({
        tokenId: e.tokenId.toString(),
        ens: e.ens,
        owner: e.owner,
        version: e.version,
        reputation: e.reputation,
        bundleUri: e.bundleUri,
        manifest: {
          name: e.manifest.name,
          displayName: e.manifest.displayName,
          endpoint: e.manifest.endpoint,
          capabilities: e.manifest.capabilities,
          version: e.manifest.version,
          description: e.manifest.description,
          signer: e.manifest.signer,
        },
      })),
    });
  });

  app.post("/v1/agents/refresh", async (_req, res) => {
    try {
      await registry.refresh();
      res.json({ ok: true, count: registry.list().length });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Pin an AgentManifest JSON to 0G Storage and return the resulting URI + hash.
   * The dashboard's "register your agent" flow calls this from the browser,
   * then the user's wallet calls `OracleINFT.registerOracle(...)` directly.
   *
   * NOTE: anyone can hit this. It only stores a JSON blob (no on-chain side
   * effects), so spam costs are bounded by the indexer / mock-pin disk.
   */
  app.post("/v1/manifests", async (req, res) => {
    try {
      const parsed = AgentManifestSchema.parse(req.body);
      const uri = await pinJson(parsed);
      const canon = JSON.stringify(parsed);
      const hash = ethers.keccak256(ethers.toUtf8Bytes(canon));
      res.json({ uri, hash, manifest: parsed });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * Convenience: surfaces the on-chain addresses + chain id the dashboard needs
   * to wire the user's wallet to the right OracleINFT.
   */
  app.get("/v1/config", async (_req, res) => {
    try {
      const chainId = provider ? (await provider.getNetwork()).chainId.toString() : null;
      res.json({
        chainId,
        rpcUrl: RPC_URL || null,
        contracts: {
          OracleINFT: INFT_ADDRESS || null,
          VeritasOracle: ORACLE_ADDRESS || null,
        },
        modes: { axl: axlMode, zgStorage: zgMode, zgKv: zgKvReal ? "real" : "mock", zgCompute: zgComputeMode },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

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

  /** Manual re-resolve trigger (the chain listener also auto-runs this on ClaimDisputed). */
  app.post("/v1/reresolve/:claimId", async (req, res) => {
    if (!contract) {
      return res.status(400).json({ error: "Backend not configured for on-chain." });
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
        reResolve: true,
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
        outcome: OUTCOME_NAMES[Number(c.outcome)],
        text: c.text,
        spec: c.spec,
        proofUri: c.proofUri,
        consumer: c.consumer,
        disputer: c.disputer,
        disputeBondLocked: c.disputeBondLocked.toString(),
        disputedAt: c.disputedAt.toString(),
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get("/v1/claims", async (req, res) => {
    if (!contract) return res.status(400).json({ error: "Not configured for on-chain reads." });
    try {
      const next: bigint = await contract.nextClaimId();
      const limit = Math.max(1, Math.min(100, Number((req.query.limit as string) ?? "20")));
      const total = next > 1n ? Number(next - 1n) : 0;
      const start = Math.max(1, total - limit + 1);
      const ids: bigint[] = [];
      for (let i = BigInt(start); i < next; i++) ids.push(i);

      const out = await Promise.all(
        ids.map(async (id) => {
          try {
            const c = await contract.claims(id);
            return {
              claimId: id.toString(),
              requester: c.requester,
              resolveBy: c.resolveBy.toString(),
              resolvedAt: c.resolvedAt.toString(),
              outcome: OUTCOME_NAMES[Number(c.outcome)],
              proofUri: c.proofUri,
              consumer: c.consumer,
              disputer: c.disputer,
              disputedAt: c.disputedAt.toString(),
              text: c.text,
              spec: c.spec,
            };
          } catch {
            return null;
          }
        }),
      );
      res.json({ count: out.filter(Boolean).length, total, claims: out.filter(Boolean) });
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
      console.log(`event ClaimResolved #${claimId} -> ${OUTCOME_NAMES[Number(outcome)]} ${proofUri}`);
    });

    contract.on("ConsumerRegistered", (claimId: bigint, consumer: string) => {
      console.log(`event ConsumerRegistered #${claimId} -> ${consumer}`);
    });

    contract.on("ConsumerNotified", (claimId: bigint, consumer: string, ok: boolean, _ret: string) => {
      console.log(`event ConsumerNotified #${claimId} -> ${consumer} ok=${ok}`);
    });

    // Auto-handle disputes: re-run the swarm with stricter thresholds and submit reResolve.
    contract.on("ClaimDisputed", async (claimId: bigint, disputer: string, bond: bigint) => {
      console.log(`event ClaimDisputed #${claimId} by ${disputer} bond=${bond}`);
      if (!AUTO_RESOLVE) return;
      try {
        const c = await contract.claims(claimId);
        const out = await resolveOnce({
          claimId,
          text: c.text,
          specRaw: c.spec,
          signer: wallet,
          contract,
          reResolve: true,
        });
        console.log(`auto-reresolved #${claimId} -> ${out.decision.outcome} tx=${out.txHash}`);
      } catch (e) {
        console.warn(`auto-reresolve #${claimId} failed: ${(e as Error).message}`);
      }
    });

    contract.on("ClaimReResolved", (claimId: bigint, outcome: bigint, _proofUri: string, flipped: boolean, refunded: bigint) => {
      console.log(`event ClaimReResolved #${claimId} -> ${OUTCOME_NAMES[Number(outcome)]} flipped=${flipped} refunded=${refunded}`);
    });
  }
}

await main();
