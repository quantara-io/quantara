import { getAccessToken, getRefreshToken, saveTokens, clearTokens } from "./auth";

const API_KEY =
  import.meta.env.VITE_API_KEY ?? "qk_6734f98158e9f1fcffa9f86d27d09f05ee37ad9e50c69eba";
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  noAuth?: boolean;
  retry?: boolean;
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  const rt = getRefreshToken();
  if (!rt) return false;
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/token/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ refreshToken: rt }),
      });
      const json = (await res.json()) as Envelope<{ accessToken: string; refreshToken: string }>;
      if (json.success && json.data) {
        saveTokens(json.data.accessToken, json.data.refreshToken ?? rt);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  })();
  const ok = await refreshing;
  refreshing = null;
  return ok;
}

export async function apiFetch<T>(path: string, opts: RequestOpts = {}): Promise<Envelope<T>> {
  const { method = "GET", body, noAuth, retry = true } = opts;
  const headers: Record<string, string> = { "x-api-key": API_KEY };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (!noAuth) {
    const at = getAccessToken();
    if (at) headers["Authorization"] = `Bearer ${at}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !noAuth && retry) {
    const refreshed = await tryRefresh();
    if (refreshed) return apiFetch<T>(path, { ...opts, retry: false });
    clearTokens();
  }

  return (await res.json()) as Envelope<T>;
}

export const API_PUBLIC_KEY = API_KEY;
