/**
 * 0G Compute wrapper — verifiable inference + receipt.
 *
 * Two modes:
 *  - REAL : when ZG_COMPUTE_PROVIDER + ZG_RPC_URL + a private key are set,
 *           uses @0glabs/0g-serving-broker to call a 0G Compute provider with
 *           OpenAI-compatible chat completions. Returns the broker's auth
 *           headers as the "receipt".
 *  - MOCK : otherwise, deterministically hashes the input and returns a stub
 *           output + a `mock-zgc://<sha256>` receipt id, so the rest of the
 *           pipeline can still build a proof bundle.
 */

import * as crypto from "node:crypto";

export type ZgComputeMode = "real" | "mock";

export type ZgInferenceRequest = {
  /** Free-form system+user prompt. */
  prompt: string;
  /** Optional model hint; ignored in mock mode. */
  model?: string;
  /** Optional temperature (0..1). */
  temperature?: number;
};

export type ZgInferenceResult = {
  output: string;
  receipt: string;       // 0G Compute job id / hash
  model: string;
  provider: string;
  inputHashHex: string;  // sha256 of the prompt
  outputHashHex: string; // sha256 of the output
};

const ZG_COMPUTE_PROVIDER = process.env.ZG_COMPUTE_PROVIDER || "";
const ZG_RPC_URL = process.env.ZG_RPC_URL || "";
const ZG_PRIVATE_KEY = process.env.ZG_PRIVATE_KEY || process.env.COORDINATOR_PRIVATE_KEY || "";

export const zgComputeMode: ZgComputeMode =
  ZG_COMPUTE_PROVIDER && ZG_RPC_URL && ZG_PRIVATE_KEY ? "real" : "mock";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ---------- mock backend ----------------------------------------------------

function mockInfer(req: ZgInferenceRequest): ZgInferenceResult {
  const inputHashHex = sha256Hex(req.prompt);
  // Deterministic stub: pretend the model said "STUB" + first 8 chars of hash.
  const output = `MOCK_INFERENCE[${inputHashHex.slice(0, 8)}]`;
  const outputHashHex = sha256Hex(output);
  return {
    output,
    receipt: `mock-zgc://${sha256Hex(inputHashHex + outputHashHex)}`,
    model: req.model ?? "mock-llm-v0",
    provider: "mock-provider",
    inputHashHex,
    outputHashHex,
  };
}

// ---------- real backend (lazy-loaded) --------------------------------------

let brokerPromise: Promise<any> | null = null;
async function getBroker() {
  if (!brokerPromise) {
    brokerPromise = (async () => {
      const mod = await import("@0glabs/0g-serving-broker").catch(() => null);
      if (!mod) throw new Error("ZG Compute real mode requires @0glabs/0g-serving-broker");
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider(ZG_RPC_URL);
      const wallet = new ethers.Wallet(ZG_PRIVATE_KEY, provider);
      const broker = await (mod as any).createZGComputeNetworkBroker(wallet);
      try {
        await broker.inference.acknowledgeProviderSigner(ZG_COMPUTE_PROVIDER);
      } catch {
        // already acknowledged in a prior session
      }
      return broker;
    })();
  }
  return brokerPromise;
}

async function realInfer(req: ZgInferenceRequest): Promise<ZgInferenceResult> {
  const broker = await getBroker();
  const meta = await broker.inference.getServiceMetadata(ZG_COMPUTE_PROVIDER);
  const headers = await broker.inference.getRequestHeaders(ZG_COMPUTE_PROVIDER);

  const body = {
    model: req.model ?? meta.model,
    messages: [{ role: "user", content: req.prompt }],
    temperature: req.temperature ?? 0.0,
  };

  const res = await fetch(`${meta.endpoint}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`0G Compute inference failed ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  const output: string = json.choices?.[0]?.message?.content ?? "";

  const inputHashHex = sha256Hex(req.prompt);
  const outputHashHex = sha256Hex(output);
  const receipt: string =
    json.id || (headers as any)["X-Verifiable-Trace-Id"] || `0g-zgc://${sha256Hex(inputHashHex + outputHashHex)}`;

  return {
    output,
    receipt,
    model: body.model,
    provider: ZG_COMPUTE_PROVIDER,
    inputHashHex,
    outputHashHex,
  };
}

export async function infer(req: ZgInferenceRequest): Promise<ZgInferenceResult> {
  return zgComputeMode === "real" ? realInfer(req) : mockInfer(req);
}
