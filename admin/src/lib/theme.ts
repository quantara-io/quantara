import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "quantara-theme";
const DEFAULT_THEME: Theme = "dark";

function readStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    // ignore
  }
  return DEFAULT_THEME;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function useTheme(): { theme: Theme; toggle: () => void; set: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  return {
    theme,
    toggle: () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
    set: setThemeState,
  };
}
