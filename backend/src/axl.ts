/**
 * Gensyn AXL transport — encrypted P2P channels.
 *
 * Two modes:
 *  - REAL : when AXL_HTTP_URL is set, forwards every publish/subscribe to the
 *           AXL sidecar running locally (HTTP at AXL_HTTP_URL).
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

const AXL_HTTP_URL = process.env.AXL_HTTP_URL || "";
const AXL_PEER_ID  = process.env.AXL_PEER_ID  || "local-coordinator";

export const axlMode: AxlMode = AXL_HTTP_URL ? "real" : "mock";

type Handler = (payload: any, meta: { channel: string; from?: string }) => void | Promise<void>;

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
    const res = await fetch(`${AXL_HTTP_URL.replace(/\/$/, "")}/axl/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, payload }),
    });
    if (!res.ok) {
      throw new Error(`AXL publish failed ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }

  subscribe(channel: string, handler: Handler) {
    const ac = new AbortController();
    const url = `${AXL_HTTP_URL.replace(/\/$/, "")}/axl/subscribe`;
    void (async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ channel }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!ac.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              await handler(msg.payload ?? msg, { channel, from: msg.from });
            } catch {
              // ignore malformed line
            }
          }
        }
      } catch {
        // network/connection ended; subscribe is best-effort.
      }
    })();
    this.streams.set(channel + ":" + Math.random(), ac);
    return () => ac.abort();
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
      void impl.publish(channel, payload);
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
