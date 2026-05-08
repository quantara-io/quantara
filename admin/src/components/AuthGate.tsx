import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { currentUser, isAdmin } from "../lib/auth";

export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const user = currentUser();
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!isAdmin()) return <NotAdmin />;
  return <>{children}</>;
}

function NotAdmin() {
  return (
    <div className="min-h-full flex items-center justify-center px-4 py-12">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold text-slate-100 mb-2">Admin access required</h1>
        <p className="text-sm text-slate-400 mb-4">Your account is signed in but does not have the admin role.</p>
        <button
          onClick={() => { localStorage.clear(); window.location.href = "/login"; }}
          className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-2 text-sm text-slate-100"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
