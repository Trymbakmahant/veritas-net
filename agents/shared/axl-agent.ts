/**
 * Shared AXL runtime for standalone oracle agents.
 *
 * If AXL_HTTP_URL is unset, this module is a no-op and the agent continues to
 * work as a plain HTTP service. When set, it subscribes to the coordinator's
 * `veritas/claim/dispatch` channel and publishes `agent_response` messages to
 * `veritas/vote/<claimId>`.
 */

export type AgentResponse = {
  agent: string;
  resolvable: boolean;
  outcome: "NO" | "YES" | "INVALID" | "ESCALATE";
  confidence: number;
  evidence: Array<{ type: string; uri: string; note?: string }>;
  reasoning: string;
  zgReceipt?: string;
};

export type AgentRequest = {
  claimId?: number;
  text: string;
  spec: { kind: string; [key: string]: unknown };
};

type VerifyFn = (req: AgentRequest, meta: { from?: string }) => Promise<AgentResponse>;

type RuntimeOpts = {
  agentName: string;
  capabilities: string[];
  verify: VerifyFn;
};

const AXL_HTTP_URL = (process.env.AXL_HTTP_URL ?? "").trim();
const AXL_PEER_ID = (process.env.AXL_PEER_ID ?? "").trim();
const AXL_API_KEY = (process.env.AXL_API_KEY ?? "").trim();
const AXL_SEND_PATH = (process.env.AXL_SEND_PATH ?? "/axl/send").trim();
const AXL_SUBSCRIBE_PATH = (process.env.AXL_SUBSCRIBE_PATH ?? "/axl/subscribe").trim();
const AXL_AGENT_RECONNECT_MS = Number(process.env.AXL_AGENT_RECONNECT_MS ?? "1500");

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(extra ?? {}),
    ...(AXL_API_KEY ? { authorization: `Bearer ${AXL_API_KEY}` } : {}),
    "x-veritas-peer-id": AXL_PEER_ID,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(raw: string): any | null {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

function parseStream(input: string): { messages: any[]; rest: string } {
  const messages: any[] = [];
  let rest = input;
  while (rest.includes("\n\n") || rest.includes("\r\n\r\n")) {
    const sep = rest.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
    const idx = rest.indexOf(sep);
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + sep.length);
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    const msg = parseJson(data || frame);
    if (msg) messages.push(msg);
  }
  const lines = rest.split(/\r?\n/);
  rest = lines.pop() ?? "";
  for (const line of lines) {
    const msg = parseJson(line);
    if (msg) messages.push(msg);
  }
  return { messages, rest };
}

async function publish(channel: string, payload: unknown) {
  if (!AXL_HTTP_URL) return;
  const res = await fetch(joinUrl(AXL_HTTP_URL, AXL_SEND_PATH), {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      channel,
      payload,
      from: AXL_PEER_ID,
      ts: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    throw new Error(`AXL publish failed ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

export function startAxlAgent(opts: RuntimeOpts) {
  if (!AXL_HTTP_URL) {
    console.log(`${opts.agentName}: AXL disabled (AXL_HTTP_URL unset); HTTP mode only.`);
    return;
  }

  const peerId = AXL_PEER_ID || opts.agentName;
  const caps = new Set(opts.capabilities);
  console.log(`${opts.agentName}: AXL enabled peer=${peerId} caps=${opts.capabilities.join(",")}`);

  void publish("veritas/discovery", {
    role: "oracle-agent",
    agent: opts.agentName,
    peerId,
    capabilities: opts.capabilities,
  }).catch((e) => console.warn(`${opts.agentName}: AXL discovery failed: ${(e as Error).message}`));

  void (async () => {
    let attempt = 0;
    while (true) {
      try {
        const res = await fetch(joinUrl(AXL_HTTP_URL, AXL_SUBSCRIBE_PATH), {
          method: "POST",
          headers: headers({ "content-type": "application/json", accept: "text/event-stream, application/x-ndjson" }),
          body: JSON.stringify({ channel: "veritas/claim/dispatch", peerId }),
        });
        if (!res.ok || !res.body) throw new Error(`subscribe HTTP ${res.status}`);
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parsed = parseStream(buf);
          buf = parsed.rest;
          for (const msg of parsed.messages) {
            const payload = msg.payload ?? msg;
            const req = payload.request as AgentRequest | undefined;
            const claimId = payload.claimId ?? req?.claimId;
            if (!req || !claimId || !req.spec || !caps.has(String(req.spec.kind))) continue;
            try {
              const response = await opts.verify({ ...req, claimId: Number(claimId) }, { from: msg.from });
              await publish(`veritas/vote/${claimId}`, {
                kind: "agent_response",
                agent: opts.agentName,
                peerId,
                claimId: String(claimId),
                response,
              });
            } catch (e) {
              await publish(`veritas/vote/${claimId}`, {
                kind: "agent_response",
                agent: opts.agentName,
                peerId,
                claimId: String(claimId),
                response: {
                  agent: opts.agentName,
                  resolvable: false,
                  outcome: "INVALID",
                  confidence: 0.1,
                  evidence: [],
                  reasoning: `AXL agent verification failed: ${(e as Error).message}`,
                },
              });
            }
          }
        }
      } catch (e) {
        attempt += 1;
        const wait = Math.min(30_000, AXL_AGENT_RECONNECT_MS * Math.max(1, attempt));
        console.warn(`${opts.agentName}: AXL subscription lost: ${(e as Error).message}; reconnecting in ${wait}ms`);
        await sleep(wait);
      }
    }
  })();
}

