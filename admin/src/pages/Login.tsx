import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import { apiFetch } from "../lib/api";
import { saveTokens } from "../lib/auth";

type Step = "email" | "password" | "mfa" | "reset-password";
type MfaMethod = "totp" | "email" | "recovery_code";

interface AuthResult {
  accessToken?: string;
  refreshToken?: string;
  mfaRequired?: boolean;
  mfaToken?: string;
  availableMethods?: MfaMethod[];
}

export function Login() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isNewUser, setIsNewUser] = useState(false);
  const [mfaToken, setMfaToken] = useState("");
  const [availableMethods, setAvailableMethods] = useState<MfaMethod[]>(["totp"]);
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>("totp");
  const [mfaCode, setMfaCode] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const ranOnce = useRef(false);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (hash.get("access_token")) {
      saveTokens(hash.get("access_token") ?? "", hash.get("refresh_token") ?? "");
      window.history.replaceState({}, "", window.location.pathname);
      navigate("/", { replace: true });
      return;
    }
    if (url.searchParams.get("token") && url.searchParams.get("reset")) {
      setResetToken(url.searchParams.get("token") ?? "");
      setStep("reset-password");
      return;
    }
    if (url.searchParams.get("token") && url.searchParams.get("magic")) {
      void verifyMagicLink(url.searchParams.get("token") ?? "");
    }
  }, [navigate]);

  async function verifyMagicLink(token: string) {
    setInfo("Verifying magic link…");
    const res = await apiFetch<AuthResult>("/api/auth/magic-link/verify", {
      method: "POST",
      body: { token },
      noAuth: true,
    });
    window.history.replaceState({}, "", window.location.pathname);
    if (res.success && res.data?.accessToken) {
      saveTokens(res.data.accessToken, res.data.refreshToken ?? "");
      navigate("/", { replace: true });
    } else if (res.data?.mfaRequired) {
      setMfaToken(res.data.mfaToken ?? "");
      setAvailableMethods(res.data.availableMethods ?? ["totp"]);
      setMfaMethod((res.data.availableMethods ?? ["totp"])[0]);
      setStep("mfa");
    } else {
      setError(res.error?.message ?? "Magic link invalid");
    }
    setInfo("");
  }

  function startSignIn() {
    if (!email.includes("@")) return setError("Enter a valid email");
    setError("");
    setIsNewUser(false);
    setStep("password");
  }

  async function submitAuth() {
    if (!password) return setError("Enter your password");
    if (isNewUser && password.length < 8) return setError("Password must be at least 8 characters");
    setError("");
    setBusy(true);
    const path = isNewUser ? "/api/auth/signup" : "/api/auth/login";
    const body = isNewUser
      ? { email, password, displayName: displayName || undefined }
      : { email, password };
    const res = await apiFetch<AuthResult>(path, { method: "POST", body, noAuth: true });
    setBusy(false);

    if (!res.success) {
      const msg = res.error?.message ?? "Authentication failed";
      if (/not found|does not exist/i.test(msg)) {
        setError("No account found. Click 'Create account' below.");
        setIsNewUser(true);
        return;
      }
      return setError(msg);
    }

    if (res.data?.mfaRequired) {
      setMfaToken(res.data.mfaToken ?? "");
      setAvailableMethods(res.data.availableMethods ?? ["totp"]);
      setMfaMethod((res.data.availableMethods ?? ["totp"])[0]);
      setStep("mfa");
      return;
    }

    if (res.data?.accessToken) {
      saveTokens(res.data.accessToken, res.data.refreshToken ?? "");
      navigate("/", { replace: true });
    }
  }

  async function submitMfa() {
    if (mfaCode.length !== 6 && mfaMethod !== "recovery_code") return setError("Enter all 6 digits");
    setBusy(true);
    setError("");
    const res = await apiFetch<AuthResult>("/api/auth/mfa/verify", {
      method: "POST",
      body: { mfaToken, code: mfaCode, method: mfaMethod, trustDevice: true },
      noAuth: true,
    });
    setBusy(false);
    if (!res.success || !res.data?.accessToken) {
      setMfaCode("");
      return setError(res.error?.message ?? "Invalid code");
    }
    saveTokens(res.data.accessToken, res.data.refreshToken ?? "");
    navigate("/", { replace: true });
  }

  async function sendMfaEmail() {
    setBusy(true);
    const res = await apiFetch<unknown>("/api/auth/mfa/challenge", {
      method: "POST",
      body: { mfaToken },
      noAuth: true,
    });
    setBusy(false);
    setInfo(res.success ? "Code sent to your email." : (res.error?.message ?? "Failed to send code"));
  }

  async function sendReset() {
    setBusy(true);
    const res = await apiFetch<unknown>("/api/auth/password/reset-request", {
      method: "POST",
      body: { email },
      noAuth: true,
    });
    setBusy(false);
    setInfo(res.success ? "Reset link sent — check your email." : (res.error?.message ?? "Failed"));
  }

  async function submitReset() {
    if (newPassword.length < 8) return setError("Password must be at least 8 characters");
    setBusy(true);
    const res = await apiFetch<AuthResult>("/api/auth/password/reset", {
      method: "POST",
      body: { token: resetToken, password: newPassword },
      noAuth: true,
    });
    setBusy(false);
    if (!res.success) return setError(res.error?.message ?? "Reset failed");
    setInfo("Password reset. Sign in below.");
    setStep("email");
  }

  function oauth(provider: "google" | "apple") {
    const redirectUri = window.location.origin + "/login";
    window.location.href = `/api/auth/oauth/${provider}?redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async function passkeyLogin() {
    setError("");
    setBusy(true);
    try {
      const optsRes = await apiFetch<Record<string, unknown> & { publicKey?: Record<string, unknown> }>(
        "/api/auth/passkey/login/options",
        { method: "POST", body: email ? { email } : {}, noAuth: true },
      );
      if (!optsRes.success || !optsRes.data) {
        return setError(optsRes.error?.message ?? "Failed to start passkey sign-in");
      }
      // Aldero may wrap the WebAuthn options under `publicKey` or return them flat — handle both.
      const optionsJSON = (optsRes.data.publicKey ?? optsRes.data) as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"];

      const assertion = await startAuthentication({ optionsJSON });

      const verifyRes = await apiFetch<AuthResult>("/api/auth/passkey/login/verify", {
        method: "POST",
        body: assertion,
        noAuth: true,
      });
      if (!verifyRes.success) {
        return setError(verifyRes.error?.message ?? "Passkey sign-in failed");
      }
      if (verifyRes.data?.mfaRequired) {
        setMfaToken(verifyRes.data.mfaToken ?? "");
        setAvailableMethods(verifyRes.data.availableMethods ?? ["totp"]);
        setMfaMethod((verifyRes.data.availableMethods ?? ["totp"])[0]);
        setStep("mfa");
        return;
      }
      if (verifyRes.data?.accessToken) {
        saveTokens(verifyRes.data.accessToken, verifyRes.data.refreshToken ?? "");
        navigate("/", { replace: true });
      }
    } catch (err) {
      const name = (err as Error).name;
      const msg = (err as Error).message;
      // User cancelled the browser prompt or no credentials available — treat softly.
      if (name === "NotAllowedError" || name === "AbortError") {
        setError("Passkey sign-in cancelled.");
      } else {
        setError(msg || "Passkey sign-in failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-xl p-6">
        <h1 className="text-xl font-semibold text-slate-100 mb-1">Quantara Admin</h1>
        <p className="text-sm text-slate-400 mb-6">
          {step === "email" && "Sign in to your account"}
          {step === "password" && (isNewUser ? "Create your account" : "Welcome back")}
          {step === "mfa" && "Verify your identity"}
          {step === "reset-password" && "Set a new password"}
        </p>

        {info && <div className="mb-3 p-2 text-xs rounded bg-emerald-950/40 text-emerald-300 border border-emerald-900">{info}</div>}
        {error && <div className="mb-3 p-2 text-xs rounded bg-red-950/40 text-red-300 border border-red-900">{error}</div>}

        {step === "email" && (
          <>
            <div className="space-y-2 mb-4">
              <button onClick={() => oauth("google")} className="w-full rounded-md border border-slate-700 bg-white text-slate-900 px-3 py-2 text-sm font-medium hover:bg-slate-100 transition">
                Continue with Google
              </button>
              <button onClick={() => oauth("apple")} className="w-full rounded-md border border-slate-700 bg-black text-white px-3 py-2 text-sm font-medium hover:bg-slate-900 transition">
                Continue with Apple
              </button>
              <button onClick={passkeyLogin} disabled={busy} className="w-full rounded-md border border-slate-700 bg-slate-800 text-slate-100 px-3 py-2 text-sm font-medium hover:bg-slate-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="8" cy="12" r="4" />
                  <path d="M12 12h10" />
                  <path d="M18 12v3" />
                  <path d="M22 12v2" />
                </svg>
                Sign in with passkey
              </button>
            </div>
            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px bg-slate-800" /><span className="text-xs text-slate-500">or</span><div className="flex-1 h-px bg-slate-800" />
            </div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startSignIn()}
              placeholder="you@example.com"
              className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
            <button onClick={startSignIn} disabled={busy}
              className="mt-3 w-full rounded-md bg-indigo-600 hover:bg-indigo-500 px-3 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
              Continue
            </button>
          </>
        )}

        {step === "password" && (
          <>
            <button onClick={() => { setStep("email"); setError(""); setInfo(""); setForgot(false); }} className="text-xs text-slate-500 hover:text-slate-300 mb-3">← Back</button>
            <p className="text-sm text-slate-300 mb-3">{email}</p>
            {isNewUser && (
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name"
                className="w-full mb-2 rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
            )}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitAuth()}
              placeholder={isNewUser ? "Create a password (8+ chars)" : "Enter your password"}
              autoComplete={isNewUser ? "new-password" : "current-password"}
              className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
            <button onClick={submitAuth} disabled={busy}
              className="mt-3 w-full rounded-md bg-indigo-600 hover:bg-indigo-500 px-3 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
              {isNewUser ? "Create account" : "Sign in"}
            </button>
            <div className="mt-3 flex justify-between items-center text-xs text-slate-500">
              {!isNewUser ? (
                <button onClick={() => setIsNewUser(true)} className="hover:text-slate-300">Create account</button>
              ) : (
                <button onClick={() => setIsNewUser(false)} className="hover:text-slate-300">Already have an account?</button>
              )}
              {!isNewUser && (
                <button onClick={() => setForgot(!forgot)} className="hover:text-slate-300">Forgot password?</button>
              )}
            </div>
            {forgot && !isNewUser && (
              <div className="mt-3 pt-3 border-t border-slate-800">
                <p className="text-xs text-slate-400 mb-2">Send a reset link to {email}</p>
                <button onClick={sendReset} disabled={busy}
                  className="w-full rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs text-slate-100 disabled:opacity-50">
                  Send reset link
                </button>
              </div>
            )}
          </>
        )}

        {step === "mfa" && (
          <>
            <button onClick={() => setStep("password")} className="text-xs text-slate-500 hover:text-slate-300 mb-3">← Back</button>
            {availableMethods.length > 1 && (
              <div className="flex border border-slate-700 rounded overflow-hidden mb-3">
                {availableMethods.includes("totp") && (
                  <button onClick={() => setMfaMethod("totp")}
                    className={`flex-1 px-3 py-1.5 text-xs ${mfaMethod === "totp" ? "bg-indigo-600 text-white" : "text-slate-400"}`}>
                    Authenticator
                  </button>
                )}
                {availableMethods.includes("email") && (
                  <button onClick={() => setMfaMethod("email")}
                    className={`flex-1 px-3 py-1.5 text-xs border-l border-slate-700 ${mfaMethod === "email" ? "bg-indigo-600 text-white" : "text-slate-400"}`}>
                    Email
                  </button>
                )}
              </div>
            )}
            <p className="text-xs text-slate-400 mb-2">
              {mfaMethod === "email" ? "Enter the 6-digit code sent to your email" : "Enter the 6-digit code from your authenticator app"}
            </p>
            {mfaMethod === "email" && (
              <button onClick={sendMfaEmail} disabled={busy} className="w-full mb-3 rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs text-slate-100 disabled:opacity-50">
                Send code
              </button>
            )}
            <input type="text" inputMode="numeric" maxLength={6} value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && submitMfa()}
              placeholder="000000"
              className="w-full text-center tracking-[0.5em] rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-lg text-slate-100 focus:outline-none focus:border-indigo-500" />
            <button onClick={submitMfa} disabled={busy}
              className="mt-3 w-full rounded-md bg-indigo-600 hover:bg-indigo-500 px-3 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
              Verify
            </button>
            <button onClick={() => { setMfaMethod("recovery_code"); setMfaCode(""); }} className="mt-2 w-full text-xs text-slate-500 hover:text-slate-300">
              Use recovery code
            </button>
          </>
        )}

        {step === "reset-password" && (
          <>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (8+ chars)" autoComplete="new-password"
              className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
            <button onClick={submitReset} disabled={busy}
              className="mt-3 w-full rounded-md bg-indigo-600 hover:bg-indigo-500 px-3 py-2 text-sm font-semibold text-white transition disabled:opacity-50">
              Reset password
            </button>
          </>
        )}
      </div>
    </div>
  );
}
