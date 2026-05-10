/**
 * Glossary page — /admin/glossary
 *
 * Left rail: alphabetical index grouped by category. Click jumps to anchor.
 * Right column: full entries with short body, optional formula, optional
 * long-form paragraphs, "Where you'll see this", and related-term chips.
 *
 * No backend; content is sourced entirely from GLOSSARY in @quantara/shared.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { GLOSSARY } from "@quantara/shared";
import type { GlossaryEntry, GlossaryKey } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Category grouping — determines left-rail sections and entry ordering
// ---------------------------------------------------------------------------

type Category =
  | "Indicators"
  | "Market Context"
  | "Performance Metrics"
  | "Genie / Ratification"
  | "Pipeline Health"
  | "News & Enrichment";

const CATEGORY_ORDER: Category[] = [
  "Indicators",
  "Market Context",
  "Performance Metrics",
  "Genie / Ratification",
  "Pipeline Health",
  "News & Enrichment",
];

const KEY_CATEGORIES: Record<GlossaryKey, Category> = {
  rsi14: "Indicators",
  emaStack: "Indicators",
  ema20: "Indicators",
  ema50: "Indicators",
  ema200: "Indicators",
  macdHist: "Indicators",
  bbBands: "Indicators",
  atr14: "Indicators",
  obv: "Indicators",
  obvSlope: "Indicators",
  vwap: "Indicators",
  volZ: "Indicators",
  fearGreed: "Market Context",
  confidenceCalibration: "Performance Metrics",
  winRate: "Performance Metrics",
  tpRate: "Performance Metrics",
  coOccurrence: "Performance Metrics",
  volatilityQuartile: "Performance Metrics",
  hourBucket: "Performance Metrics",
  ratificationVerdict: "Genie / Ratification",
  cacheHit: "Genie / Ratification",
  fellBackToAlgo: "Genie / Ratification",
  quorum: "Pipeline Health",
  streamHealth: "Pipeline Health",
  lambdaThrottles: "Pipeline Health",
  barFreshness: "Pipeline Health",
  higherTfPoller: "Pipeline Health",
  phase5aSentiment: "News & Enrichment",
  mentionedPairs: "News & Enrichment",
  newsStatus: "News & Enrichment",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupedEntries(): { category: Category; keys: GlossaryKey[] }[] {
  const byCategory: Partial<Record<Category, GlossaryKey[]>> = {};

  for (const key of Object.keys(GLOSSARY) as GlossaryKey[]) {
    const cat = KEY_CATEGORIES[key] ?? "Indicators";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat]!.push(key);
  }

  return CATEGORY_ORDER.filter((cat) => byCategory[cat]?.length).map((cat) => ({
    category: cat,
    keys: byCategory[cat]!,
  }));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EntryCard({ glossaryKey }: { glossaryKey: GlossaryKey }) {
  // Cast to GlossaryEntry — GLOSSARY is `as const` so individual values have
  // literal types; the interface has the full set of optional fields.
  const entry = GLOSSARY[glossaryKey] as GlossaryEntry;

  return (
    <article
      id={glossaryKey}
      className="scroll-mt-20 rounded-lg border border-slate-800 bg-slate-900/60 p-6"
    >
      {/* Headline */}
      <h2 className="text-lg font-semibold text-slate-100 mb-1">{entry.label}</h2>

      {/* Short body (tooltip text) */}
      <p className="text-sm text-slate-300 leading-relaxed mb-3">{entry.body}</p>

      {/* Optional formula block */}
      {entry.code && (
        <pre className="mb-4 font-mono text-xs text-slate-400 bg-slate-950/70 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap">
          {entry.code}
        </pre>
      )}

      {/* Long-form content */}
      {entry.longForm && (
        <div className="mt-4 space-y-6 border-t border-slate-800 pt-4">
          {/* Additional paragraphs */}
          {entry.longForm.paragraphs.length > 0 && (
            <div className="space-y-3">
              {entry.longForm.paragraphs.map((para, i) => (
                <p key={i} className="text-sm text-slate-300 leading-relaxed">
                  {para}
                </p>
              ))}
            </div>
          )}

          {/* Where you'll see this */}
          {entry.longForm.seenOn && entry.longForm.seenOn.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Where you'll see this
              </p>
              <ul className="flex flex-wrap gap-2">
                {entry.longForm.seenOn.map((loc) => (
                  <li key={loc.href}>
                    <Link
                      to={loc.href}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700 hover:text-slate-100 transition-colors"
                    >
                      {loc.page}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Related terms */}
          {entry.longForm.related && entry.longForm.related.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Related terms
              </p>
              <ul className="flex flex-wrap gap-2">
                {entry.longForm.related.map((relKey) => (
                  <li key={relKey}>
                    <a
                      href={`#${relKey}`}
                      className="inline-flex items-center gap-1 rounded border border-cyan-900 bg-cyan-950/40 px-2.5 py-1 text-xs text-cyan-400 hover:bg-cyan-900/50 hover:text-cyan-300 transition-colors"
                    >
                      {GLOSSARY[relKey].label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Glossary() {
  const groups = groupedEntries();
  const [activeKey, setActiveKey] = useState<GlossaryKey | null>(null);

  // Track which entry is currently in view for left-rail highlighting
  useEffect(() => {
    const allKeys = groups.flatMap((g) => g.keys);

    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the first entry that is intersecting
        const visible = entries.find((e) => e.isIntersecting);
        if (visible) {
          setActiveKey(visible.target.id as GlossaryKey);
        }
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 },
    );

    allKeys.forEach((key) => {
      const el = document.getElementById(key);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [groups]);

  return (
    <div className="flex gap-8 relative">
      {/* ------------------------------------------------------------------ */}
      {/* Left rail — sticky alphabetical index                               */}
      {/* ------------------------------------------------------------------ */}
      <aside className="hidden lg:block w-52 shrink-0">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pr-2 space-y-5">
          {groups.map(({ category, keys }) => (
            <div key={category}>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
                {category}
              </p>
              <ul className="space-y-0.5">
                {keys.map((key) => (
                  <li key={key}>
                    <a
                      href={`#${key}`}
                      className={`block px-2 py-1 rounded text-xs transition-colors ${
                        activeKey === key
                          ? "bg-slate-800 text-cyan-300"
                          : "text-slate-400 hover:text-slate-100"
                      }`}
                    >
                      {GLOSSARY[key].label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>

      {/* ------------------------------------------------------------------ */}
      {/* Right column — entries                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 min-w-0">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-slate-100">Glossary</h1>
          <p className="mt-1 text-sm text-slate-400">
            Long-form explanations of every term used in the Quantara admin dashboard. Use the index
            on the left to jump to a specific term, or share a direct link with{" "}
            <code className="font-mono text-xs text-cyan-400">/admin/glossary#&lt;term&gt;</code>.
          </p>
        </div>

        {/* Mobile: compact flat index */}
        <div className="lg:hidden mb-6">
          <details className="rounded border border-slate-800 bg-slate-900/60">
            <summary className="cursor-pointer px-4 py-3 text-sm text-slate-300 font-medium select-none">
              Jump to term &darr;
            </summary>
            <div className="px-4 pb-4 space-y-3">
              {groups.map(({ category, keys }) => (
                <div key={category}>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">
                    {category}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {keys.map((key) => (
                      <a
                        key={key}
                        href={`#${key}`}
                        className="text-xs text-slate-400 hover:text-slate-100"
                      >
                        {GLOSSARY[key].label}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>

        {/* Sections */}
        <div className="space-y-10">
          {groups.map(({ category, keys }) => (
            <section key={category}>
              <h2 className="text-base font-semibold text-slate-500 uppercase tracking-wider mb-4">
                {category}
              </h2>
              <div className="space-y-4">
                {keys.map((key) => (
                  <EntryCard key={key} glossaryKey={key} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
