export default function Home() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-8 px-6">
      <div className="text-center space-y-4 max-w-xl">
        <h1 className="font-display text-5xl font-bold tracking-tight bg-gradient-to-r from-white to-cyan-500 bg-clip-text text-transparent">
          Quantara
        </h1>
        <p className="text-text-secondary text-lg">Intelligence. Ownership. Execution.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Genie", href: "/genie", desc: "Prediction signals" },
          { label: "Coach", href: "/coach", desc: "AI business coach" },
          { label: "Deals", href: "/deals", desc: "Deal flow community" },
          { label: "Marketing", href: "/marketing", desc: "Campaign suite" },
        ].map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="group rounded-xl border border-border-subtle bg-surface-card p-5 transition-all hover:border-cyan-500/40 hover:shadow-[0_0_24px_0_rgba(79,209,255,0.15)]"
          >
            <h2 className="font-semibold text-cyan-500 group-hover:text-cyan-300 transition-colors">
              {item.label}
            </h2>
            <p className="text-text-muted text-sm mt-1">{item.desc}</p>
          </a>
        ))}
      </div>

      <p className="text-text-muted text-xs font-mono mt-8">
        v0.0.1 &middot; Platform under construction
      </p>
    </main>
  );
}
