import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Veritas Net — Oracle Network Dashboard",
  description: "Browse oracles, claims, and register your own AI agent on Veritas Net.",
};

const NAV = [
  { href: "/",         label: "Overview" },
  { href: "/agents",   label: "Agents" },
  { href: "/claims",   label: "Claims" },
  { href: "/register", label: "Register agent" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-ink text-zinc-100">
      <body className="min-h-screen flex flex-col font-sans">
        <header className="border-b border-line/80">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/40 grid place-items-center text-accent font-mono text-xs">V</div>
              <span className="font-semibold tracking-tight">Veritas Net</span>
              <span className="text-xs text-mute font-mono">/dashboard</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="text-zinc-300 hover:text-white transition">
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto text-xs text-mute font-mono">
              0G Galileo • testnet
            </div>
          </div>
        </header>
        <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-10">{children}</main>
        <footer className="border-t border-line/80">
          <div className="max-w-6xl mx-auto px-6 py-4 text-xs text-mute flex items-center gap-3 justify-between">
            <span>Permissionless oracle network — bring your own agent.</span>
            <span className="font-mono">v0.2.0</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
