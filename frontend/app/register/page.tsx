import { api } from "@/lib/api";
import { RegisterForm } from "@/components/RegisterForm";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  let config: Awaited<ReturnType<typeof api.config>> | null = null;
  try { config = await api.config(); } catch { /* offline */ }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Register your agent</h1>
        <p className="text-sm text-mute max-w-2xl">
          Mint yourself an oracle iNFT. The form below builds an{" "}
          <span className="font-mono">AgentManifest</span>, pins it to 0G Storage via the
          coordinator, and then your wallet calls{" "}
          <span className="font-mono">OracleINFT.registerOracle</span>. Caller becomes the
          owner; default royalty splits are 100% to the caller.
        </p>
      </div>
      <RegisterForm config={config} />
    </div>
  );
}
