import { useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

import { clearTokens, currentUser } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { SectionsPopover } from "./SectionsPopover";

interface LayoutProps {
  children: ReactNode;
  /** Use the full-bleed shell (no max-width container, no main padding). For 3-column workstation layouts. */
  bleed?: boolean;
}

// Map path prefixes → human-readable section labels shown next to the brand
const SECTION_LABELS: [string, string][] = [
  ["/market", "Market"],
  ["/news", "News"],
  ["/genie", "Signals"],
  ["/performance", "Performance"],
  ["/pnl", "PnL"],
  ["/whitelist", "Whitelist"],
  ["/ratifications", "Ratifications"],
  ["/pipeline", "Pipeline"],
  ["/health", "Health"],
  ["/activity", "Activity"],
  ["/ops", "Ops"],
  ["/admin/glossary", "Glossary"],
];

function useSectionLabel(): string {
  const location = useLocation();
  for (const [prefix, label] of SECTION_LABELS) {
    if (location.pathname === prefix || location.pathname.startsWith(prefix + "/")) {
      return label;
    }
  }
  return "Workstation";
}

export function Layout({ children, bleed = false }: LayoutProps) {
  const navigate = useNavigate();
  const user = currentUser();
  const { theme, toggle } = useTheme();
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const sectionsTriggerRef = useRef<HTMLButtonElement>(null);
  const sectionLabel = useSectionLabel();

  function logout() {
    clearTokens();
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-full flex flex-col bg-paper text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur">
        <div className="px-4 h-12 flex items-center gap-3">
          {/* ── Left: brand + active section label ── */}
          <div className="flex items-center gap-2 shrink-0">
            <NavLink to="/" className="flex items-center gap-2 focus-ring rounded">
              <span className="inline-block w-1.5 h-5 bg-brand rounded-sm" aria-hidden="true" />
              <span className="font-semibold text-sm tracking-tight text-ink">Quantara</span>
            </NavLink>
            {sectionLabel && (
              <>
                <span className="text-muted2 text-sm" aria-hidden="true">
                  /
                </span>
                <span className="text-sm text-muted2">{sectionLabel}</span>
              </>
            )}
          </div>

          {/* ── Center: search placeholder ── */}
          <div className="flex-1 flex justify-center">
            <div
              className="hidden sm:flex items-center gap-2 px-3 h-8 rounded-md border border-line bg-sunken/60 text-muted text-sm cursor-default select-none w-full max-w-xs"
              role="search"
              aria-label="Search markets, signals (coming soon)"
            >
              <SearchIcon />
              <span className="flex-1 text-muted2">Search markets, signals…</span>
              <kbd className="text-2xs text-muted2 font-mono bg-paper border border-line rounded px-1">
                ⌘K
              </kbd>
            </div>
          </div>

          {/* ── Right cluster ── */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Grid / Sections icon */}
            <div className="relative">
              <button
                ref={sectionsTriggerRef}
                type="button"
                aria-label="Sections"
                aria-expanded={sectionsOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  setSectionsOpen((o) => !o);
                  setAvatarOpen(false);
                }}
                className={`p-1.5 rounded transition-colors focus-ring ${
                  sectionsOpen
                    ? "text-ink bg-sunken"
                    : "text-muted hover:text-ink hover:bg-sunken/60"
                }`}
              >
                <GridIcon />
              </button>
              {sectionsOpen && (
                <SectionsPopover
                  onClose={() => setSectionsOpen(false)}
                  triggerRef={sectionsTriggerRef}
                />
              )}
            </div>

            {/* Notification bell (visual-only for now) */}
            <button
              type="button"
              aria-label="Notifications"
              className="relative p-1.5 rounded text-muted hover:text-ink hover:bg-sunken/60 transition-colors focus-ring"
            >
              <BellIcon />
              {/* Unread dot */}
              <span
                className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-brand"
                aria-hidden="true"
              />
            </button>

            {/* Avatar / user menu */}
            <div className="relative">
              <button
                type="button"
                aria-label="User menu"
                aria-expanded={avatarOpen}
                aria-haspopup="menu"
                onClick={() => {
                  setAvatarOpen((o) => !o);
                  setSectionsOpen(false);
                }}
                className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs font-semibold transition-colors focus-ring ${
                  avatarOpen
                    ? "border-brand bg-brand-soft text-brand"
                    : "border-line bg-sunken text-muted hover:border-brand/60"
                }`}
              >
                {user?.email ? user.email[0].toUpperCase() : "U"}
              </button>

              {avatarOpen && (
                <AvatarMenu
                  email={user?.email}
                  theme={theme}
                  onToggleTheme={toggle}
                  onLogout={logout}
                  onClose={() => setAvatarOpen(false)}
                />
              )}
            </div>
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

// ── Avatar dropdown menu ──────────────────────────────────────────────────────

interface AvatarMenuProps {
  email: string | undefined;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onLogout: () => void;
  onClose: () => void;
}

function AvatarMenu({ email, theme, onToggleTheme, onLogout, onClose }: AvatarMenuProps) {
  return (
    <>
      {/* invisible overlay to catch outside clicks */}
      <div className="fixed inset-0 z-40" aria-hidden="true" onMouseDown={onClose} />
      <div
        role="menu"
        aria-label="User menu"
        className="absolute right-0 top-full mt-1.5 z-50 w-52 rounded-lg border border-line bg-paper shadow-lg ring-1 ring-black/5 dark:ring-white/5 py-1"
      >
        {email && (
          <div className="px-3 py-2 border-b border-line">
            <p className="text-xs text-muted2 truncate">{email}</p>
          </div>
        )}

        {/* Theme toggle */}
        <button
          type="button"
          role="menuitem"
          onClick={onToggleTheme}
          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-muted hover:text-ink hover:bg-sunken/60 transition-colors focus-ring"
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>

        {/* Sign out */}
        <button
          type="button"
          role="menuitem"
          onClick={onLogout}
          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-muted hover:text-ink hover:bg-sunken/60 transition-colors focus-ring"
        >
          <SignOutIcon />
          Sign out
        </button>
      </div>
    </>
  );
}

// ── Status bar ────────────────────────────────────────────────────────────────

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

// ── Icons ─────────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
