import type { AgentEntry } from "@/lib/types";
import { Mono, short } from "./Stat";

export function AgentsTable({ agents }: { agents: AgentEntry[] }) {
  if (!agents.length) {
    return <div className="text-sm text-mute">No agents registered yet. Be the first via <a className="text-accent underline" href="/register">/register</a>.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-line scrollbar">
      <table className="w-full text-sm">
        <thead className="bg-slab/60 text-mute text-[11px] uppercase tracking-wider">
          <tr>
            <th className="text-left font-normal px-4 py-2">#</th>
            <th className="text-left font-normal px-4 py-2">ENS</th>
            <th className="text-left font-normal px-4 py-2">Capabilities</th>
            <th className="text-left font-normal px-4 py-2">Endpoint</th>
            <th className="text-right font-normal px-4 py-2">Reputation</th>
            <th className="text-left font-normal px-4 py-2">Owner</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.tokenId} className="border-t border-line/70 hover:bg-slab/40">
              <td className="px-4 py-2 font-mono text-xs">{a.tokenId}</td>
              <td className="px-4 py-2">
                <div className="font-medium text-zinc-100">{a.manifest.displayName ?? a.manifest.name}</div>
                <div className="text-xs text-mute font-mono">{a.ens}</div>
              </td>
              <td className="px-4 py-2">
                <div className="flex flex-wrap gap-1">
                  {a.manifest.capabilities.map((c) => (
                    <span key={c} className="rounded bg-line/40 border border-line px-1.5 py-0.5 text-[11px] font-mono">
                      {c}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-4 py-2"><Mono>{a.manifest.endpoint}</Mono></td>
              <td className="px-4 py-2 text-right font-mono">{a.reputation}</td>
              <td className="px-4 py-2"><Mono>{short(a.owner)}</Mono></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
