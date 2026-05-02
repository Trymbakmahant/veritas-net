export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-slab/40 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-mute">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint ? <div className="mt-1 text-xs text-mute">{hint}</div> : null}
    </div>
  );
}

export function ModeBadge({ mode }: { mode: string }) {
  const real = mode === "real";
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wider border " +
        (real ? "border-ok/40 text-ok bg-ok/5" : "border-line text-mute bg-line/20")
      }
    >
      <span className={"w-1.5 h-1.5 rounded-full " + (real ? "bg-ok" : "bg-mute")} />
      {mode}
    </span>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs text-mute break-all">{children}</span>;
}

export function short(addr?: string | null, head = 6, tail = 4): string {
  if (!addr) return "—";
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
