import type { Claim } from "@/lib/types";
import { Mono, short } from "./Stat";

const OUTCOME_STYLES: Record<Claim["outcome"], string> = {
  YES:      "border-ok/40 text-ok bg-ok/5",
  NO:       "border-bad/40 text-bad bg-bad/5",
  INVALID:  "border-mute/40 text-mute bg-mute/5",
  ESCALATE: "border-warn/40 text-warn bg-warn/5",
};

function fmtTs(secs: string): string {
  const n = Number(secs);
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString();
}

export function ClaimsTable({ claims }: { claims: Claim[] }) {
  if (!claims.length) return <div className="text-sm text-mute">No claims yet.</div>;
  return (
    <div className="space-y-3">
      {claims.map((c) => {
        const resolved = c.resolvedAt && c.resolvedAt !== "0";
        return (
          <div key={c.claimId} className="rounded-xl border border-line bg-slab/40 px-4 py-3 hairline">
            <div className="flex items-start gap-3">
              <div className="font-mono text-xs text-mute pt-1 w-12">#{c.claimId}</div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-zinc-100 line-clamp-2">{c.text || "(no text)"}</div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-mute">
                  <span>by <Mono>{short(c.requester)}</Mono></span>
                  {c.consumer && c.consumer !== "0x0000000000000000000000000000000000000000" ? (
                    <span>consumer <Mono>{short(c.consumer)}</Mono></span>
                  ) : null}
                  <span>resolveBy {fmtTs(c.resolveBy)}</span>
                  {resolved ? <span>resolved {fmtTs(c.resolvedAt)}</span> : null}
                </div>
                {c.proofUri ? (
                  <div className="mt-2 text-[11px] font-mono text-mute break-all">proof: {c.proofUri}</div>
                ) : null}
              </div>
              <span
                className={
                  "shrink-0 rounded-md px-2 py-1 text-[11px] uppercase tracking-wider border " +
                  OUTCOME_STYLES[c.outcome]
                }
              >
                {resolved ? c.outcome : "Pending"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
