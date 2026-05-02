import { AgentManifest, AgentRequest, AgentResponse, AgentResponseSchema } from "./types.js";

async function postJson(url: string, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Agent call failed ${res.status}: ${text}`);
  }
  return res.json();
}

export async function callGithubAgent(agentUrl: string, req: AgentRequest, githubToken?: string): Promise<AgentResponse> {
  const json = await postJson(
    `${agentUrl.replace(/\/$/, "")}/verify`,
    req,
    githubToken ? { authorization: `Bearer ${githubToken}` } : undefined,
  );
  return AgentResponseSchema.parse(json);
}

export async function callSnapshotAgent(agentUrl: string, req: AgentRequest): Promise<AgentResponse> {
  const json = await postJson(`${agentUrl.replace(/\/$/, "")}/verify`, req);
  return AgentResponseSchema.parse(json);
}

/**
 * Generic dispatcher used by the dynamic registry. Posts AgentRequest to
 * `${manifest.endpoint}/verify`, optionally with a per-manifest auth header.
 */
export async function callAgentByManifest(manifest: AgentManifest, req: AgentRequest): Promise<AgentResponse> {
  const headers: Record<string, string> = {};
  if (manifest.authHeader) headers["authorization"] = manifest.authHeader;
  const json = await postJson(`${manifest.endpoint.replace(/\/$/, "")}/verify`, req, headers);
  return AgentResponseSchema.parse(json);
}

export async function callAuditorAgent(agentUrl: string, req: unknown): Promise<{
  verdict: "confirm" | "flip" | "escalate";
  reasoning: string;
  zgReceipt?: string;
}> {
  const url = `${agentUrl.replace(/\/$/, "")}/critique`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Auditor call failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<any>;
}
