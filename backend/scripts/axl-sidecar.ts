/**
 * axl-sidecar
 *
 * Local HTTP sidecar that implements the AXL transport contract used by
 * `backend/src/axl.ts`:
 *
 *   POST /axl/send       { channel, payload, from?, ts? }
 *   POST /axl/subscribe  { channel, peerId? } -> text/event-stream
 *   GET  /axl/subscribe?channel=...          -> text/event-stream
 *   GET  /health
 *
 * This is intentionally lightweight: it gives us a real cross-process bus for
 * demos today, and its HTTP shape can be swapped for the Gensyn AXL sidecar
 * without touching the coordinator.
 */

import "dotenv/config";
import express from "express";

type WireMessage = {
  channel: string;
  payload: unknown;
  from?: string;
  ts: string;
  id: number;
};

type Client = {
  id: string;
  peerId: string;
  channel: string;
  res: express.Response;
  connectedAt: number;
};

const PORT = Number(process.env.AXL_SIDECAR_PORT ?? "8765");
const HOST = process.env.AXL_SIDECAR_HOST ?? "127.0.0.1";
const PEER_ID = process.env.AXL_PEER_ID ?? "local-axl-sidecar";
const API_KEY = process.env.AXL_API_KEY ?? "";
const REPLAY_BUFFER = Math.max(0, Number(process.env.AXL_REPLAY_BUFFER ?? "100"));
const HEARTBEAT_MS = Math.max(5000, Number(process.env.AXL_HEARTBEAT_MS ?? "15000"));

const clients = new Map<string, Client>();
const history = new Map<string, WireMessage[]>();
let nextMessageId = 1;

function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_KEY) return next();
  const got = req.headers.authorization ?? "";
  if (got !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: "bad AXL_API_KEY" });
    return;
  }
  next();
}

function sendSse(res: express.Response, msg: WireMessage | { type: "heartbeat"; ts: string }) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

function pushHistory(msg: WireMessage) {
  if (REPLAY_BUFFER <= 0) return;
  const arr = history.get(msg.channel) ?? [];
  arr.push(msg);
  if (arr.length > REPLAY_BUFFER) arr.splice(0, arr.length - REPLAY_BUFFER);
  history.set(msg.channel, arr);
}

function publish(msg: WireMessage) {
  pushHistory(msg);
  for (const c of clients.values()) {
    if (c.channel !== msg.channel) continue;
    sendSse(c.res, msg);
  }
}

function subscribe(req: express.Request, res: express.Response) {
  const channel = String(req.body?.channel ?? req.query.channel ?? "").trim();
  if (!channel) {
    res.status(400).json({ error: "missing channel" });
    return;
  }

  const peerId = String(req.body?.peerId ?? req.query.peerId ?? req.headers["x-veritas-peer-id"] ?? "unknown-peer");
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const client: Client = { id, peerId, channel, res, connectedAt: Date.now() };
  clients.set(id, client);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  sendSse(res, { type: "heartbeat", ts: new Date().toISOString() });

  if (req.query.replay === "1") {
    for (const msg of history.get(channel) ?? []) sendSse(res, msg);
  }

  // For a POST subscribe, `req.close` fires once the request body is consumed;
  // the SSE lifetime is tied to the response/socket instead.
  res.on("close", () => {
    clients.delete(id);
  });
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(auth);

app.get("/health", (_req, res) => {
  const channels = [...new Set([...clients.values()].map((c) => c.channel))].sort();
  res.json({
    ok: true,
    peerId: PEER_ID,
    clients: clients.size,
    channels,
    replayBuffer: REPLAY_BUFFER,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.post("/axl/send", (req, res) => {
  const channel = String(req.body?.channel ?? "").trim();
  if (!channel) {
    res.status(400).json({ error: "missing channel" });
    return;
  }
  const msg: WireMessage = {
    id: nextMessageId++,
    channel,
    payload: req.body?.payload ?? null,
    from: String(req.body?.from ?? req.headers["x-veritas-peer-id"] ?? PEER_ID),
    ts: String(req.body?.ts ?? new Date().toISOString()),
  };
  publish(msg);
  res.json({ ok: true, delivered: [...clients.values()].filter((c) => c.channel === channel).length, id: msg.id });
});

app.post("/axl/subscribe", subscribe);
app.get("/axl/subscribe", subscribe);

setInterval(() => {
  const heartbeat = { type: "heartbeat" as const, ts: new Date().toISOString() };
  for (const c of clients.values()) sendSse(c.res, heartbeat);
}, HEARTBEAT_MS).unref();

app.listen(PORT, HOST, () => {
  console.log(`AXL sidecar listening at http://${HOST}:${PORT}`);
  console.log(`  peerId=${PEER_ID} replayBuffer=${REPLAY_BUFFER} auth=${API_KEY ? "on" : "off"}`);
});

