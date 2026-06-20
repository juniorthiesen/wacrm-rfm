"use client";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  DEFAULT_THEME,
  STORAGE_KEY,
  isThemeId,
  type ThemeId,
} from "@/lib/themes";

/**
 * ThemeProvider — wraps the whole app, exposes the active theme.
 *
 * The boot script in `src/app/layout.tsx` has already applied
 * `document.documentElement.dataset.theme` before React hydrates, so
 * by the time this Provider mounts the page is already painted in the
 * right colors. The DOM attribute is therefore the source of truth.
 *
 * We read it via `useSyncExternalStore`, which is the React-sanctioned
 * way to subscribe to an external (client-only) value with SSR support:
 * it renders the server snapshot (DEFAULT_THEME) during hydration to
 * match the server HTML, then re-reads the real value afterwards — no
 * setState-in-effect, no hydration mismatch.
 *
 * Persistence is localStorage only (device-scoped). A future follow-up
 * could mirror to `profiles.preferences` for cross-device sync, but a
 * per-device choice is also defensible — your phone may deserve a
 * different theme than your laptop.
 */

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (next: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// --- External theme store (DOM attribute + localStorage) -------------

const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  // Cross-tab sync — if you change the theme in tab A, tab B catches up
  // without a refresh. The other tab only touched its own DOM + the
  // shared localStorage, so mirror the value onto this tab's attribute
  // (which getSnapshot reads from) before notifying.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || !isThemeId(e.newValue)) return;
    document.documentElement.dataset.theme = e.newValue;
    callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): ThemeId {
  // Whatever the boot script applied is the truth. Fall back to
  // localStorage / default if the attribute is missing (e.g. someone
  // bypassed the boot script in a custom layout).
  const fromAttr = document.documentElement.dataset.theme;
  if (isThemeId(fromAttr)) return fromAttr;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
  }
  return DEFAULT_THEME;
}

function getServerSnapshot(): ThemeId {
  return DEFAULT_THEME;
}

function writeTheme(next: ThemeId) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = next;
  }
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Same private-browsing edge case as above; the attribute still
    // updates so the current tab works for the session.
  }
  // Notify local subscribers — the `storage` event does not fire in the
  // tab that made the change, so we push the update ourselves.
  for (const l of listeners) l();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <ThemeContext.Provider value={{ theme, setTheme: writeTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider — return a
    // no-op setter so callers don't crash. The boot script still
    // applied the right CSS attribute, so visually the page is fine.
    return {
      theme: DEFAULT_THEME,
      setTheme: () => {},
    };
  }
  return ctx;
}
