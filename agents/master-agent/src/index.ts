import "dotenv/config";
import express from "express";
import * as crypto from "node:crypto";
import { z } from "zod";
import { startAxlAgent } from "../../shared/axl-agent.js";

const PORT = Number(process.env.PORT ?? "8810");
const DEXSCREENER_API_BASE = (process.env.DEXSCREENER_API_BASE ?? "https://api.dexscreener.com").replace(/\/$/, "");
const AGENT_NAME = process.env.AGENT_NAME ?? process.env.AXL_PEER_ID ?? "master-agent";

const GithubSpecSchema = z.object({
  kind: z.literal("github_pr_merged_before"),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  deadlineIso: z.string().min(1),
});

const SnapshotSpecSchema = z.object({
  kind: z.literal("snapshot_proposal_passed"),
  space: z.string().min(1),
  proposalId: z.string().min(1),
});

const TokenPriceSpecSchema = z.object({
  kind: z.literal("token_price_target"),
  chainId: z.string().min(1),
  tokenAddress: z.string().min(1),
  targetPriceUsd: z.number().positive(),
  direction: z.enum(["above", "below"]).default("above"),
  deadlineIso: z.string().min(1),
});

const SpecSchema = z.discriminatedUnion("kind", [
  GithubSpecSchema,
  SnapshotSpecSchema,
  TokenPriceSpecSchema,
]);

const VerifyRequestSchema = z.object({
  claimId: z.number().int().positive().optional(),
  text: z.string().min(1),
  spec: SpecSchema,
});

const CritiqueRequestSchema = z.object({
  request: z.object({
    text: z.string(),
    spec: SpecSchema,
  }),
  tentative: z.enum(["NO", "YES", "INVALID", "ESCALATE"]),
  responses: z.array(z.object({
    agent: z.string(),
    resolvable: z.boolean(),
    outcome: z.enum(["NO", "YES", "INVALID", "ESCALATE"]),
    confidence: z.number(),
    evidence: z.array(z.object({ type: z.string(), uri: z.string(), note: z.string().optional() })).default([]),
    reasoning: z.string(),
  })),
});

type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
type CritiqueRequest = z.infer<typeof CritiqueRequestSchema>;

function asDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO date: ${iso}`);
  return d;
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function verifyGithub(req: VerifyRequest) {
  const spec = GithubSpecSchema.parse(req.spec);
  const [owner, name] = spec.repo.split("/");
  if (!owner || !name) throw new Error("repo must be 'owner/name'");

  const apiUrl = `https://api.github.com/repos/${owner}/${name}/pulls/${spec.prNumber}`;
  const res = await fetch(apiUrl, {
    headers: {
      accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json() as {
    html_url: string;
    state: string;
    merged_at: string | null;
    closed_at: string | null;
  };

  const deadline = asDate(spec.deadlineIso);
  const mergedAt = data.merged_at ? asDate(data.merged_at) : null;
  const passed = !!mergedAt && mergedAt.getTime() <= deadline.getTime();

  return {
    agent: AGENT_NAME,
    resolvable: true,
    outcome: passed ? "YES" as const : "NO" as const,
    confidence: 0.9,
    evidence: [
      { type: "github_api", uri: apiUrl },
      { type: "github_html", uri: data.html_url },
    ],
    reasoning: mergedAt
      ? `PR merged at ${mergedAt.toISOString()} (deadline ${deadline.toISOString()}).`
      : `PR not merged (merged_at is null). State=${data.state}, closed_at=${data.closed_at ?? "null"}.`,
  };
}

async function verifySnapshot(req: VerifyRequest) {
  const spec = SnapshotSpecSchema.parse(req.spec);
  const endpoint = process.env.SNAPSHOT_GRAPHQL ?? "https://hub.snapshot.org/graphql";
  const query = `
    query Proposal($id: String!) {
      proposal(id: $id) {
        id title state choices scores scores_total link space { id }
      }
    }
  `;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { id: spec.proposalId } }),
  });
  if (!res.ok) throw new Error(`Snapshot GraphQL error ${res.status}: ${await res.text().catch(() => "")}`);
  const json = await res.json() as {
    data?: { proposal?: { state: string; choices: string[]; scores: number[]; link: string; space: { id: string } } | null };
  };
  const p = json.data?.proposal;
  if (!p) {
    return {
      agent: AGENT_NAME,
      resolvable: false,
      outcome: "INVALID" as const,
      confidence: 0.6,
      evidence: [{ type: "snapshot_graphql", uri: endpoint, note: "proposal not found" }],
      reasoning: "Snapshot proposal not found for given proposalId.",
    };
  }
  if (p.space.id !== spec.space) {
    return {
      agent: AGENT_NAME,
      resolvable: false,
      outcome: "INVALID" as const,
      confidence: 0.6,
      evidence: [{ type: "snapshot_link", uri: p.link }],
      reasoning: `Proposal space mismatch. Expected ${spec.space}, got ${p.space.id}.`,
    };
  }
  if (!["closed", "final"].includes(p.state.toLowerCase())) {
    return {
      agent: AGENT_NAME,
      resolvable: true,
      outcome: "ESCALATE" as const,
      confidence: 0.55,
      evidence: [{ type: "snapshot_link", uri: p.link }],
      reasoning: `Proposal not finalized yet (state=${p.state}).`,
    };
  }

  const best = p.scores.reduce((bestIdx, score, idx) => score > p.scores[bestIdx] ? idx : bestIdx, 0);
  const winner = p.choices[best] ?? "";
  const passed = ["yes", "for", "approve", "accept"].includes(winner.trim().toLowerCase());
  return {
    agent: AGENT_NAME,
    resolvable: true,
    outcome: passed ? "YES" as const : "NO" as const,
    confidence: 0.8,
    evidence: [
      { type: "snapshot_link", uri: p.link },
      { type: "snapshot_graphql", uri: endpoint, note: `winner=${winner}` },
    ],
    reasoning: `Snapshot proposal is closed. Winning choice is '${winner}'. Interpreting as ${passed ? "PASS" : "FAIL"} using a Yes/For heuristic.`,
  };
}

type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  baseToken?: { symbol?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
};

async function verifyTokenPrice(req: VerifyRequest) {
  const spec = TokenPriceSpecSchema.parse(req.spec);
  const deadline = asDate(spec.deadlineIso);
  if (Date.now() < deadline.getTime()) {
    return {
      agent: AGENT_NAME,
      resolvable: true,
      outcome: "ESCALATE" as const,
      confidence: 0.55,
      evidence: [],
      reasoning: `Price target is not ready to resolve until ${deadline.toISOString()}.`,
    };
  }

  const url = `${DEXSCREENER_API_BASE}/tokens/v1/${encodeURIComponent(spec.chainId)}/${encodeURIComponent(spec.tokenAddress)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`DEXScreener API error ${res.status}: ${await res.text().catch(() => "")}`);
  const pairs = await res.json() as DexPair[];
  const pair = pairs
    .filter((p) => p.priceUsd && Number.isFinite(Number(p.priceUsd)))
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!pair) {
    return {
      agent: AGENT_NAME,
      resolvable: false,
      outcome: "INVALID" as const,
      confidence: 0.5,
      evidence: [{ type: "dexscreener_api", uri: url, note: "no pair with priceUsd found" }],
      reasoning: "DEXScreener returned no priced pair for this token.",
    };
  }

  const price = Number(pair.priceUsd);
  const passed = spec.direction === "above" ? price >= spec.targetPriceUsd : price <= spec.targetPriceUsd;
  const comparator = spec.direction === "above" ? ">=" : "<=";
  return {
    agent: AGENT_NAME,
    resolvable: true,
    outcome: passed ? "YES" as const : "NO" as const,
    confidence: pair.liquidity?.usd ? 0.82 : 0.68,
    evidence: [
      { type: "dexscreener_api", uri: url },
      ...(pair.url ? [{ type: "dexscreener_pair", uri: pair.url, note: `${pair.chainId ?? spec.chainId}:${pair.dexId ?? "dex"}` }] : []),
    ],
    reasoning: `${pair.baseToken?.symbol ?? "token"}/${pair.quoteToken?.symbol ?? "quote"} price is $${price} USD, target check is price ${comparator} $${spec.targetPriceUsd} at ${deadline.toISOString()}.`,
  };
}

async function verify(raw: unknown) {
  const req = VerifyRequestSchema.parse(raw);
  switch (req.spec.kind) {
    case "github_pr_merged_before": return verifyGithub(req);
    case "snapshot_proposal_passed": return verifySnapshot(req);
    case "token_price_target": return verifyTokenPrice(req);
  }
}

function fmtBundle(req: CritiqueRequest) {
  return JSON.stringify({
    text: req.request.text,
    spec: req.request.spec,
    tentative: req.tentative,
    responses: req.responses.map((r) => ({
      agent: r.agent,
      outcome: r.outcome,
      confidence: r.confidence,
      reasoning: r.reasoning.slice(0, 280),
    })),
  });
}

function criticPrompt(req: CritiqueRequest) {
  return `You are an adversarial auditor for a prediction-market resolution.
Check the tentative outcome against the request and supplied evidence.

GitHub rule: merged_at null means NO; merged_at <= deadlineIso means YES; merged_at > deadlineIso means NO.
Snapshot rule: finalized winning Yes/For/Approve/Accept means YES; finalized against means NO; unfinished means ESCALATE.
Token-price rule: direction=above means YES iff priceUsd >= targetPriceUsd; direction=below means YES iff priceUsd <= targetPriceUsd; future deadline means ESCALATE.

Tentative outcome: ${req.tentative}.
Bundle: ${fmtBundle(req)}
Reply with exactly one line:
CONFIRM <reason>, FLIP <correct outcome> <reason>, or ESCALATE <reason>.`;
}

function parseCriticReply(out: string): "confirm" | "flip" | "escalate" {
  return out.startsWith("FLIP") ? "flip" : out.startsWith("ESCALATE") ? "escalate" : "confirm";
}

async function critique(raw: unknown) {
  const req = CritiqueRequestSchema.parse(raw);
  const apiUrl = process.env.ZG_COMPUTE_API_URL;
  const apiKey = process.env.ZG_COMPUTE_API_KEY;
  const model = process.env.ZG_COMPUTE_MODEL;
  if (apiUrl && apiKey && model) {
    const prompt = criticPrompt(req);
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.0,
        messages: [
          { role: "system", content: "You are a careful adversarial auditor for prediction-market resolutions." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`0G Compute router error ${res.status}: ${await res.text().catch(() => "")}`);
    const json = await res.json() as any;
    const out = String(json.choices?.[0]?.message?.content ?? "").trim();
    return {
      verdict: parseCriticReply(out),
      reasoning: out || "auditor reply was empty",
      zgReceipt: json.id ? `0g-router://${json.id}` : `0g-router://${sha256(prompt + out)}`,
    };
  }

  const lowConf = req.responses.find((r) => r.confidence < 0.3);
  if (lowConf) {
    return {
      verdict: "escalate" as const,
      reasoning: `Critic found at least one primary response with confidence ${lowConf.confidence} (< 0.3). Recommending escalation.`,
      zgReceipt: `mock-zgc://${sha256(fmtBundle(req))}`,
    };
  }
  const dissent = req.responses.find((r) => r.outcome !== req.tentative && r.confidence > 0.75 && r.resolvable);
  if (dissent) {
    return {
      verdict: "escalate" as const,
      reasoning: `Critic found high-confidence dissent (${dissent.agent} said ${dissent.outcome} with ${dissent.confidence}). Escalating.`,
      zgReceipt: `mock-zgc://${sha256(fmtBundle(req))}`,
    };
  }
  return {
    verdict: "confirm" as const,
    reasoning: `Critic confirms tentative outcome ${req.tentative}.`,
    zgReceipt: `mock-zgc://${sha256(fmtBundle(req))}`,
  };
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({
  ok: true,
  agent: AGENT_NAME,
  capabilities: ["github_pr_merged_before", "snapshot_proposal_passed", "token_price_target", "critic"],
  axl: !!process.env.AXL_HTTP_URL,
  zgCompute: !!(process.env.ZG_COMPUTE_API_URL && process.env.ZG_COMPUTE_API_KEY && process.env.ZG_COMPUTE_MODEL),
  zgComputeMode: process.env.ZG_COMPUTE_API_URL ? "router" : "mock",
}));

app.post("/verify", async (req, res) => {
  try {
    res.json(await verify(req.body));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/critique", async (req, res) => {
  try {
    res.json(await critique(req.body));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`Master agent listening on :${PORT}`);
});

startAxlAgent({
  agentName: AGENT_NAME,
  capabilities: ["github_pr_merged_before", "snapshot_proposal_passed", "token_price_target"],
  verify: (req) => verify(req),
});
