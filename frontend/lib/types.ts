export type Health = {
  ok: boolean;
  modes: { axl: string; zgStorage: string; zgKv: string; zgCompute: string };
  onChain: boolean;
  registeredAgents: number;
};

export type Manifest = {
  schema: "veritas.agent.v1";
  name: string;
  displayName?: string;
  endpoint: string;
  capabilities: string[];
  description?: string;
  signer: string;
  version: string;
  authHeader?: string;
  extra?: Record<string, unknown>;
};

export type AgentEntry = {
  tokenId: string;
  ens: string;
  owner: string;
  version: number;
  reputation: number;
  bundleUri: string;
  manifest: Pick<Manifest, "name" | "displayName" | "endpoint" | "capabilities" | "version" | "description" | "signer">;
};

export type Claim = {
  claimId: string;
  requester: string;
  resolveBy: string;
  resolvedAt: string;
  outcome: "NO" | "YES" | "INVALID" | "ESCALATE";
  proofUri: string;
  consumer: string;
  text: string;
  spec: string;
};

export type Config = {
  chainId: string | null;
  rpcUrl: string | null;
  contracts: { OracleINFT: string | null; VeritasOracle: string | null };
  modes: { axl: string; zgStorage: string; zgKv: string; zgCompute: string };
};
