/**
 * Gensyn AXL transport — encrypted P2P channels.
 *
 * Two modes:
 *  - REAL : when AXL_HTTP_URL is set, forwards every publish/subscribe to an
 *           AXL HTTP sidecar. The wrapper supports both SSE (`data: {...}`) and
 *           NDJSON (`{...}\n`) subscribe streams so it can work with a local
 *           dev sidecar or a real mesh adapter.
 *  - MOCK : otherwise, behaves as an in-process pub/sub bus so the entire
 *           swarm can run end-to-end in a single Node process (great for the
 *           hackathon demo without operating a real mesh).
 *
 * The public surface is intentionally tiny:
 *   axl.publish(channel, payload)
 *   axl.subscribe(channel, handler) -> unsubscribe()
 *   axl.request(channel, payload, { timeoutMs }) -> first response payload
 *
 * Channel taxonomy mirrors ARCHITECTURE.md §4.5:
 *   veritas/claim/dispatch
 *   veritas/vote/<claimId>
 *   veritas/critic/<claimId>
 *   veritas/reputation/gossip
 *   veritas/discovery
 */

export type AxlMode = "real" | "mock";

const AXL_HTTP_URL = (process.env.AXL_HTTP_URL || "").trim();
const AXL_PEER_ID  = (process.env.AXL_PEER_ID  || "local-coordinator").trim();
const AXL_API_KEY  = (process.env.AXL_API_KEY  || "").trim();
const AXL_SEND_PATH = (process.env.AXL_SEND_PATH || "/axl/send").trim();
const AXL_SUBSCRIBE_PATH = (process.env.AXL_SUBSCRIBE_PATH || "/axl/subscribe").trim();
const AXL_HEALTH_PATH = (process.env.AXL_HEALTH_PATH || "/health").trim();
const AXL_RECONNECT_MS = Number(process.env.AXL_RECONNECT_MS ?? "1500");
const AXL_PUBLISH_TIMEOUT_MS = Number(process.env.AXL_PUBLISH_TIMEOUT_MS ?? "8000");

export const axlMode: AxlMode = AXL_HTTP_URL ? "real" : "mock";

type Handler = (payload: any, meta: { channel: string; from?: string }) => void | Promise<void>;
type AxlHealth = {
  ok: boolean;
  mode: AxlMode;
  peerId: string;
  sidecarUrl?: string;
  sidecar?: unknown;
  error?: string;
};

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

function parseMaybeJson(raw: string): any | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Parses either:
 *   - SSE frames: `event: message\ndata: {...}\n\n`
 *   - NDJSON lines: `{...}\n`
 *
 * Returns parsed messages and unconsumed buffer tail.
 */
function parseStreamBuffer(input: string): { messages: any[]; rest: string } {
  const messages: any[] = [];
  let rest = input;

  // SSE: complete frames are separated by a blank line.
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
    const msg = parseMaybeJson(data || frame);
    if (msg) messages.push(msg);
  }

  // NDJSON: complete lines are parseable JSON objects.
  const lines = rest.split(/\r?\n/);
  rest = lines.pop() ?? "";
  for (const line of lines) {
    const msg = parseMaybeJson(line);
    if (msg) messages.push(msg);
  }

  return { messages, rest };
}

// ---------- mock backend ----------------------------------------------------

class MockAxl {
  private handlers = new Map<string, Set<Handler>>();

  async publish(channel: string, payload: any) {
    const set = this.handlers.get(channel);
    if (!set) return;
    for (const h of set) {
      // run async; never block the publisher
      void Promise.resolve().then(() => h(payload, { channel, from: AXL_PEER_ID }));
    }
  }

  subscribe(channel: string, handler: Handler) {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(handler);
    return () => this.handlers.get(channel)?.delete(handler);
  }
}

// ---------- real backend ----------------------------------------------------

class RealAxl {
  private streams = new Map<string, AbortController>();

  async publish(channel: string, payload: any) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), AXL_PUBLISH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(joinUrl(AXL_HTTP_URL, AXL_SEND_PATH), {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ channel, payload, from: AXL_PEER_ID, ts: new Date().toISOString() }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      throw new Error(`AXL publish failed ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }

  subscribe(channel: string, handler: Handler) {
    const ac = new AbortController();
    const url = joinUrl(AXL_HTTP_URL, AXL_SUBSCRIBE_PATH);
    const id = `${channel}:${Math.random().toString(16).slice(2)}`;
    void (async () => {
      let attempt = 0;
      while (!ac.signal.aborted) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: headers({ "content-type": "application/json", accept: "text/event-stream, application/x-ndjson" }),
            body: JSON.stringify({ channel, peerId: AXL_PEER_ID }),
            signal: ac.signal,
          });
          if (!res.ok || !res.body) {
            throw new Error(`AXL subscribe failed ${res.status}`);
          }
          attempt = 0;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (!ac.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parsed = parseStreamBuffer(buf);
            buf = parsed.rest;
            for (const msg of parsed.messages) {
              await handler(msg.payload ?? msg, {
                channel: msg.channel ?? channel,
                from: msg.from,
              });
            }
          }
        } catch (e) {
          if (ac.signal.aborted) break;
          attempt += 1;
          const wait = Math.min(30_000, AXL_RECONNECT_MS * Math.max(1, attempt));
          console.warn(`AXL subscribe ${channel} disconnected: ${(e as Error).message}; reconnecting in ${wait}ms`);
          await sleep(wait);
        }
      }
    })();
    this.streams.set(id, ac);
    return () => {
      ac.abort();
      this.streams.delete(id);
    };
  }

  async health(): Promise<AxlHealth> {
    try {
      const res = await fetch(joinUrl(AXL_HTTP_URL, AXL_HEALTH_PATH), {
        headers: headers(),
        signal: AbortSignal.timeout(2000),
      });
      const text = await res.text().catch(() => "");
      const sidecar = parseMaybeJson(text) ?? text;
      return {
        ok: res.ok,
        mode: "real",
        peerId: AXL_PEER_ID,
        sidecarUrl: AXL_HTTP_URL,
        sidecar,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      };
    } catch (e) {
      return {
        ok: false,
        mode: "real",
        peerId: AXL_PEER_ID,
        sidecarUrl: AXL_HTTP_URL,
        error: (e as Error).message,
      };
    }
  }
}

// ---------- public surface --------------------------------------------------

const impl = axlMode === "real" ? new RealAxl() : new MockAxl();

export const axl = {
  mode: axlMode,
  peerId: AXL_PEER_ID,

  async publish(channel: string, payload: any) {
    return impl.publish(channel, payload);
  },

  subscribe(channel: string, handler: Handler) {
    return impl.subscribe(channel, handler);
  },

  async health(): Promise<AxlHealth> {
    if (impl instanceof RealAxl) return impl.health();
    return { ok: true, mode: "mock", peerId: AXL_PEER_ID };
  },

  /**
   * One-shot request: publish on `channel`, await first message back on
   * `responseChannel`. Resolves to `null` on timeout.
   */
  async request<T = any>(
    channel: string,
    responseChannel: string,
    payload: any,
    opts: { timeoutMs?: number } = {},
  ): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const timeout = opts.timeoutMs ?? 8000;
      let settled = false;
      const off = impl.subscribe(responseChannel, (resp) => {
        if (settled) return;
        settled = true;
        off();
        resolve(resp as T);
      });
      void impl.publish(channel, payload).catch(() => {
        if (settled) return;
        settled = true;
        off();
        resolve(null);
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        resolve(null);
      }, timeout);
    });
  },

  /**
   * Collect every message arriving on `channel` for `windowMs`, then return them.
   */
  async collect<T = any>(channel: string, windowMs: number): Promise<T[]> {
    return new Promise<T[]>((resolve) => {
      const out: T[] = [];
      const off = impl.subscribe(channel, (m) => {
        out.push(m as T);
      });
      setTimeout(() => {
        off();
        resolve(out);
      }, windowMs);
    });
  },
};

export const Channels = {
  claimDispatch: "veritas/claim/dispatch",
  vote:          (claimId: string | number | bigint) => `veritas/vote/${claimId.toString()}`,
  reasoning:     (claimId: string | number | bigint) => `veritas/reasoning/${claimId.toString()}`,
  critic:        (claimId: string | number | bigint) => `veritas/critic/${claimId.toString()}`,
  criticVerdict: (claimId: string | number | bigint) => `veritas/critic/${claimId.toString()}/verdict`,
  reputationGossip: "veritas/reputation/gossip",
  discovery:        "veritas/discovery",
};
