"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { Config, Manifest } from "@/lib/types";
import { connect, registerOnChain, whoami } from "@/lib/wallet";
import { Mono, short } from "./Stat";

const SUGGESTED_CAPS = [
  "github_pr_merged_before",
  "snapshot_proposal_passed",
  "critic",
];

export function RegisterForm({ config }: { config: Config | null }) {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? config?.chainId ?? 16602);
  const chainName = process.env.NEXT_PUBLIC_CHAIN_NAME ?? "0G Galileo";
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? config?.rpcUrl ?? "https://evmrpc-testnet.0g.ai";
  const explorer = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://chainscan-galileo.0g.ai";
  const inftAddr = config?.contracts.OracleINFT ?? "";

  const [name, setName] = useState("my-agent");
  const [displayName, setDisplayName] = useState("My agent");
  const [endpoint, setEndpoint] = useState("https://my-agent.example.com");
  const [capabilities, setCapabilities] = useState<string>(SUGGESTED_CAPS[0]);
  const [description, setDescription] = useState("");
  const [signer, setSigner] = useState("0x0000000000000000000000000000000000000000");
  const [version, setVersion] = useState("0.1.0");

  const [account, setAccount] = useState<string | null>(null);
  const [pinned, setPinned] = useState<{ uri: string; hash: `0x${string}` } | null>(null);
  const [pinning, setPinning] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { whoami().then((a) => { if (a) { setAccount(a); setSigner(a); } }); }, []);

  const manifest: Manifest = useMemo(() => ({
    schema: "veritas.agent.v1",
    name: name.trim().toLowerCase(),
    displayName: displayName.trim() || undefined,
    endpoint: endpoint.trim(),
    capabilities: capabilities.split(",").map((s) => s.trim()).filter(Boolean),
    description: description.trim() || undefined,
    signer: signer.trim(),
    version: version.trim(),
  }), [name, displayName, endpoint, capabilities, description, signer, version]);

  const ens = `${manifest.name}.veritas.eth`;

  async function handleConnect() {
    setError(null);
    try {
      const w = await connect({ chainId, chainName, rpcUrl, explorerUrl: explorer });
      setAccount(w.address);
      if (signer === "0x0000000000000000000000000000000000000000") setSigner(w.address);
    } catch (e) { setError((e as Error).message); }
  }

  async function handlePin() {
    setError(null); setPinning(true); setPinned(null);
    try {
      const r = await api.pinManifest(manifest);
      setPinned({ uri: r.uri, hash: r.hash });
    } catch (e) {
      setError((e as Error).message);
    } finally { setPinning(false); }
  }

  async function handleRegister() {
    setError(null); setRegistering(true); setTxHash(null); setTokenId(null);
    try {
      if (!inftAddr) throw new Error("Coordinator did not return ORACLE_INFT_ADDRESS — check backend /v1/config.");
      if (!pinned) throw new Error("Pin manifest first.");
      const r = await registerOnChain({
        inftAddress: inftAddr,
        ens,
        manifestUri: pinned.uri,
        manifestHash: pinned.hash,
        capabilities: manifest.capabilities,
      });
      setTxHash(r.txHash);
      setTokenId(r.tokenId?.toString() ?? null);
      // Tell coordinator to refresh so /agents shows the new entry.
      try { await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8787"}/v1/agents/refresh`, { method: "POST" }); } catch { /* */ }
    } catch (e) { setError((e as Error).message); }
    finally { setRegistering(false); }
  }

  function downloadManifest() {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${manifest.name || "agent"}.manifest.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const capsOk = manifest.capabilities.length > 0;
  const namedOk = /^[a-z0-9][a-z0-9-]*$/.test(manifest.name);
  const endpointOk = /^https?:\/\//.test(manifest.endpoint);
  const signerOk = /^0x[a-fA-F0-9]{40}$/.test(manifest.signer);
  const formOk = namedOk && endpointOk && capsOk && signerOk && manifest.version.length > 0;

  return (
    <div className="grid lg:grid-cols-[1fr_420px] gap-8">
      {/* form ------------------------------------------------------ */}
      <div className="space-y-5">
        <Field label="Agent slug" hint="lowercase, alphanum + dashes. ENS = slug.veritas.eth">
          <input className={inp(namedOk)} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-agent" />
        </Field>
        <Field label="Display name">
          <input className={inp(true)} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My Agent" />
        </Field>
        <Field label="Endpoint URL" hint="POST /verify must speak the AgentResponse schema.">
          <input className={inp(endpointOk)} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://my-agent.example.com" />
        </Field>
        <Field label="Capabilities (comma-separated)">
          <input className={inp(capsOk)} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} placeholder="github_pr_merged_before, snapshot_proposal_passed" />
          <div className="mt-1 flex flex-wrap gap-1">
            {SUGGESTED_CAPS.map((c) => (
              <button key={c} type="button" onClick={() => setCapabilities(c)} className="text-[11px] font-mono rounded bg-line/40 hover:bg-line border border-line px-1.5 py-0.5 text-mute">
                {c}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Signer address" hint="Key the agent will use to sign AgentResponses (future).">
          <input className={inp(signerOk)} value={signer} onChange={(e) => setSigner(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Version"><input className={inp(true)} value={version} onChange={(e) => setVersion(e.target.value)} /></Field>
          <Field label="Description (optional)"><input className={inp(true)} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <button type="button" onClick={downloadManifest} className="rounded-md border border-line px-3 py-2 text-sm hover:bg-slab/60">
            Download manifest.json
          </button>
          <button
            type="button"
            onClick={handlePin}
            disabled={!formOk || pinning}
            className="rounded-md bg-zinc-100 text-ink px-3 py-2 text-sm font-medium hover:opacity-90"
          >
            {pinning ? "Pinning…" : pinned ? "Re-pin to 0G" : "Pin to 0G Storage"}
          </button>
          {!account ? (
            <button type="button" onClick={handleConnect} className="rounded-md border border-accent/60 text-accent px-3 py-2 text-sm hover:bg-accent/10">
              Connect MetaMask
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRegister}
              disabled={!pinned || !inftAddr || registering}
              className="rounded-md bg-accent text-ink px-3 py-2 text-sm font-medium hover:opacity-90"
            >
              {registering ? "Registering…" : "Register on-chain"}
            </button>
          )}
        </div>

        {error ? <div className="text-sm text-bad">{error}</div> : null}
      </div>

      {/* preview --------------------------------------------------- */}
      <aside className="space-y-4">
        <div className="rounded-xl border border-line bg-slab/40 p-4 text-sm">
          <div className="text-[11px] uppercase tracking-wider text-mute mb-2">Wallet</div>
          {account ? (
            <div>Connected as <Mono>{short(account, 8, 6)}</Mono> on chain {chainId}</div>
          ) : (
            <div className="text-mute">Not connected. Connect MetaMask to register on chain.</div>
          )}
        </div>

        <div className="rounded-xl border border-line bg-slab/40 p-4 text-sm">
          <div className="text-[11px] uppercase tracking-wider text-mute mb-2">Identity</div>
          <div>ENS: <Mono>{ens}</Mono></div>
          <div className="text-xs text-mute">iNFT: <Mono>{inftAddr ? short(inftAddr, 8, 6) : "(unknown)"}</Mono></div>
        </div>

        <div className="rounded-xl border border-line bg-slab/40 p-4 text-sm space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-mute">Pinned manifest</div>
          {pinned ? (
            <>
              <div>uri: <Mono>{pinned.uri}</Mono></div>
              <div>hash: <Mono>{pinned.hash}</Mono></div>
            </>
          ) : (
            <div className="text-mute text-xs">Pin to 0G first to get a content URI + hash.</div>
          )}
        </div>

        <div className="rounded-xl border border-line bg-slab/40 p-4 text-sm space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-mute">On-chain</div>
          {tokenId ? <div>tokenId <span className="font-mono">{tokenId}</span></div> : <div className="text-mute text-xs">No token minted yet.</div>}
          {txHash ? (
            <div className="text-xs">
              tx: <a className="font-mono text-accent break-all" href={`${explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">{txHash}</a>
            </div>
          ) : null}
        </div>

        <details className="rounded-xl border border-line bg-slab/40 p-4 text-xs">
          <summary className="cursor-pointer text-mute uppercase tracking-wider text-[11px]">Raw manifest preview</summary>
          <pre className="mt-2 overflow-auto scrollbar text-zinc-200">{JSON.stringify(manifest, null, 2)}</pre>
        </details>
      </aside>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-mute mb-1">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-xs text-mute">{hint}</div> : null}
    </label>
  );
}

function inp(ok: boolean) {
  return (
    "w-full rounded-md bg-ink border px-3 py-2 text-sm font-mono " +
    (ok ? "border-line focus:border-accent" : "border-bad/60") +
    " focus:outline-none"
  );
}
