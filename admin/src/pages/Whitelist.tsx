import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

export function Whitelist() {
  const [ips, setIps] = useState<string[]>([]);
  const [original, setOriginal] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    const res = await apiFetch<{ ips: string[] }>("/api/admin/whitelist");
    setLoading(false);
    if (res.success && res.data) {
      setIps(res.data.ips);
      setOriginal(res.data.ips);
    } else setError(res.error?.message ?? "Failed to load");
  }

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (ips.includes(v)) return setError("Already in list");
    setIps([...ips, v]); setDraft(""); setError("");
  }

  function remove(ip: string) {
    setIps(ips.filter((x) => x !== ip));
  }

  async function save() {
    setBusy(true);
    setError(""); setInfo("");
    const res = await apiFetch<{ ips: string[] }>("/api/admin/whitelist", { method: "PUT", body: { ips } });
    setBusy(false);
    if (res.success && res.data) {
      setOriginal(res.data.ips);
      setIps(res.data.ips);
      setInfo("Saved.");
    } else setError(res.error?.message ?? "Save failed");
  }

  const dirty = ips.join(",") !== original.join(",");

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="text-base font-semibold text-slate-100">Docs IP Allowlist</h1>
        <p className="text-xs text-slate-500 mt-1">
          Controls who can access <code className="text-slate-400">/api/docs/*</code>. Accepts single IPs or CIDR blocks (IPv4 or IPv6).
          Cached 5 min on the Lambda.
        </p>
      </div>

      {error && <div className="p-2 rounded bg-red-950/40 text-red-300 border border-red-900 text-sm">{error}</div>}
      {info && <div className="p-2 rounded bg-emerald-950/40 text-emerald-300 border border-emerald-900 text-sm">{info}</div>}

      {loading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 space-y-2">
            {ips.length === 0 && <p className="text-xs text-slate-500">No entries — list is empty (denies everyone).</p>}
            {ips.map((ip) => (
              <div key={ip} className="flex items-center justify-between text-sm">
                <code className="text-slate-300 font-mono">{ip}</code>
                <button onClick={() => remove(ip)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <input value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="e.g. 1.2.3.4 or 1.2.3.0/24"
              className="flex-1 rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-indigo-500" />
            <button onClick={add}
              className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm text-slate-100">
              Add
            </button>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => setIps(original)} disabled={!dirty || busy}
              className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-40">
              Revert
            </button>
            <button onClick={save} disabled={!dirty || busy}
              className="rounded-md bg-indigo-600 hover:bg-indigo-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
