/**
 * Adversarial Auditor — second-pass critic over the swarm's tentative majority.
 *
 * Receives:
 *   {
 *     request:   { text, spec },
 *     tentative: "YES" | "NO" | "INVALID" | "ESCALATE",
 *     responses: AgentResponse[]
 *   }
 *
 * Returns:
 *   { verdict: "confirm" | "flip" | "escalate", reasoning, zgReceipt? }
 *
 * The critic uses a deliberately different reasoning strategy from the
 * primary agents (deterministic checks + adversarial heuristics). When
 * 0G Compute env is configured, it asks an independent model to argue
 * against the tentative outcome and returns the inference receipt.
 */

import "dotenv/config";
import express from "express";
import * as crypto from "node:crypto";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? "8803");

const ZG_COMPUTE_ROUTER_ENABLED =
  !!(process.env.ZG_COMPUTE_API_URL && process.env.ZG_COMPUTE_API_KEY && process.env.ZG_COMPUTE_MODEL);
const ZG_COMPUTE_DIRECT_ENABLED =
  !!(process.env.ZG_COMPUTE_PROVIDER && process.env.ZG_RPC_URL && process.env.COORDINATOR_PRIVATE_KEY);
const ZG_COMPUTE_ENABLED =
  ZG_COMPUTE_ROUTER_ENABLED || ZG_COMPUTE_DIRECT_ENABLED;
const ZG_COMPUTE_MODE = ZG_COMPUTE_ROUTER_ENABLED ? "router" : ZG_COMPUTE_DIRECT_ENABLED ? "direct" : "mock";
const SpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github_pr_merged_before"),
    repo: z.string(),
    prNumber: z.number().int(),
    deadlineIso: z.string(),
  }),
  z.object({
    kind: z.literal("snapshot_proposal_passed"),
    space: z.string(),
    proposalId: z.string(),
  }),
  z.object({
    kind: z.literal("token_price_target"),
    chainId: z.string(),
    tokenAddress: z.string(),
    targetPriceUsd: z.number().positive(),
    direction: z.enum(["above", "below"]).default("above"),
    deadlineIso: z.string(),
  }),
]);

const RequestSchema = z.object({
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

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function fmtBundle(req: z.infer<typeof RequestSchema>) {
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

function claimRules(spec: z.infer<typeof SpecSchema>) {
  switch (spec.kind) {
    case "github_pr_merged_before":
      return [
        "Rule for github_pr_merged_before:",
        "- YES only if GitHub evidence shows merged_at is present and merged_at <= deadlineIso.",
        "- NO if merged_at is null, missing, or later than deadlineIso.",
        "- A closed PR is not enough; it must have a non-null merged_at timestamp.",
        "- Do not infer an implicit merge or positive resolution when merged_at is null.",
      ].join("\n");
    case "snapshot_proposal_passed":
      return [
        "Rule for snapshot_proposal_passed:",
        "- YES only if the proposal belongs to the requested space, is finalized/closed, and the winning choice is clearly Yes/For/Approve/Accept.",
        "- NO if the finalized winning choice is clearly against the proposal.",
        "- ESCALATE if the proposal is not finalized or the winning choice cannot be interpreted safely.",
      ].join("\n");
    case "token_price_target":
      return [
        "Rule for token_price_target:",
        "- If the deadlineIso is in the future, ESCALATE because the price target is not ready to resolve.",
        "- For direction=above, YES only if the evidence priceUsd is >= targetPriceUsd at or after deadlineIso; otherwise NO.",
        "- For direction=below, YES only if the evidence priceUsd is <= targetPriceUsd at or after deadlineIso; otherwise NO.",
        "- Prefer the highest-liquidity DEXScreener pair when multiple pairs exist.",
        "- INVALID if no reliable price evidence is available.",
      ].join("\n");
  }
}

function criticPrompt(req: z.infer<typeof RequestSchema>) {
  return `You are an adversarial auditor for a prediction-market resolution.
You must check the tentative outcome against the deterministic rules below and the supplied agent evidence.

${claimRules(req.request.spec)}

Tentative outcome: ${req.tentative}.
Bundle: ${fmtBundle(req)}
Reply with exactly one line:
- CONFIRM <reason> if the tentative outcome matches the rules and evidence.
- FLIP <correct outcome: YES|NO|INVALID|ESCALATE> <reason> if the tentative outcome is wrong.
- ESCALATE <reason> if the evidence is insufficient or contradictory.
Do not invent unstated facts.`;
}

function parseCriticReply(out: string): "confirm" | "flip" | "escalate" {
  return out.startsWith("FLIP")
    ? "flip"
    : out.startsWith("ESCALATE")
    ? "escalate"
    : "confirm";
}

/**
 * Heuristic critic — works without any LLM. Strategies:
 *  1. If at least one primary response had confidence < 0.3 -> flag escalate.
 *  2. If primary responses cited zero independent evidence URIs -> escalate.
 *  3. If tentative=YES but any response said NO with high confidence -> escalate.
 *  4. Otherwise confirm.
 */
function heuristicCritic(req: z.infer<typeof RequestSchema>): { verdict: "confirm" | "flip" | "escalate"; reasoning: string } {
  const lowConf = req.responses.find((r) => r.confidence < 0.3);
  if (lowConf) {
    return {
      verdict: "escalate",
      reasoning: `Critic found at least one primary response with confidence ${lowConf.confidence} (< 0.3). Recommending escalation.`,
    };
  }

  const totalEvidenceUrls = new Set<string>();
  for (const r of req.responses) for (const e of r.evidence) totalEvidenceUrls.add(e.uri);
  if (totalEvidenceUrls.size === 0) {
    return {
      verdict: "escalate",
      reasoning: "Critic found zero independent evidence URIs across primary responses. Cannot certify outcome.",
    };
  }

  const dissent = req.responses.find(
    (r) => r.outcome !== req.tentative && r.confidence > 0.75 && r.resolvable,
  );
  if (dissent) {
    return {
      verdict: "escalate",
      reasoning: `Critic found high-confidence dissent (${dissent.agent} said ${dissent.outcome} with ${dissent.confidence}). Escalating.`,
    };
  }

  return {
    verdict: "confirm",
    reasoning: `Critic confirms tentative outcome ${req.tentative}: evidence count=${totalEvidenceUrls.size}, no high-confidence dissent.`,
  };
}

/**
 * 0G Compute critic — asks an independent model (via the @0gfoundation/0g-compute-ts-sdk
 * SDK) to argue against the tentative outcome and returns the inference receipt.
 * Returns `null` on any error so the heuristic critic is used instead.
 */
async function zgComputeRouterCritic(req: z.infer<typeof RequestSchema>) {
  try {
    const prompt = criticPrompt(req);
    const res = await fetch(process.env.ZG_COMPUTE_API_URL!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.ZG_COMPUTE_API_KEY!}`,
      },
      body: JSON.stringify({
        model: process.env.ZG_COMPUTE_MODEL!,
        temperature: 0.0,
        messages: [
          { role: "system", content: "You are a careful adversarial auditor for prediction-market resolutions." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`0G Compute router returned HTTP ${res.status}: ${text.slice(0, 240)}`);
      return null;
    }
    const json: any = await res.json();
    const out = String(json.choices?.[0]?.message?.content ?? "").trim();
    return {
      verdict: parseCriticReply(out),
      reasoning: out || "auditor reply was empty",
      zgReceipt: json.id ? `0g-router://${json.id}` : `0g-router://${sha256(prompt + out)}`,
    };
  } catch (e) {
    console.warn(`0G Compute router critic failed; falling back to heuristic critic: ${(e as Error).message}`);
    return null;
  }
}

async function zgComputeCritic(req: z.infer<typeof RequestSchema>) {
  try {
    const mod = await import("@0gfoundation/0g-compute-ts-sdk" as any).catch((e) => {
      console.warn(`0G Compute broker import failed: ${(e as Error).message}`);
      return null;
    });
    if (!mod) return null;
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(process.env.ZG_RPC_URL!);
    const wallet = new ethers.Wallet(process.env.COORDINATOR_PRIVATE_KEY!, provider);
    const broker = await (mod as any).createZGComputeNetworkBroker(wallet);
    const providerAddr = process.env.ZG_COMPUTE_PROVIDER!;
    try { await broker.inference.acknowledgeProviderSigner(providerAddr); } catch {}
    const meta = await broker.inference.getServiceMetadata(providerAddr);
    const headers = await broker.inference.getRequestHeaders(providerAddr);

    const prompt = criticPrompt(req);

    const res = await fetch(`${meta.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: meta.model,
        temperature: 0.0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`0G Compute provider returned HTTP ${res.status}: ${text.slice(0, 240)}`);
      return null;
    }
    const json: any = await res.json();
    const out = String(json.choices?.[0]?.message?.content ?? "").trim();
    const receipt: string = json.id || `0g-zgc://${sha256(prompt + out)}`;
    return { verdict: parseCriticReply(out), reasoning: out || "auditor reply was empty", zgReceipt: receipt };
  } catch (e) {
    console.warn(`0G Compute critic failed; falling back to heuristic critic: ${(e as Error).message}`);
    return null;
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({
  ok: true,
  agent: "adversarial-auditor",
  zgCompute: ZG_COMPUTE_ENABLED,
  zgComputeMode: ZG_COMPUTE_MODE,
}));

app.post("/critique", async (req, res) => {
  try {
    const parsed = RequestSchema.parse(req.body);

    let result: { verdict: "confirm" | "flip" | "escalate"; reasoning: string; zgReceipt?: string } | null = null;
    if (ZG_COMPUTE_ROUTER_ENABLED) result = await zgComputeRouterCritic(parsed);
    if (!result && ZG_COMPUTE_DIRECT_ENABLED) result = await zgComputeCritic(parsed);
    if (!result) {
      result = {
        ...heuristicCritic(parsed),
        zgReceipt: `mock-zgc://${sha256(fmtBundle(parsed))}`,
      };
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`Adversarial-auditor agent listening on :${PORT} (zgCompute=${ZG_COMPUTE_MODE})`);
});
