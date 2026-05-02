import Link from "next/link";
import { api } from "@/lib/api";
import { AgentsTable } from "@/components/AgentsTable";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  let agents: Awaited<ReturnType<typeof api.agents>> | null = null;
  let err: string | null = null;
  try { agents = await api.agents(); } catch (e) { err = (e as Error).message; }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-mute">{agents?.count ?? 0} oracle iNFT(s) currently resolvable from registry.</p>
        </div>
        <Link href="/register" className="rounded-md bg-accent text-ink px-3 py-1.5 text-sm font-medium hover:opacity-90">
          + Register
        </Link>
      </div>
      {err ? (
        <div className="text-sm text-bad">Failed to load agents: {err}</div>
      ) : (
        <AgentsTable agents={agents?.agents ?? []} />
      )}
    </div>
  );
}
