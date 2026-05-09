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

  // Wrap the entire request — including fetch() itself — so network/CORS
  // failures surface as a typed envelope instead of an unhandled promise
  // rejection. Call sites (Genie, Market, Login, News, Whitelist, Overview)
  // await without try/catch and would otherwise leave the page stuck on
  // a Loading state with no error visible.
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      success: false,
      error: {
        code: "NETWORK_ERROR",
        message: `${path} failed to reach the server: ${(err as Error).message}`,
      },
    };
  }

  if (res.status === 401 && !noAuth && retry) {
    const refreshed = await tryRefresh();
    if (refreshed) return apiFetch<T>(path, { ...opts, retry: false });
    clearTokens();
  }

  // CloudFront's HTML error pages, gateway 504s, or any non-JSON response
  // would otherwise throw inside res.json() and surface as an unhandled
  // promise rejection. Surface as a typed error envelope instead.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {
      success: false,
      error: {
        code: `HTTP_${res.status}`,
        message: `${path} returned ${res.status} ${res.statusText} (non-JSON body)`,
      },
    };
  }
  try {
    return (await res.json()) as Envelope<T>;
  } catch (err) {
    return {
      success: false,
      error: {
        code: `HTTP_${res.status}_PARSE_ERROR`,
        message: `${path} returned ${res.status} but response body was not valid JSON: ${(err as Error).message}`,
      },
    };
  }
}

export const API_PUBLIC_KEY = API_KEY;
