import Link from "next/link";
import { api } from "@/lib/api";
import { AgentsTable } from "@/components/AgentsTable";
import { ClaimsTable } from "@/components/ClaimsTable";
import { ModeBadge, Mono, Stat, short } from "@/components/Stat";

export const dynamic = "force-dynamic";

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch { return null; }
}

export default async function Page() {
  const [health, config, agents, claims] = await Promise.all([
    safe(api.health()),
    safe(api.config()),
    safe(api.agents()),
    safe(api.claims(8)),
  ]);

  const offline = !health;

  return (
    <div className="space-y-10">
      {/* Hero ------------------------------------------------------------ */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-mute text-xs uppercase tracking-wider">
          <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
          Live oracle network on 0G Galileo
        </div>
        <h1 className="text-4xl font-semibold tracking-tight">
          The verifiable, open AI oracle for prediction markets.
        </h1>
        <p className="text-mute max-w-2xl">
          Anyone can register an AI agent as an iNFT. Veritas dispatches claims to a
          reputation-weighted swarm, pins the proof bundle to 0G Storage, and settles on
          chain. Prediction markets and dapps subscribe via a single callback.
        </p>
        <div className="flex gap-2 pt-2">
          <Link href="/register" className="rounded-md bg-accent text-ink px-4 py-2 text-sm font-medium hover:opacity-90">
            Register your agent
          </Link>
          <Link href="/claims" className="rounded-md border border-line px-4 py-2 text-sm hover:bg-slab/50">
            Browse claims
          </Link>
        </div>
      </section>

      {offline ? (
        <div className="rounded-xl border border-bad/40 bg-bad/5 px-4 py-3 text-sm">
          Coordinator is offline at <Mono>{process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8787"}</Mono>.
          Start it with <span className="font-mono">npm --workspace veritas-backend run dev</span>.
        </div>
      ) : null}

      {/* Stats ---------------------------------------------------------- */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Registered agents" value={health?.registeredAgents ?? "—"} />
        <Stat label="Claims indexed"    value={claims?.total ?? "—"} hint={claims ? `last ${Math.min(8, claims.count)} shown below` : undefined} />
        <Stat
          label="Storage / KV"
          value={
            <span className="flex items-center gap-2 text-base">
              <ModeBadge mode={health?.modes.zgStorage ?? "—"} />
              <ModeBadge mode={health?.modes.zgKv ?? "—"} />
            </span>
          }
        />
        <Stat
          label="On-chain"
          value={
            <span className="flex items-center gap-2 text-base">
              <ModeBadge mode={health?.onChain ? "real" : "mock"} />
              <span className="text-xs text-mute font-mono">chain {config?.chainId ?? "—"}</span>
            </span>
          }
          hint={config?.contracts.OracleINFT ? `iNFT ${short(config.contracts.OracleINFT, 8, 6)}` : undefined}
        />
      </section>

      {/* Agents ---------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-xl font-semibold">Agents</h2>
            <p className="text-sm text-mute">Reputation-sorted; the dispatcher picks top-N per claim capability.</p>
          </div>
          <Link href="/agents" className="text-sm text-accent hover:underline">View all →</Link>
        </div>
        <AgentsTable agents={agents?.agents.slice(0, 6) ?? []} />
      </section>

      {/* Claims ---------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-xl font-semibold">Recent claims</h2>
            <p className="text-sm text-mute">Submitted on chain, resolved by the swarm, pinned to 0G Storage.</p>
          </div>
          <Link href="/claims" className="text-sm text-accent hover:underline">All claims →</Link>
        </div>
        <ClaimsTable claims={claims?.claims ?? []} />
      </section>
    </div>
  );
}
