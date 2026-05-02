/**
 * Dynamic agent registry.
 *
 * On boot, walks all OracleINFT tokens, fetches each manifest from 0G Storage
 * (whatever URI scheme `bundleUri` uses — `0g://`, `https://`, or `mock-0g://`),
 * and indexes them by `capability` for fast `pickAgentSet(spec.kind)` lookups.
 *
 * Refreshes on `Minted` / `Upgraded` events so newly registered agents become
 * dispatchable without a coordinator restart.
 *
 * If a token's `bundleUri` is a placeholder (no fetchable manifest) we still
 * keep it in the index using the **fallback map** keyed by `ens`, so existing
 * starter-swarm deployments keep working until they migrate to a real manifest.
 */

import { ethers } from "ethers";
import { fetchPinned } from "./zg.js";
import {
  AgentManifest,
  AgentManifestSchema,
  RegistryEntry,
} from "./types.js";

const INFT_ABI = [
  "function nextTokenId() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function reputationOf(uint256) view returns (int256)",
  "function oracles(uint256) view returns (string ens, string bundleUri, bytes32 bundleHash, uint64 version, bytes capabilities)",
  "event Minted(uint256 indexed tokenId, address indexed owner, string ens, string bundleUri, bytes32 bundleHash)",
  "event Upgraded(uint256 indexed tokenId, uint64 newVersion, string newBundleUri, bytes32 newBundleHash)",
  "event ReputationBumped(uint256 indexed tokenId, int256 delta, int256 newScore, uint256 indexed claimId)",
];

export type EnvFallback = {
  /** ens (e.g. `github.veritas.eth`) -> manifest used when bundleUri can't be fetched */
  byEns: Map<string, AgentManifest>;
};

export class AgentRegistry {
  private byTokenId = new Map<string, RegistryEntry>();
  private byCapability = new Map<string, RegistryEntry[]>();
  private contract: ethers.Contract | null = null;
  private fallback: EnvFallback;
  private ready: Promise<void> | null = null;

  constructor(fallback: EnvFallback) {
    this.fallback = fallback;
  }

  attach(provider: ethers.Provider | null, address: string | undefined) {
    if (!provider || !address) return;
    this.contract = new ethers.Contract(address, INFT_ABI, provider);
    this.ready = this.refresh().catch((e) => {
      console.warn(`registry initial refresh failed: ${(e as Error).message}`);
    });
    this.contract.on("Minted", () => {
      this.refresh().catch((e) => console.warn(`registry refresh (Minted) failed: ${e}`));
    });
    this.contract.on("Upgraded", () => {
      this.refresh().catch((e) => console.warn(`registry refresh (Upgraded) failed: ${e}`));
    });
    this.contract.on("ReputationBumped", (tokenId: bigint, _delta: bigint, newScore: bigint) => {
      const e = this.byTokenId.get(tokenId.toString());
      if (e) e.reputation = Number(newScore);
    });
  }

  /** Wait for the initial chain scan (no-op if no chain attached). */
  async whenReady() {
    if (this.ready) await this.ready;
  }

  /** Pick top-N entries that can answer the given `spec.kind`. */
  pickFor(capability: string, n = 2): RegistryEntry[] {
    const candidates = this.byCapability.get(capability) ?? [];
    return [...candidates]
      .sort((a, b) => b.reputation - a.reputation)
      .slice(0, n);
  }

  /** All entries (for the explorer / health endpoints). */
  list(): RegistryEntry[] {
    return [...this.byTokenId.values()];
  }

  byTokenIdLookup(tokenId: bigint): RegistryEntry | undefined {
    return this.byTokenId.get(tokenId.toString());
  }

  async refresh() {
    if (!this.contract) return;
    const next: bigint = await this.contract.nextTokenId();
    const tasks: Promise<RegistryEntry | null>[] = [];
    for (let i = 1n; i < next; i++) tasks.push(this.loadOne(i));
    const settled = await Promise.all(tasks);

    this.byTokenId = new Map();
    this.byCapability = new Map();
    for (const e of settled) {
      if (!e) continue;
      this.byTokenId.set(e.tokenId.toString(), e);
      for (const cap of e.manifest.capabilities) {
        const arr = this.byCapability.get(cap) ?? [];
        arr.push(e);
        this.byCapability.set(cap, arr);
      }
    }
  }

  private async loadOne(tokenId: bigint): Promise<RegistryEntry | null> {
    if (!this.contract) return null;
    let owner = "0x0000000000000000000000000000000000000000";
    let onchain: any;
    let reputation = 0;
    try {
      owner = await this.contract.ownerOf(tokenId);
      onchain = await this.contract.oracles(tokenId);
      reputation = Number(await this.contract.reputationOf(tokenId));
    } catch {
      return null;
    }
    if (!owner || owner === "0x0000000000000000000000000000000000000000") return null;

    const ens: string = onchain.ens;
    const bundleUri: string = onchain.bundleUri;
    const version = Number(onchain.version);

    const manifest = await this.resolveManifest(ens, bundleUri);
    if (!manifest) return null;

    return {
      tokenId,
      ens,
      owner: owner as `0x${string}`,
      version,
      bundleUri,
      reputation,
      manifest,
    };
  }

  private async resolveManifest(ens: string, bundleUri: string): Promise<AgentManifest | null> {
    // 1) fetchable manifest (0g:// or https://)
    if (bundleUri && (bundleUri.startsWith("0g://") || bundleUri.startsWith("http"))) {
      try {
        const raw = await fetchPinned<unknown>(bundleUri);
        if (raw) {
          const parsed = AgentManifestSchema.safeParse(raw);
          if (parsed.success) return parsed.data;
          console.warn(`manifest at ${bundleUri} (${ens}) failed schema: ${parsed.error.message}`);
        }
      } catch (e) {
        console.warn(`manifest fetch failed for ${ens}: ${(e as Error).message}`);
      }
    }
    // 2) env fallback by ens
    return this.fallback.byEns.get(ens) ?? null;
  }
}

/**
 * Build the env fallback map from `AGENT_ENDPOINTS` so existing GitHub /
 * Snapshot / Auditor agents keep working before they have real manifests.
 *
 * Format: `AGENT_ENDPOINTS=github=http://localhost:8801,snapshot=http://localhost:8802`
 *
 * `capabilities` come from a sibling `AGENT_CAPABILITIES` env var:
 *   AGENT_CAPABILITIES=github=github_pr_merged_before,snapshot=snapshot_proposal_passed
 */
export function envFallback(): EnvFallback {
  const endpoints = parseKvList(process.env.AGENT_ENDPOINTS ?? "");
  const caps = parseKvList(process.env.AGENT_CAPABILITIES ?? "");
  const byEns = new Map<string, AgentManifest>();

  for (const [name, endpoint] of endpoints) {
    const ens = `${name}.veritas.eth`;
    const capability = caps.get(name) ?? defaultCapabilityFor(name);
    if (!capability) continue;
    byEns.set(ens, {
      schema: "veritas.agent.v1",
      name,
      displayName: name,
      endpoint,
      capabilities: capability.split("|"),
      signer: "0x0000000000000000000000000000000000000000",
      version: "fallback",
      description: "env-fallback manifest (no on-chain JSON)",
    });
  }
  return { byEns };
}

function parseKvList(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

function defaultCapabilityFor(name: string): string | null {
  switch (name) {
    case "github": return "github_pr_merged_before";
    case "snapshot": return "snapshot_proposal_passed";
    case "auditor": return "critic";
    default: return null;
  }
}
