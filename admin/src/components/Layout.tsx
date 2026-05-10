import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";

import { clearTokens, currentUser } from "../lib/auth";
import { useTheme } from "../lib/theme";

interface LayoutProps {
  children: ReactNode;
  /** Use the full-bleed shell (no max-width container, no main padding). For 3-column workstation layouts. */
  bleed?: boolean;
}

export function Layout({ children, bleed = false }: LayoutProps) {
  const navigate = useNavigate();
  const user = currentUser();
  const { theme, toggle } = useTheme();

  function logout() {
    clearTokens();
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-full flex flex-col bg-paper text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur">
        <div className="px-4 h-12 flex items-center gap-6">
          <Brand />
          <nav className="flex gap-0.5 text-sm overflow-x-auto rail-scroll min-w-0">
            <Tab to="/">Overview</Tab>
            <Tab to="/market">Market</Tab>
            <Tab to="/news">News</Tab>
            <Tab to="/whitelist">Whitelist</Tab>
            <Tab to="/ratifications">Ratifications</Tab>
            <Tab to="/genie">Genie</Tab>
            <Tab to="/performance">Performance</Tab>
            <Tab to="/pipeline">Pipeline</Tab>
            <Tab to="/health">Health</Tab>
            <Tab to="/activity">Activity</Tab>
            <Tab to="/pnl">PnL</Tab>
            <Tab to="/admin/glossary">Glossary</Tab>
          </nav>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <ThemeToggle theme={theme} onToggle={toggle} />
            <span className="text-xs text-muted2 hidden sm:inline">{user?.email}</span>
            <button
              onClick={logout}
              className="text-xs text-muted hover:text-ink transition-colors focus-ring rounded px-1.5 py-0.5"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className={`flex-1 ${bleed ? "" : "max-w-7xl w-full mx-auto px-4 py-6"}`}>
        {children}
      </main>

      <StatusBar />
    </div>
  );
}

function Brand() {
  return (
    <NavLink to="/" className="flex items-center gap-2 shrink-0 focus-ring rounded">
      <span className="inline-block w-1.5 h-5 bg-brand rounded-sm" aria-hidden="true" />
      <span className="font-semibold text-sm tracking-tight text-ink">Quantara</span>
      <span className="text-2xs uppercase tracking-widest text-muted2 hidden sm:inline">
        Admin
      </span>
    </NavLink>
  );
}

function Tab({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      end
      to={to}
      className={({ isActive }) =>
        `whitespace-nowrap px-3 py-1.5 rounded-md text-sm transition-colors focus-ring ${
          isActive
            ? "bg-sunken text-ink font-medium"
            : "text-muted hover:text-ink hover:bg-sunken/60"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: "light" | "dark"; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      className="text-muted hover:text-ink transition-colors p-1.5 rounded focus-ring"
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function StatusBar() {
  return (
    <footer className="border-t border-line bg-paper/85 backdrop-blur">
      <div className="px-4 h-7 flex items-center gap-3 text-2xs uppercase tracking-widest text-muted2">
        <span className="inline-flex items-center gap-1.5">
          <span className="relative inline-block w-1.5 h-1.5">
            <span className="absolute inset-0 rounded-full bg-up" />
            <span className="absolute inset-0 rounded-full bg-up animate-ping opacity-50" />
          </span>
          <span>Markets · all systems normal</span>
        </span>
        <span className="ml-auto num normal-case tracking-normal text-muted2">
          {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </footer>
  );
}
