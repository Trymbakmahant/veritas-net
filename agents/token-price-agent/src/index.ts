import express from "express";
import { z } from "zod";
import { startAxlAgent } from "../../shared/axl-agent.js";

const PORT = Number(process.env.PORT ?? "8805");
const DEXSCREENER_API_BASE = (process.env.DEXSCREENER_API_BASE ?? "https://api.dexscreener.com").replace(/\/$/, "");

const RequestSchema = z.object({
  claimId: z.number().int().positive().optional(),
  text: z.string().min(1),
  spec: z.object({
    kind: z.literal("token_price_target"),
    chainId: z.string().min(1),
    tokenAddress: z.string().min(1),
    targetPriceUsd: z.number().positive(),
    direction: z.enum(["above", "below"]).default("above"),
    deadlineIso: z.string().min(1),
  }),
});

type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
};

function asDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO date: ${iso}`);
  return d;
}

async function fetchTokenPairs(chainId: string, tokenAddress: string) {
  const url = `${DEXSCREENER_API_BASE}/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DEXScreener API error ${res.status}: ${text.slice(0, 240)}`);
  }
  return { url, pairs: (await res.json()) as DexPair[] };
}

function bestPair(pairs: DexPair[]) {
  return pairs
    .filter((p) => p.priceUsd && Number.isFinite(Number(p.priceUsd)))
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

async function verifyTokenPrice(raw: unknown) {
  const parsed = RequestSchema.parse(raw);
  const deadline = asDate(parsed.spec.deadlineIso);
  const now = new Date();

  if (now.getTime() < deadline.getTime()) {
    return {
      agent: "token-price-agent",
      resolvable: true,
      outcome: "ESCALATE" as const,
      confidence: 0.55,
      evidence: [],
      reasoning: `Price target is not ready to resolve until ${deadline.toISOString()}.`,
    };
  }

  const { url, pairs } = await fetchTokenPairs(parsed.spec.chainId, parsed.spec.tokenAddress);
  const pair = bestPair(pairs);
  if (!pair) {
    return {
      agent: "token-price-agent",
      resolvable: false,
      outcome: "INVALID" as const,
      confidence: 0.5,
      evidence: [{ type: "dexscreener_api", uri: url, note: "no pair with priceUsd found" }],
      reasoning: "DEXScreener returned no priced pair for this token.",
    };
  }

  const price = Number(pair.priceUsd);
  const target = parsed.spec.targetPriceUsd;
  const passed = parsed.spec.direction === "above" ? price >= target : price <= target;
  const comparator = parsed.spec.direction === "above" ? ">=" : "<=";
  const pairLabel = `${pair.baseToken?.symbol ?? "token"}/${pair.quoteToken?.symbol ?? "quote"}`;

  return {
    agent: "token-price-agent",
    resolvable: true,
    outcome: passed ? "YES" as const : "NO" as const,
    confidence: pair.liquidity?.usd ? 0.82 : 0.68,
    evidence: [
      { type: "dexscreener_api", uri: url },
      ...(pair.url ? [{ type: "dexscreener_pair", uri: pair.url, note: `${pair.chainId ?? parsed.spec.chainId}:${pair.dexId ?? "dex"}` }] : []),
    ],
    reasoning: `${pairLabel} price is $${price} USD, target check is price ${comparator} $${target} at ${deadline.toISOString()}.`,
  };
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({
  ok: true,
  agent: "token-price-agent",
  axl: !!process.env.AXL_HTTP_URL,
  source: "dexscreener",
}));

app.post("/verify", async (req, res) => {
  try {
    res.json(await verifyTokenPrice(req.body));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`Token price agent listening on :${PORT}`);
});

startAxlAgent({
  agentName: "token-price-agent",
  capabilities: ["token_price_target"],
  verify: (req) => verifyTokenPrice(req),
});
