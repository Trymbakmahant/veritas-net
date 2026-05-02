import { api } from "@/lib/api";
import { ClaimsTable } from "@/components/ClaimsTable";

export const dynamic = "force-dynamic";

export default async function ClaimsPage() {
  let res: Awaited<ReturnType<typeof api.claims>> | null = null;
  let err: string | null = null;
  try { res = await api.claims(50); } catch (e) { err = (e as Error).message; }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Claims</h1>
        <p className="text-sm text-mute">
          {res ? `Showing ${res.count} of ${res.total} on-chain claims.` : "—"}
        </p>
      </div>
      {err ? (
        <div className="text-sm text-bad">Failed to load claims: {err}</div>
      ) : (
        <ClaimsTable claims={res?.claims ?? []} />
      )}
    </div>
  );
}
