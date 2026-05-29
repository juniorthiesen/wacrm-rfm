"use client";

import { Check } from "lucide-react";

import { useTheme } from "@/hooks/use-theme";
import { useTranslation } from "@/hooks/use-translation";
import { THEMES, type ThemeId } from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * Appearance panel — color-theme picker and language selector.
 *
 * Click a card → applies + persists immediately. No save button:
 * the whole change is a single CSS-variable swap on <html>, there's
 * nothing to roll back. The active card carries a check chip + a
 * primary-tinted border so the current pick is obvious.
 *
 * Persistence: localStorage only (device-scoped). The boot script in
 * layout.tsx replays the choice before first paint on subsequent
 * loads.
 */
export function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale, t } = useTranslation();

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">{t("settings.appearance.themeTitle")}</h2>
        <p className="mt-1 text-sm text-slate-400">
          {t("settings.appearance.themeSubtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {THEMES.map((tItem) => (
          <ThemeCard
            key={tItem.id}
            id={tItem.id}
            name={t(`settings.appearance.themes.${tItem.id}.name`)}
            tagline={t(`settings.appearance.themes.${tItem.id}.tagline`)}
            swatch={tItem.swatch}
            isActive={tItem.id === theme}
            onPick={() => setTheme(tItem.id)}
            activeLabel={t("settings.appearance.active")}
          />
        ))}
      </div>

      <div className="border-t border-slate-800 my-8 pt-8 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-white">{t("settings.appearance.langTitle")}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {t("settings.appearance.langSubtitle")}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <button
            type="button"
            onClick={() => setLocale("en")}
            aria-pressed={locale === "en"}
            className={cn(
              "flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
              locale === "en"
                ? "border-primary/60 ring-2 ring-primary/40"
                : "border-slate-800 hover:border-slate-700 hover:bg-slate-800/40",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-2xl" aria-hidden>🇺🇸</span>
              {locale === "en" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                  <Check className="h-3 w-3" />
                  {t("settings.appearance.active")}
                </span>
              )}
            </div>
            <div>
              <div className="text-sm font-semibold text-white">{t("settings.appearance.enLabel")}</div>
              <div className="mt-1 text-xs text-slate-400">{t("settings.appearance.enDesc")}</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setLocale("pt-BR")}
            aria-pressed={locale === "pt-BR"}
            className={cn(
              "flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
              locale === "pt-BR"
                ? "border-primary/60 ring-2 ring-primary/40"
                : "border-slate-800 hover:border-slate-700 hover:bg-slate-800/40",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-2xl" aria-hidden>🇧🇷</span>
              {locale === "pt-BR" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                  <Check className="h-3 w-3" />
                  {t("settings.appearance.active")}
                </span>
              )}
            </div>
            <div>
              <div className="text-sm font-semibold text-white">{t("settings.appearance.ptLabel")}</div>
              <div className="mt-1 text-xs text-slate-400">{t("settings.appearance.ptDesc")}</div>
            </div>
          </button>
        </div>
      </div>
    </section>
  );
}

function ThemeCard({
  id,
  name,
  tagline,
  swatch,
  isActive,
  onPick,
  activeLabel,
}: {
  id: ThemeId;
  name: string;
  tagline: string;
  swatch: string;
  isActive: boolean;
  onPick: () => void;
  activeLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={isActive}
      aria-label={`Use ${name} theme`}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-slate-800 hover:border-slate-700 hover:bg-slate-800/40",
      )}
    >
      <div className="flex items-center justify-between">
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 rounded-full"
          style={{
            background: swatch,
            boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.15)",
          }}
        />
        {isActive && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
            <Check className="h-3 w-3" />
            {activeLabel}
          </span>
        )}
      </div>
      <div>
        <div className="text-sm font-semibold text-white">{name}</div>
        <div className="mt-1 text-xs leading-relaxed text-slate-400">
          {tagline}
        </div>
      </div>
      <div
        className="mt-1 flex h-2 overflow-hidden rounded-full"
        aria-hidden
      >
        <span className="flex-1" style={{ background: swatch }} />
        <span className="w-3 bg-slate-700" />
        <span className="w-3 bg-slate-800" />
        <span className="w-3 bg-slate-900" />
      </div>
      <span className="sr-only">Theme id: {id}</span>
    </button>
  );
}
