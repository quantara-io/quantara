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
        <h1 className="text-lg font-semibold text-ink mb-2">Admin access required</h1>
        <p className="text-sm text-muted mb-4">
          Your account is signed in but does not have the admin role.
        </p>
        <button
          onClick={() => {
            localStorage.clear();
            window.location.href = "/login";
          }}
          className="rounded-md bg-sunken hover:bg-line px-3 py-2 text-sm text-ink"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
