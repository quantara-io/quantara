const ACCESS_KEY = "qt_access_token";
const REFRESH_KEY = "qt_refresh_token";

export function getAccessToken(): string {
  return localStorage.getItem(ACCESS_KEY) ?? "";
}
export function getRefreshToken(): string {
  return localStorage.getItem(REFRESH_KEY) ?? "";
}
export function saveTokens(access: string, refresh: string) {
  localStorage.setItem(ACCESS_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}
export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export interface JwtClaims {
  sub: string;
  email?: string;
  role?: string;
  exp?: number;
}

export function decodeJwt(token: string): JwtClaims | null {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function currentUser(): JwtClaims | null {
  const t = getAccessToken();
  return t ? decodeJwt(t) : null;
}

export function isAdmin(): boolean {
  return currentUser()?.role === "admin";
}
