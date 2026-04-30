/**
 * OracleINFT contract bindings.
 *
 * Resolves agent-name (e.g. "github") -> tokenId via the on-chain ENS hash map,
 * with a local override map (ORACLE_TOKEN_IDS env) so the system runs even when
 * no chain is reachable (mock dev loop). Reputation reads also fall back.
 */

import { ethers } from "ethers";
import type { OracleIdentity } from "./types.js";

const INFT_ABI = [
  "function tokenIdByEnsHash(bytes32) view returns (uint256)",
  "function reputationOf(uint256) view returns (int256)",
  "function oracles(uint256) view returns (string ens, string bundleUri, bytes32 bundleHash, uint64 version, bytes capabilities)",
  "function ownerOf(uint256) view returns (address)",
];

let contract: ethers.Contract | null = null;

export function setupINFT(provider: ethers.Provider | null, address: string | undefined) {
  if (!provider || !address) return;
  contract = new ethers.Contract(address, INFT_ABI, provider);
}

/**
 * Map agent name (`github`, `snapshot`, `auditor`, ...) to its on-chain ENS
 * (`github.veritas.eth`, ...). Override per-deployment via env if needed.
 */
export function ensForAgent(name: string): string {
  return `${name}.veritas.eth`;
}

function ensHash(ens: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(ens));
}

/** Optional local override: ORACLE_TOKEN_IDS=github:1,snapshot:2,auditor:3 */
function envTokenIdMap(): Map<string, bigint> {
  const raw = process.env.ORACLE_TOKEN_IDS || "";
  const out = new Map<string, bigint>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = pair.split(":");
    if (k && v) out.set(k.trim(), BigInt(v.trim()));
  }
  return out;
}

const overrideMap = envTokenIdMap();

const identityCache = new Map<string, OracleIdentity>();

export async function identityFor(agentName: string): Promise<OracleIdentity> {
  if (identityCache.has(agentName)) return identityCache.get(agentName)!;

  const ens = ensForAgent(agentName);
  let tokenId: bigint = overrideMap.get(agentName) ?? 0n;
  let version = 1;

  if (contract && tokenId === 0n) {
    try {
      const id: bigint = await contract.tokenIdByEnsHash(ensHash(ens));
      tokenId = id;
    } catch {
      // chain unreachable; fall through with tokenId=0
    }
  }
  if (contract && tokenId !== 0n) {
    try {
      const o = await contract.oracles(tokenId);
      version = Number(o.version);
    } catch {
      // ignore
    }
  }

  // Synthetic tokenId so mock runs still produce stable signatures.
  if (tokenId === 0n) {
    tokenId = BigInt("0x" + ethers.keccak256(ethers.toUtf8Bytes(ens)).slice(2, 10));
  }

  const identity: OracleIdentity = { tokenId, ens, version };
  identityCache.set(agentName, identity);
  return identity;
}

export async function reputationOf(tokenId: bigint): Promise<number> {
  if (!contract) return 0;
  try {
    const r: bigint = await contract.reputationOf(tokenId);
    return Number(r);
  } catch {
    return 0;
  }
}
