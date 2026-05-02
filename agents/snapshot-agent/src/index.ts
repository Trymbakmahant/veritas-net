import express from "express";
import { z } from "zod";
import { startAxlAgent } from "../../shared/axl-agent.js";

const PORT = Number(process.env.PORT ?? "8802");
const SNAPSHOT_GRAPHQL = process.env.SNAPSHOT_GRAPHQL ?? "https://hub.snapshot.org/graphql";

const RequestSchema = z.object({
  claimId: z.number().int().positive().optional(),
  text: z.string().min(1),
  spec: z.object({
    kind: z.literal("snapshot_proposal_passed"),
    space: z.string().min(1),
    proposalId: z.string().min(1)
  })
});

type SnapshotProposal = {
  id: string;
  title: string;
  state: string;
  choices: string[];
  scores: number[];
  scores_total: number;
  link: string;
  space: { id: string };
};

async function fetchProposal(proposalId: string): Promise<SnapshotProposal | null> {
  const query = `
    query Proposal($id: String!) {
      proposal(id: $id) {
        id
        title
        state
        choices
        scores
        scores_total
        link
        space { id }
      }
    }
  `;

  const res = await fetch(SNAPSHOT_GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { id: proposalId } })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Snapshot GraphQL error ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { data?: { proposal?: SnapshotProposal | null } };
  return json.data?.proposal ?? null;
}

function argMax(arr: number[]) {
  if (arr.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  return best;
}

function isYesChoice(label: string) {
  const s = label.trim().toLowerCase();
  return s === "yes" || s === "for" || s === "approve" || s === "accept";
}

const app = express();
app.use(express.json({ limit: "1mb" }));

async function verifySnapshot(raw: unknown) {
  const parsed = RequestSchema.parse(raw);
  const p = await fetchProposal(parsed.spec.proposalId);

  if (!p) {
    return {
      agent: "snapshot-agent",
      resolvable: false,
      outcome: "INVALID" as const,
      confidence: 0.6,
      evidence: [{ type: "snapshot_graphql", uri: SNAPSHOT_GRAPHQL, note: "proposal not found" }],
      reasoning: "Snapshot proposal not found for given proposalId."
    };
  }

  if (p.space.id !== parsed.spec.space) {
    return {
      agent: "snapshot-agent",
      resolvable: false,
      outcome: "INVALID" as const,
      confidence: 0.6,
      evidence: [{ type: "snapshot_link", uri: p.link }],
      reasoning: `Proposal space mismatch. Expected ${parsed.spec.space}, got ${p.space.id}.`
    };
  }

  const closed = ["closed", "final"].includes(p.state.toLowerCase());
  if (!closed) {
    return {
      agent: "snapshot-agent",
      resolvable: true,
      outcome: "ESCALATE" as const,
      confidence: 0.55,
      evidence: [{ type: "snapshot_link", uri: p.link }],
      reasoning: `Proposal not finalized yet (state=${p.state}).`
    };
  }

  const winnerIdx = argMax(p.scores);
  const winnerChoice = p.choices[winnerIdx] ?? "";
  const passed = isYesChoice(winnerChoice);

  return {
    agent: "snapshot-agent",
    resolvable: true,
    outcome: passed ? "YES" as const : "NO" as const,
    confidence: 0.8,
    evidence: [
      { type: "snapshot_link", uri: p.link },
      { type: "snapshot_graphql", uri: SNAPSHOT_GRAPHQL, note: `winner=${winnerChoice}` }
    ],
    reasoning: `Snapshot proposal is closed. Winning choice is '${winnerChoice}'. Interpreting as ${passed ? "PASS" : "FAIL"} using a Yes/For heuristic.`
  };
}

app.get("/health", (_req, res) => res.json({
  ok: true,
  agent: "snapshot-agent",
  axl: !!process.env.AXL_HTTP_URL,
}));

app.post("/verify", async (req, res) => {
  try {
    return res.json(await verifySnapshot(req.body));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`Snapshot agent listening on :${PORT}`);
});

startAxlAgent({
  agentName: "snapshot-agent",
  capabilities: ["snapshot_proposal_passed"],
  verify: (req) => verifySnapshot(req),
});

