"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { translations, type Locale } from "@/lib/i18n/translations";

const STORAGE_KEY = "wacrm-language";
const DEFAULT_LOCALE: Locale = "en";

interface LanguageContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function readInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "pt-BR") return stored as Locale;
  } catch {
    // localStorage might throw in sandboxed contexts
  }
  
  // Fallback to browser language
  try {
    const browserLang = navigator.language;
    if (browserLang.startsWith("pt")) return "pt-BR";
  } catch {
    // navigator might not be available
  }
  
  return DEFAULT_LOCALE;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    if (typeof document !== "undefined") {
      document.documentElement.lang = next;
    }
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore private browsing exceptions
    }
  }, []);

  // Read preferred locale on mount (client-only) to avoid hydration mismatch
  useEffect(() => {
    const preferredLocale = readInitialLocale();
    if (preferredLocale !== DEFAULT_LOCALE) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocaleState(preferredLocale);
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = preferredLocale;
    }
  }, []);

  // Sync lang attribute when locale changes afterwards
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  // Translate helper function supporting dot notation, e.g. t('nav.dashboard')
  const t = useCallback((path: string): string => {
    const dict = translations[locale] || translations[DEFAULT_LOCALE];
    const parts = path.split(".");
    let current: unknown = dict;
    
    for (const part of parts) {
      if (current == null || typeof current !== "object") {
        return path;
      }
      current = (current as Record<string, unknown>)[part];
    }
    
    return typeof current === "string" ? current : path;
  }, [locale]);

  // Sync from other tabs
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      if ((e.newValue === "en" || e.newValue === "pt-BR") && e.newValue !== locale) {
        setLocaleState(e.newValue as Locale);
        document.documentElement.lang = e.newValue;
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [locale]);

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useTranslation(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    // Return safe fallback if rendered outside provider
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      t: (key: string) => {
        const parts = key.split(".");
        let current: unknown = translations[DEFAULT_LOCALE];
        for (const part of parts) {
          if (current == null || typeof current !== "object") return key;
          current = (current as Record<string, unknown>)[part];
        }
        return typeof current === "string" ? current : key;
      }
    };
  }
  return ctx;
}
