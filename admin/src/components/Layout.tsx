import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";

import { clearTokens, currentUser } from "../lib/auth";

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const user = currentUser();

  function logout() {
    clearTokens();
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-full">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-6">
          <span className="font-semibold text-cyan-400 text-sm tracking-wide">QUANTARA · ADMIN</span>
          <nav className="flex gap-1 text-sm">
            <Tab to="/">Overview</Tab>
            <Tab to="/market">Market</Tab>
            <Tab to="/news">News</Tab>
            <Tab to="/whitelist">Whitelist</Tab>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-slate-400">
            <span>{user?.email}</span>
            <button onClick={logout} className="text-slate-500 hover:text-slate-300">Sign out</button>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

function Tab({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink end to={to}
      className={({ isActive }) =>
        `px-3 py-1.5 rounded ${isActive ? "bg-slate-800 text-cyan-300" : "text-slate-400 hover:text-slate-100"}`}>
      {children}
    </NavLink>
  );
}
