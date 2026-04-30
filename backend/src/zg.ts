/**
 * 0G Storage wrapper — KV (live state) + Log (history).
 *
 * Two modes:
 *  - REAL  : when ZG_RPC_URL + ZG_INDEXER_URL + ZG_KV_NODE_URL are set, uses
 *            @0glabs/0g-ts-sdk against the 0G testnet.
 *  - MOCK  : otherwise, uses an in-memory KV + log store and returns deterministic
 *            content URIs of the form `mock-0g://<sha256>`.
 *
 * The same surface area (`putKv`, `getKv`, `appendLog`, `getLog`, `pinJson`)
 * is used everywhere in the backend so callers don't care which mode is on.
 */

import * as crypto from "node:crypto";

export type ZgMode = "real" | "mock";

const ZG_RPC_URL      = process.env.ZG_RPC_URL      || "";
const ZG_INDEXER_URL  = process.env.ZG_INDEXER_URL  || "";
const ZG_KV_NODE_URL  = process.env.ZG_KV_NODE_URL  || "";
const ZG_FLOW_CONTRACT = process.env.ZG_FLOW_CONTRACT || "";
const ZG_STREAM_ID    = process.env.ZG_STREAM_ID    || "";
const ZG_PRIVATE_KEY  = process.env.ZG_PRIVATE_KEY  || process.env.COORDINATOR_PRIVATE_KEY || "";

export const zgMode: ZgMode =
  ZG_RPC_URL && ZG_INDEXER_URL && ZG_KV_NODE_URL && ZG_FLOW_CONTRACT && ZG_STREAM_ID && ZG_PRIVATE_KEY
    ? "real"
    : "mock";

// ---------- shared helpers --------------------------------------------------

function sha256Hex(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return crypto.createHash("sha256").update(b).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

// ---------- mock backend ----------------------------------------------------

class MockZgBackend {
  private kv = new Map<string, unknown>();
  private logs = new Map<string, unknown[]>();
  private pins = new Map<string, unknown>();

  async putKv(key: string, value: unknown) {
    this.kv.set(key, value);
  }
  async getKv<T = unknown>(key: string): Promise<T | null> {
    return (this.kv.get(key) as T) ?? null;
  }
  async appendLog(stream: string, entry: unknown) {
    if (!this.logs.has(stream)) this.logs.set(stream, []);
    this.logs.get(stream)!.push({ ts: nowIso(), ...((entry ?? {}) as object) });
  }
  async getLog<T = unknown>(stream: string, _range?: { from?: number; to?: number }): Promise<T[]> {
    return (this.logs.get(stream) as T[]) ?? [];
  }
  async pinJson(payload: unknown): Promise<string> {
    const json = JSON.stringify(payload);
    const hash = sha256Hex(json);
    this.pins.set(hash, payload);
    return `mock-0g://${hash}`;
  }
  async fetchPinned<T = unknown>(uri: string): Promise<T | null> {
    const hash = uri.replace(/^mock-0g:\/\//, "");
    return (this.pins.get(hash) as T) ?? null;
  }
}

// ---------- real backend (lazy-loaded) --------------------------------------

class RealZgBackend {
  private sdkPromise: Promise<any> | null = null;
  private indexer: any = null;
  private kvClient: any = null;
  private flowContract: any = null;
  private wallet: any = null;
  private streamId: string = ZG_STREAM_ID;

  private async sdk() {
    if (!this.sdkPromise) {
      this.sdkPromise = (async () => {
        // Dynamic import so the package is optional at install time.
        const sdk = await import("@0glabs/0g-ts-sdk").catch(() => null);
        const { ethers } = await import("ethers");
        if (!sdk) throw new Error("ZG real mode requires @0glabs/0g-ts-sdk");
        const provider = new ethers.JsonRpcProvider(ZG_RPC_URL);
        this.wallet = new ethers.Wallet(ZG_PRIVATE_KEY, provider);
        this.indexer = new (sdk as any).Indexer(ZG_INDEXER_URL);
        this.kvClient = new (sdk as any).KvClient(ZG_KV_NODE_URL);
        this.flowContract = (sdk as any).getFlowContract
          ? (sdk as any).getFlowContract(ZG_FLOW_CONTRACT, this.wallet)
          : new ethers.Contract(ZG_FLOW_CONTRACT, [], this.wallet);
        return sdk;
      })();
    }
    return this.sdkPromise;
  }

  private async batcher() {
    const sdk: any = await this.sdk();
    const [nodes, err] = await this.indexer.selectNodes(1);
    if (err) throw new Error(`0G indexer.selectNodes failed: ${err}`);
    return new sdk.Batcher(1, nodes, this.flowContract, ZG_RPC_URL);
  }

  async putKv(key: string, value: unknown) {
    const batcher = await this.batcher();
    const k = Buffer.from(key, "utf-8");
    const v = Buffer.from(JSON.stringify(value), "utf-8");
    batcher.streamDataBuilder.set(this.streamId, k, v);
    const [, err] = await batcher.exec();
    if (err) throw new Error(`0G KV put failed: ${err}`);
  }
  async getKv<T = unknown>(key: string): Promise<T | null> {
    const { ethers } = await import("ethers");
    const k = Buffer.from(key, "utf-8");
    const raw = await this.kvClient.getValue(this.streamId, ethers.encodeBase64(k));
    if (!raw) return null;
    try {
      return JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as T;
    } catch {
      return raw as T;
    }
  }
  async appendLog(stream: string, entry: unknown) {
    // Logs are encoded as KV writes under `${stream}:${ts}`.
    const ts = Date.now();
    await this.putKv(`${stream}:${ts}`, { ts: nowIso(), ...((entry ?? {}) as object) });
  }
  async getLog<T = unknown>(_stream: string): Promise<T[]> {
    // Range scan support is provider-specific; for the hackathon callers should
    // also keep a local cache. Return [] in real mode if unsupported.
    return [];
  }
  async pinJson(payload: unknown): Promise<string> {
    const sdk: any = await this.sdk();
    const { ethers } = await import("ethers");
    const json = JSON.stringify(payload);
    const blob = new (sdk as any).Blob(Buffer.from(json, "utf-8"));
    const [tree, treeErr] = await blob.merkleTree();
    if (treeErr) throw new Error(`0G blob merkleTree: ${treeErr}`);
    const [tx, uploadErr] = await this.indexer.upload(blob, ZG_RPC_URL, this.wallet);
    if (uploadErr) throw new Error(`0G upload: ${uploadErr}`);
    void ethers; // keep import
    void tx;
    const root = tree.rootHash();
    return `0g://${root}`;
  }
  async fetchPinned<T = unknown>(_uri: string): Promise<T | null> {
    return null; // download requires the indexer; coordinator already has the bundle in memory.
  }
}

// ---------- public surface --------------------------------------------------

const backend = zgMode === "real" ? new RealZgBackend() : new MockZgBackend();

export async function putKv(key: string, value: unknown) {
  return backend.putKv(key, value);
}
export async function getKv<T = unknown>(key: string): Promise<T | null> {
  return backend.getKv<T>(key);
}
export async function appendLog(stream: string, entry: unknown) {
  return backend.appendLog(stream, entry);
}
export async function getLog<T = unknown>(stream: string): Promise<T[]> {
  return backend.getLog<T>(stream);
}
export async function pinJson(payload: unknown): Promise<string> {
  return backend.pinJson(payload);
}
export async function fetchPinned<T = unknown>(uri: string): Promise<T | null> {
  return backend.fetchPinned<T>(uri);
}

// ---------- canonical KV / Log keys (mirrors ARCHITECTURE.md §4.4) ---------

export const ZgKeys = {
  oracleReputation: (ens: string) => `oracle:${ens}:reputation`,
  oracleState:      (ens: string) => `oracle:${ens}:state`,
  claimStatus:      (id: string | number | bigint) => `claim:${id.toString()}:status`,
  claimAgentSet:    (id: string | number | bigint) => `claim:${id.toString()}:agent_set`,
  swarmActiveSet:   () => `swarm:active_set`,
  consensusThresholds: () => `consensus:thresholds`,
};

export const ZgStreams = {
  claimEvents:        (id: string | number | bigint) => `claim:${id.toString()}:events`,
  claimAgentResponses: (id: string | number | bigint) => `claim:${id.toString()}:agent_responses`,
  claimConsensusTrace: (id: string | number | bigint) => `claim:${id.toString()}:consensus_trace`,
  oracleHistory:       (ens: string) => `oracle:${ens}:history`,
  oracleUpgrades:      (ens: string) => `oracle:${ens}:upgrades`,
};
