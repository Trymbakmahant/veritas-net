/**
 * 0G Storage wrapper — KV (live state) + Log (history).
 *
 * Two modes:
 *  - REAL (blob): ZG_RPC_URL + ZG_INDEXER_URL + ZG_PRIVATE_KEY — proof bundles use
 *                indexer.upload (same path as official 0G file storage; visible on Storage Scan).
 *                Does NOT require ZG_STREAM_ID.
 *  - REAL (KV):   additionally ZG_KV_NODE_URL + ZG_FLOW_CONTRACT + ZG_STREAM_ID —
 *                live KV + logs on-chain streams (needs write permission for that stream id).
 *  - MOCK:       nothing set → in-memory KV + logs + mock-0g:// proof URIs.
 *
 * The same surface area (`putKv`, `getKv`, `appendLog`, `getLog`, `pinJson`)
 * is used everywhere in the backend so callers don't care which mode is on.
 */

import * as crypto from "node:crypto";

export type ZgMode = "real" | "mock";

const ZG_RPC_URL      = (process.env.ZG_RPC_URL      ?? "").trim();
const ZG_INDEXER_URL  = (process.env.ZG_INDEXER_URL  ?? "").trim();
const ZG_KV_NODE_URL  = (process.env.ZG_KV_NODE_URL  ?? "").trim();
const ZG_FLOW_CONTRACT = (process.env.ZG_FLOW_CONTRACT ?? "").trim();
const ZG_STREAM_ID    = (process.env.ZG_STREAM_ID    ?? "").trim();
const ZG_PRIVATE_KEY  = (process.env.ZG_PRIVATE_KEY ?? process.env.COORDINATOR_PRIVATE_KEY ?? "").trim();

/** True when proofs can hit real 0G Storage via indexer.upload (turbo indexer URL). */
const zgBlobReal = !!(ZG_RPC_URL && ZG_INDEXER_URL && ZG_PRIVATE_KEY);

/** True when KV + appendLog use on-chain KV batches (requires stream write permission). */
export const zgKvReal =
  !!(zgBlobReal && ZG_KV_NODE_URL && ZG_FLOW_CONTRACT && ZG_STREAM_ID);

export const zgMode: ZgMode = zgBlobReal ? "real" : "mock";

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

// ---------- real blob + optional KV (lazy-loaded) -----------------------------

class HybridZgBackend {
  /** In-memory KV/logs when blob storage is live but KV stream is unavailable / not configured. */
  private kvFallback = new MockZgBackend();
  private sdkPromise: Promise<any> | null = null;
  private indexer: any = null;
  private kvClient: any = null;
  private flowContract: any = null;
  private wallet: any = null;
  private streamId: string = ZG_STREAM_ID;

  private async sdk() {
    if (!this.sdkPromise) {
      this.sdkPromise = (async () => {
        const sdk = await import("@0gfoundation/0g-ts-sdk").catch(() => null);
        const { ethers } = await import("ethers");
        if (!sdk) throw new Error("ZG real mode requires @0gfoundation/0g-ts-sdk");
        const provider = new ethers.JsonRpcProvider(ZG_RPC_URL);
        this.wallet = new ethers.Wallet(ZG_PRIVATE_KEY, provider);
        this.indexer = new (sdk as any).Indexer(ZG_INDEXER_URL);
        if (zgKvReal) {
          this.kvClient = new (sdk as any).KvClient(ZG_KV_NODE_URL);
          this.flowContract = (sdk as any).getFlowContract
            ? (sdk as any).getFlowContract(ZG_FLOW_CONTRACT, this.wallet)
            : new ethers.Contract(ZG_FLOW_CONTRACT, [], this.wallet);
        }
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
    if (!zgKvReal) return this.kvFallback.putKv(key, value);
    const batcher = await this.batcher();
    const k = Buffer.from(key, "utf-8");
    const v = Buffer.from(JSON.stringify(value), "utf-8");
    batcher.streamDataBuilder.set(this.streamId, k, v);
    const [, err] = await batcher.exec();
    if (err) throw new Error(`0G KV put failed: ${err}`);
  }

  async getKv<T = unknown>(key: string): Promise<T | null> {
    if (!zgKvReal) return this.kvFallback.getKv<T>(key);
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
    if (!zgKvReal) return this.kvFallback.appendLog(stream, entry);
    const ts = Date.now();
    await this.putKv(`${stream}:${ts}`, { ts: nowIso(), ...((entry ?? {}) as object) });
  }

  async getLog<T = unknown>(stream: string, range?: { from?: number; to?: number }): Promise<T[]> {
    if (!zgKvReal) return this.kvFallback.getLog<T>(stream, range);
    void range;
    return [];
  }

  async pinJson(payload: unknown): Promise<string> {
    const sdk: any = await this.sdk();
    const json = JSON.stringify(payload);
    const buf = Buffer.from(json, "utf-8");
    const file =
      sdk.MemData != null ? new sdk.MemData(buf) : new sdk.Blob(buf);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr) throw new Error(`0G blob merkleTree: ${treeErr}`);
    const [tx, uploadErr] = await this.indexer.upload(file, ZG_RPC_URL, this.wallet);
    if (uploadErr) throw new Error(`0G upload: ${uploadErr}`);
    void tx;
    try {
      await file.close?.();
    } catch {
      /* optional */
    }
    const root = tree.rootHash();
    return `0g://${root}`;
  }

  async fetchPinned<T = unknown>(_uri: string): Promise<T | null> {
    return null;
  }
}

// ---------- public surface --------------------------------------------------

const backend = zgBlobReal ? new HybridZgBackend() : new MockZgBackend();

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
