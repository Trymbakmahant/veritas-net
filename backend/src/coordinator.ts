import {
  AgentRequest,
  AgentResponse,
  CriticVerdict,
  Outcome,
  OracleIdentity,
  ProofBundle,
  SignedVote,
} from "./types.js";

export type ConsensusInput = {
  request: AgentRequest;
  responses: Array<AgentResponse & { identity: OracleIdentity; reputation?: number }>;
  critic?: CriticVerdict;
  thresholds?: { resolvability?: number; agreement?: number };
};

export type ConsensusResult = {
  outcome: Outcome;
  confidence: number;
  resolvable: boolean;
  consensus: ProofBundle["consensus"];
  participants: ProofBundle["participants"];
  agreement: number;
};

const DEFAULT_THRESHOLDS = { resolvability: 0.5, agreement: 0.67 };

function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }

/**
 * Reputation-weighted consensus.
 *  - resolvability gate: weighted resolvable share must >= thresholds.resolvability
 *  - per-outcome weight = sum( reputationWeight(rep) * confidence )
 *  - winning outcome must have agreement >= thresholds.agreement
 *  - critic flip pulls outcome to ESCALATE
 */
export function decide(input: ConsensusInput): ConsensusResult {
  const t = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const responses = input.responses;

  // Convert reputation (int, possibly negative) to a positive multiplicative weight.
  // weight = max(0.1, 1 + rep/100) so small/new oracles still count, top-rep oracles count ~3x.
  const weight = (rep?: number) => Math.max(0.1, 1 + (rep ?? 0) / 100);

  let resolvableW = 0;
  let totalW = 0;
  for (const r of responses) {
    const w = weight(r.reputation);
    totalW += w;
    if (r.resolvable) resolvableW += w;
  }

  const participantsBase = responses.map((r) => ({
    tokenId: r.identity.tokenId.toString(),
    ens: r.identity.ens,
    agreed: false,
  }));

  const buildConsensus = (
    outcome: Outcome,
    resolvable: boolean,
    confidence: number,
    agreement: number,
    notes: string,
  ): ProofBundle["consensus"] => ({
    outcome,
    resolvable,
    confidence,
    agreement,
    thresholds: { resolvability: t.resolvability, agreement: t.agreement },
    notes,
  });

  // ---- resolvability gate -------------------------------------------------
  const resolvableShare = totalW === 0 ? 0 : resolvableW / totalW;
  if (resolvableShare < t.resolvability) {
    return {
      outcome: "INVALID",
      confidence: clamp01(0.4 + (1 - resolvableShare) * 0.4),
      resolvable: false,
      agreement: 0,
      consensus: buildConsensus(
        "INVALID",
        false,
        clamp01(0.4 + (1 - resolvableShare) * 0.4),
        0,
        `Weighted resolvability share ${(resolvableShare * 100).toFixed(0)}% below threshold ${(t.resolvability * 100).toFixed(0)}%.`,
      ),
      participants: participantsBase,
    };
  }

  // ---- weighted vote per outcome -----------------------------------------
  const buckets = new Map<Outcome, number>([
    ["YES", 0],
    ["NO", 0],
    ["INVALID", 0],
    ["ESCALATE", 0],
  ]);
  for (const r of responses) {
    if (!r.resolvable) continue;
    const w = weight(r.reputation) * Math.max(0.1, r.confidence);
    buckets.set(r.outcome, (buckets.get(r.outcome) ?? 0) + w);
  }

  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const [topOutcome, topW] = sorted[0];
  const secondW = sorted[1]?.[1] ?? 0;
  const sumW = sorted.reduce((acc, [, w]) => acc + w, 0);
  const agreement = sumW === 0 ? 0 : topW / sumW;

  // Tie -> escalate
  if (topW === secondW || agreement < t.agreement) {
    const conf = clamp01(0.45 + agreement * 0.3);
    return {
      outcome: "ESCALATE",
      confidence: conf,
      resolvable: true,
      agreement,
      consensus: buildConsensus(
        "ESCALATE",
        true,
        conf,
        agreement,
        topW === secondW
          ? "Tie between outcomes; escalating."
          : `Agreement ${(agreement * 100).toFixed(0)}% below threshold ${(t.agreement * 100).toFixed(0)}%; escalating.`,
      ),
      participants: participantsBase.map((p) => ({
        ...p,
        agreed: false, // nobody "agreed" with ESCALATE
      })),
    };
  }

  // ---- critic check -------------------------------------------------------
  let final = topOutcome;
  let notes = `Reputation-weighted majority for ${topOutcome} with ${(agreement * 100).toFixed(0)}% agreement.`;
  if (input.critic?.verdict === "flip") {
    final = "ESCALATE";
    notes += ` Critic flipped tentative outcome (${input.critic.reasoning.slice(0, 80)}).`;
  } else if (input.critic?.verdict === "escalate") {
    final = "ESCALATE";
    notes += ` Critic requested escalation.`;
  } else if (input.critic?.verdict === "confirm") {
    notes += ` Critic confirmed.`;
  }

  // Confidence: blend agreement, weighted avg confidence, and reputation share.
  const winningRespConfs = responses
    .filter((r) => r.resolvable && r.outcome === topOutcome)
    .map((r) => r.confidence);
  const avgConf = winningRespConfs.length
    ? winningRespConfs.reduce((a, b) => a + b, 0) / winningRespConfs.length
    : 0.5;
  const confidence = clamp01(0.3 + agreement * 0.4 + avgConf * 0.3);

  const participants = responses.map((r) => ({
    tokenId: r.identity.tokenId.toString(),
    ens: r.identity.ens,
    agreed: r.outcome === final,
  }));

  return {
    outcome: final,
    confidence,
    resolvable: true,
    agreement,
    consensus: buildConsensus(final, true, confidence, agreement, notes),
    participants,
  };
}

/** Helper to build the SignedVote shape from an AgentResponse + identity + signer. */
export function votePayloadFromResponse(args: {
  response: AgentResponse;
  identity: OracleIdentity;
  claimId: bigint;
}): Omit<SignedVote, "sig" | "signer" | "voteHash"> {
  return {
    tokenId: args.identity.tokenId,
    claimId: args.claimId,
    resolvable: args.response.resolvable,
    outcome: args.response.outcome,
    confidence: args.response.confidence,
    evidence: args.response.evidence,
    reasoning: args.response.reasoning,
    zgReceipt: args.response.zgReceipt,
  };
}
