import { useEffect, useState } from "react";

import { apiFetch } from "../lib/api";

interface NewsItem {
  newsId?: string;
  title?: string;
  source?: string;
  publishedAt?: string;
  currencies?: string[];
  rawSentiment?: string;
  status?: string;
}
interface NewsData {
  news: NewsItem[];
  fearGreed: { value: number; classification: string } | null;
}

export function News() {
  const [data, setData] = useState<NewsData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await apiFetch<NewsData>("/api/admin/news?limit=50");
      if (cancelled) return;
      if (res.success && res.data) {
        setData(res.data);
        setError("");
      } else setError(res.error?.message ?? "Failed to load");
    }
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error)
    return (
      <div className="p-3 rounded bg-red-950/40 text-red-300 border border-red-900 text-sm">
        {error}
      </div>
    );
  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">{data.news.length} most recent</p>
      <div className="space-y-2">
        {data.news.map((n, i) => (
          <div key={n.newsId ?? i} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <div className="text-sm text-slate-100 mb-1">{n.title ?? "(no title)"}</div>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="text-slate-500">{n.source ?? "unknown"}</span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">
                {n.publishedAt ? new Date(n.publishedAt).toLocaleString() : ""}
              </span>
              <span
                className={`ml-auto px-1.5 py-0.5 rounded ${
                  n.rawSentiment === "bullish"
                    ? "bg-emerald-950 text-emerald-300"
                    : n.rawSentiment === "bearish"
                      ? "bg-red-950 text-red-300"
                      : "bg-slate-800 text-slate-400"
                }`}
              >
                {n.rawSentiment ?? "neutral"}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                {n.status ?? "raw"}
              </span>
              {(n.currencies ?? []).map((c) => (
                <span key={c} className="px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300">
                  {c}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
