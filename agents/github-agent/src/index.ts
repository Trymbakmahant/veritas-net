import express from "express";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? "8801");

const RequestSchema = z.object({
  claimId: z.number().int().positive().optional(),
  text: z.string().min(1),
  spec: z.object({
    kind: z.literal("github_pr_merged_before"),
    repo: z.string().min(1),
    prNumber: z.number().int().positive(),
    deadlineIso: z.string().min(1)
  })
});

type GhPr = {
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
};

async function fetchPr(repo: string, prNumber: number, token?: string) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error("repo must be 'owner/name'");

  const url = `https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` } : {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return { url, data: (await res.json()) as GhPr };
}

function asDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO date: ${iso}`);
  return d;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, agent: "github-agent" }));

app.post("/verify", async (req, res) => {
  try {
    const parsed = RequestSchema.parse(req.body);
    const token = (req.headers.authorization as string | undefined) ?? undefined;

    const deadline = asDate(parsed.spec.deadlineIso);
    const { url, data } = await fetchPr(parsed.spec.repo, parsed.spec.prNumber, token);

    const mergedAt = data.merged_at ? asDate(data.merged_at) : null;

    const resolvable = true;
    const outcome =
      mergedAt && mergedAt.getTime() <= deadline.getTime() ? "YES" : "NO";

    const reasoning = mergedAt
      ? `PR merged at ${mergedAt.toISOString()} (deadline ${deadline.toISOString()}).`
      : `PR not merged (merged_at is null). State=${data.state}, closed_at=${data.closed_at ?? "null"}.`;

    res.json({
      agent: "github-agent",
      resolvable,
      outcome,
      confidence: 0.9,
      evidence: [
        { type: "github_api", uri: url },
        { type: "github_html", uri: data.html_url }
      ],
      reasoning
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`GitHub agent listening on :${PORT}`);
});

