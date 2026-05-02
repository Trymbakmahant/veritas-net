/**
 * 0G Storage smoke test (blob + optional KV).
 *
 * Blob: ZG_RPC_URL + ZG_INDEXER_URL + ZG_PRIVATE_KEY → `pinJson()` = indexer.upload (check root on Storage Scan).
 * KV (optional): also set ZG_KV_NODE_URL + ZG_FLOW_CONTRACT + ZG_STREAM_ID (+ write permission for stream).
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/zg-kv-smoke.ts
 */

import "dotenv/config";
import { pinJson, putKv, zgKvReal, zgMode } from "../src/zg.js";

async function main() {
  console.log("zgMode (blob):", zgMode, "| zgKvReal:", zgKvReal);
  if (zgMode !== "real") {
    throw new Error("Set ZG_RPC_URL, ZG_INDEXER_URL, and ZG_PRIVATE_KEY (or COORDINATOR_PRIVATE_KEY)");
  }

  const proofUri = await pinJson({ smoke: "veritas-zg-blob", ts: Date.now() });
  console.log("Blob pinJson OK:", proofUri);

  if (zgKvReal) {
    await putKv(`smoke:${Date.now()}`, { ok: true });
    console.log("KV put OK.");
  } else {
    console.log("KV skipped — leave ZG_STREAM_ID empty for blob-only proofs, or fill all KV_* for on-chain KV.");
  }
}

main().catch((e) => {
  console.error("Smoke FAILED:", e?.message ?? e);
  process.exit(1);
});
