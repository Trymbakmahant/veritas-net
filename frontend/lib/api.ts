import type { AgentEntry, Claim, Config, Health, Manifest } from "./types";

export const BACKEND =
  (typeof process !== "undefined" && (process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL)) ||
  "http://localhost:8787";

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  if (!res.ok) {
    const err = (json as { error?: string } | null)?.error ?? text ?? `HTTP ${res.status}`;
    throw new Error(err);
  }
  return json as T;
}

export const api = {
  health: () => get<Health>("/health"),
  config: () => get<Config>("/v1/config"),
  agents: () => get<{ count: number; agents: AgentEntry[] }>("/v1/agents"),
  refreshAgents: () => post<{ ok: boolean; count: number }>("/v1/agents/refresh", {}),
  claims: (limit = 25) => get<{ count: number; total: number; claims: Claim[] }>(`/v1/claims?limit=${limit}`),
  claim: (id: string) => get<Claim>(`/v1/claims/${id}`),
  pinManifest: (m: Manifest) => post<{ uri: string; hash: `0x${string}`; manifest: Manifest }>("/v1/manifests", m),
};
