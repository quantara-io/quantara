import { useEffect, useRef, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

interface Section {
  label: string;
  to: string;
}

// All 13 routes grouped in 2 columns (left / right pairs)
const SECTION_PAIRS: [Section, Section | null][] = [
  [
    { label: "Workstation", to: "/" },
    { label: "Signals", to: "/genie" },
  ],
  [
    { label: "Market", to: "/market" },
    { label: "News", to: "/news" },
  ],
  [
    { label: "Whitelist", to: "/whitelist" },
    { label: "Ratifications", to: "/ratifications" },
  ],
  [
    { label: "Performance", to: "/performance" },
    { label: "Health", to: "/health" },
  ],
  [
    { label: "Pipeline", to: "/pipeline" },
    { label: "Activity", to: "/activity" },
  ],
  [
    { label: "Ops", to: "/ops" },
    { label: "PnL", to: "/pnl" },
  ],
  [{ label: "Glossary", to: "/admin/glossary" }, null],
];

// Flattened list for keyboard navigation
const ALL_SECTIONS: Section[] = SECTION_PAIRS.flatMap(([left, right]) =>
  right ? [left, right] : [left],
);

interface SectionsPopoverProps {
  onClose: () => void;
}

export function SectionsPopover({ onClose }: SectionsPopoverProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedIndexRef = useRef<number>(-1);

  // Close on outside click
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  // Close on Esc, handle arrow key navigation
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items =
        containerRef.current?.querySelectorAll<HTMLButtonElement>("[data-section-item]");
      if (!items || items.length === 0) return;
      const len = items.length;
      if (e.key === "ArrowDown") {
        focusedIndexRef.current = (focusedIndexRef.current + 1) % len;
      } else {
        focusedIndexRef.current = (focusedIndexRef.current - 1 + len) % len;
      }
      items[focusedIndexRef.current]?.focus();
    }
  }

  function isActive(to: string): boolean {
    if (to === "/") return location.pathname === "/";
    return location.pathname === to || location.pathname.startsWith(to + "/");
  }

  function navigate2(to: string) {
    navigate(to);
    onClose();
  }

  return (
    // Backdrop — catches outside clicks via the mousedown handler above
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Sections"
      aria-modal="true"
      className="absolute right-0 top-full mt-1.5 z-50 w-64 rounded-lg border border-line bg-paper shadow-lg ring-1 ring-black/5 dark:ring-white/5 focus:outline-none"
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="px-3 pt-3 pb-1.5">
        <span className="text-2xs font-semibold uppercase tracking-widest text-muted2">
          Sections
        </span>
      </div>

      {/* 2-col grid */}
      <div className="px-2 pb-2">
        {SECTION_PAIRS.map(([left, right], rowIdx) => (
          <div key={rowIdx} className="grid grid-cols-2 gap-0.5">
            <SectionItem section={left} active={isActive(left.to)} onNavigate={navigate2} />
            {right ? (
              <SectionItem section={right} active={isActive(right.to)} onNavigate={navigate2} />
            ) : (
              <div />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Expose ALL_SECTIONS for tests
export { ALL_SECTIONS };

interface SectionItemProps {
  section: Section;
  active: boolean;
  onNavigate: (to: string) => void;
}

function SectionItem({ section, active, onNavigate }: SectionItemProps) {
  return (
    <button
      type="button"
      data-section-item
      onClick={() => onNavigate(section.to)}
      className={`flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm transition-colors focus-ring text-left ${
        active ? "text-ink font-medium" : "text-muted hover:text-ink hover:bg-sunken/60"
      }`}
      aria-current={active ? "page" : undefined}
    >
      {/* Bullet dot — filled brand color when active, hollow otherwise */}
      <span
        className={`shrink-0 w-1.5 h-1.5 rounded-full ${
          active ? "bg-brand" : "border border-line-strong bg-transparent"
        }`}
        aria-hidden="true"
      />
      {section.label}
    </button>
  );
}
