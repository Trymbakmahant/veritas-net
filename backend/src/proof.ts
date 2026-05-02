import { ethers } from "ethers";
import {
  AgentRequest,
  CriticVerdict,
  Outcome,
  ProofBundle,
  SignedVote,
} from "./types.js";
import { appendLog, pinJson, putKv, ZgKeys, ZgStreams } from "./zg.js";

const SIG_DOMAIN = "veritas.vote.v1";

export function voteHash(input: {
  domain: string;
  tokenId: bigint;
  claimId: bigint;
  outcome: Outcome;
  resolvable: boolean;
  confidence: number;
  reasoning: string;
}): `0x${string}` {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "uint256", "uint256", "string", "bool", "uint256", "string"],
    [
      input.domain,
      input.tokenId,
      input.claimId,
      input.outcome,
      input.resolvable,
      Math.round(input.confidence * 1e6),
      input.reasoning,
    ],
  );
  return ethers.keccak256(encoded) as `0x${string}`;
}

/**
 * Sign a vote with the iNFT owner key (or coordinator key in mock mode).
 */
export async function signVote(args: {
  signer: ethers.Signer;
  tokenId: bigint;
  claimId: bigint;
  outcome: Outcome;
  resolvable: boolean;
  confidence: number;
  reasoning: string;
  evidence: SignedVote["evidence"];
  zgReceipt?: string;
}): Promise<SignedVote> {
  const hash = voteHash({
    domain: SIG_DOMAIN,
    tokenId: args.tokenId,
    claimId: args.claimId,
    outcome: args.outcome,
    resolvable: args.resolvable,
    confidence: args.confidence,
    reasoning: args.reasoning,
  });
  const sig = (await args.signer.signMessage(ethers.getBytes(hash))) as `0x${string}`;
  const addr = await args.signer.getAddress();
  return {
    tokenId: args.tokenId,
    claimId: args.claimId,
    outcome: args.outcome,
    resolvable: args.resolvable,
    confidence: args.confidence,
    reasoning: args.reasoning,
    evidence: args.evidence,
    zgReceipt: args.zgReceipt,
    sig,
    signer: addr as `0x${string}`,
    voteHash: hash,
  };
}

export function verifyVote(v: SignedVote): boolean {
  const hash = voteHash({
    domain: SIG_DOMAIN,
    tokenId: v.tokenId,
    claimId: v.claimId,
    outcome: v.outcome,
    resolvable: v.resolvable,
    confidence: v.confidence,
    reasoning: v.reasoning,
  });
  if (hash !== v.voteHash) return false;
  try {
    const recovered = ethers.verifyMessage(ethers.getBytes(hash), v.sig);
    return recovered.toLowerCase() === v.signer.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Build a ProofBundle, append to the 0G Log streams, snapshot KV state,
 * and pin the bundle JSON to 0G Storage. Returns the proofUri suitable for
 * `VeritasOracle.resolveClaim(...)`.
 */
export async function buildAndPinProof(args: {
  request: AgentRequest;
  votes: SignedVote[];
  critic?: CriticVerdict;
  consensus: ProofBundle["consensus"];
  participants: ProofBundle["participants"];
}): Promise<{ proofUri: string; bundle: ProofBundle }> {
  const claimIdStr = args.votes[0]?.claimId.toString() ?? "0";

  const bundle: ProofBundle = {
    claimId: claimIdStr,
    request: { text: args.request.text, spec: args.request.spec },
    votes: args.votes.map((v) => ({
      ...v,
      tokenId: v.tokenId.toString(),
      claimId: v.claimId.toString(),
    })),
    critic: args.critic,
    consensus: args.consensus,
    participants: args.participants,
    decidedAtIso: new Date().toISOString(),
  };

  // Append-only history.
  await appendLog(ZgStreams.claimEvents(claimIdStr), {
    kind: "resolved",
    outcome: args.consensus.outcome,
  });
  for (const v of bundle.votes) {
    await appendLog(ZgStreams.claimAgentResponses(claimIdStr), v);
  }
  await appendLog(ZgStreams.claimConsensusTrace(claimIdStr), args.consensus);

  // Per-oracle history (agreement with final outcome).
  for (const p of args.participants) {
    await appendLog(ZgStreams.oracleHistory(p.ens), {
      claimId: claimIdStr,
      finalOutcome: args.consensus.outcome,
      agreed: p.agreed,
    });
  }

  // Live KV snapshot.
  await putKv(ZgKeys.claimStatus(claimIdStr), "resolved");
  await putKv(ZgKeys.claimAgentSet(claimIdStr), args.participants.map((p) => p.tokenId));

  const proofUri = await pinJson(bundle);
  return { proofUri, bundle };
}
