import { z } from "zod";

// ---------- Outcome ----------------------------------------------------------

export const OutcomeSchema = z.enum(["NO", "YES", "INVALID", "ESCALATE"]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export function outcomeToEnum(outcome: Outcome): number {
  // Must match VeritasOracle.Outcome order.
  switch (outcome) {
    case "NO": return 0;
    case "YES": return 1;
    case "INVALID": return 2;
    case "ESCALATE": return 3;
  }
}

export function enumToOutcome(value: number | bigint): Outcome {
  const n = typeof value === "bigint" ? Number(value) : value;
  return (["NO", "YES", "INVALID", "ESCALATE"] as const)[n] ?? "INVALID";
}

// ---------- Claim spec -------------------------------------------------------

export const ClaimSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github_pr_merged_before"),
    repo: z.string().min(1),
    prNumber: z.number().int().positive(),
    deadlineIso: z.string().min(1),
  }),
  z.object({
    kind: z.literal("snapshot_proposal_passed"),
    space: z.string().min(1),
    proposalId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("token_price_target"),
    chainId: z.string().min(1),
    tokenAddress: z.string().min(1),
    targetPriceUsd: z.number().positive(),
    direction: z.enum(["above", "below"]).default("above"),
    deadlineIso: z.string().min(1),
  }),
]);
export type ClaimSpec = z.infer<typeof ClaimSpecSchema>;

// ---------- Agent I/O --------------------------------------------------------

export const AgentRequestSchema = z.object({
  claimId: z.number().int().positive().optional(),
  text: z.string().min(1),
  spec: ClaimSpecSchema,
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const EvidenceItemSchema = z.object({
  type: z.string().min(1),
  uri: z.string().min(1),
  note: z.string().optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const AgentResponseSchema = z.object({
  agent: z.string().min(1),
  resolvable: z.boolean(),
  outcome: OutcomeSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceItemSchema).default([]),
  reasoning: z.string().min(1),
  /** Optional 0G Compute inference receipt id (when running on 0G Compute). */
  zgReceipt: z.string().optional(),
  /** Optional iNFT identity attached by the coordinator after dispatch. */
  identity: z
    .object({
      tokenId: z.union([z.bigint(), z.number()]).transform((v) => BigInt(v)),
      ens: z.string(),
      version: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

// ---------- Signed votes (AXL payload) --------------------------------------

export type SignedVote = {
  tokenId: bigint;
  claimId: bigint;
  resolvable: boolean;
  outcome: Outcome;
  confidence: number;
  evidence: EvidenceItem[];
  reasoning: string;
  zgReceipt?: string;
  /** EIP-191 signature over the vote payload by the iNFT owner key. */
  sig: `0x${string}`;
  signer: `0x${string}`;
  voteHash: `0x${string}`;
};

export type CriticVerdict = {
  verdict: "confirm" | "flip" | "escalate";
  reasoning: string;
  zgReceipt?: string;
  signer?: `0x${string}`;
  sig?: `0x${string}`;
};

// ---------- Oracle identity (mirrors OracleINFT) ----------------------------

export type OracleIdentity = {
  tokenId: bigint;
  ens: string;
  version: number;
  bundleUri?: string;
  reputation?: number;
};

// ---------- Agent manifest (pinned to 0G Storage) ---------------------------
//
// Every oracle iNFT points (via `bundleUri`) at a JSON document matching this
// schema. The coordinator fetches the manifest at registry-load time so it can
// dispatch claims to live HTTP endpoints based on declared capabilities.

export const AgentManifestSchema = z.object({
  schema: z.literal("veritas.agent.v1"),
  /** short slug; ENS will be `${name}.veritas.eth` */
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/i, "lowercase alphanum + dashes"),
  displayName: z.string().min(1).optional(),
  /** HTTPS endpoint that exposes POST /verify (and GET /health). */
  endpoint: z.string().url(),
  /** Claim-spec kinds this agent can answer (matches `ClaimSpec.kind`). */
  capabilities: z.array(z.string().min(1)).min(1),
  description: z.string().optional(),
  /** Address of the key the agent will sign AgentResponses with (future use). */
  signer: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  version: z.string().min(1),
  /** Optional auth header passed by the coordinator when calling the endpoint. */
  authHeader: z.string().optional(),
  /** Free-form extra metadata. */
  extra: z.record(z.unknown()).optional(),
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

/** A live registry entry: on-chain identity joined with off-chain manifest. */
export type RegistryEntry = {
  tokenId: bigint;
  ens: string;
  owner: `0x${string}`;
  version: number;
  bundleUri: string;
  reputation: number;
  manifest: AgentManifest;
};

// ---------- Final proof bundle (pinned to 0G Storage) -----------------------

export type ProofBundle = {
  claimId: string;            // string for JSON portability
  request: { text: string; spec: ClaimSpec };
  votes: Array<Omit<SignedVote, "tokenId" | "claimId"> & { tokenId: string; claimId: string }>;
  critic?: CriticVerdict;
  consensus: {
    resolvable: boolean;
    outcome: Outcome;
    confidence: number;
    agreement: number;
    thresholds: { resolvability: number; agreement: number };
    notes: string;
  };
  participants: { tokenId: string; ens: string; agreed: boolean }[];
  decidedAtIso: string;
};
