"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, Download, Loader2, ChevronLeft, ChevronRight, Users } from "lucide-react";
import { useTranslation } from "@/hooks/use-translation";

// Segment drill-down: a row of clickable segment blocks (sized by share)
// that loads the segment's customers into a searchable, paginated table
// with CSV export. Turns the RFM page from "look at" into "act on".

export type SegmentKey =
  | "champion"
  | "loyal"
  | "new_customer"
  | "about_to_sleep"
  | "in_risk"
  | "hibernating"
  | "lost"
  | "new_lead";

interface SegmentRow {
  key: SegmentKey;
  count: number;
  customers_pct: number;
}

interface SegmentContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  monetary_value: number;
  recency_days: number | null;
  frequency_count: number | null;
}

interface SegmentExplorerProps {
  segments: SegmentRow[];
  colors: Record<SegmentKey, string>;
  locale: string;
}

function formatCurrency(v: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "BRL",
      maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `R$ ${v.toFixed(0)}`;
  }
}

export function SegmentExplorer({ segments, colors, locale }: SegmentExplorerProps) {
  const { t } = useTranslation();
  // Default to the largest non-empty segment so the panel isn't blank.
  const ordered = [...segments]
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);
  const [active, setActive] = useState<SegmentKey | null>(ordered[0]?.key ?? null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(0);
  const [contacts, setContacts] = useState<SegmentContact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Debounce the search box so we don't fetch on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Reset to page 0 whenever the segment or the search term changes.
  useEffect(() => {
    setPage(0);
  }, [active, debounced]);

  const fetchPage = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        segment: active,
        page: String(page),
      });
      if (debounced) params.set("search", debounced);
      const res = await fetch(`/api/rfm/segment-contacts?${params}`, {
        cache: "no-store",
      });
      const json = await res.json();
      setContacts(json.contacts ?? []);
      setTotal(json.total ?? 0);
    } catch {
      setContacts([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [active, page, debounced]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  function handleExport() {
    if (!active) return;
    setExporting(true);
    // Hit the export endpoint in a hidden navigation so the browser
    // saves the CSV without us buffering it in memory.
    const url = `/api/rfm/segment-contacts?segment=${active}&export=1`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `rfm_${active}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // No reliable "download finished" event; clear the spinner shortly.
    setTimeout(() => setExporting(false), 1500);
  }

  const pageSize = 50;
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">
            {t("rfm.explorerTitle")}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {t("rfm.explorerDesc")}
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={!active || exporting || total === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-40"
        >
          {exporting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          {t("rfm.exportCsv")}
        </button>
      </div>

      {/* Segment blocks — width proportional to share, click to select. */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        {ordered.map((s) => {
          const isActive = s.key === active;
          return (
            <button
              key={s.key}
              onClick={() => setActive(s.key)}
              style={{
                background: isActive ? colors[s.key] : `${colors[s.key]}26`,
                borderColor: colors[s.key],
              }}
              className={`flex min-w-[120px] flex-1 flex-col items-start rounded-lg border px-3 py-2 text-left transition-all ${
                isActive ? "ring-2 ring-offset-2 ring-offset-slate-900" : "opacity-80 hover:opacity-100"
              }`}
            >
              <span
                className={`text-xs font-semibold ${isActive ? "text-slate-900" : "text-white"}`}
              >
                {t(`inbox.commerce.segments.${s.key}`)}
              </span>
              <span
                className={`text-[11px] tabular-nums ${isActive ? "text-slate-900/80" : "text-slate-400"}`}
              >
                {s.count.toLocaleString(locale)} · {s.customers_pct.toFixed(1)}%
              </span>
            </button>
          );
        })}
      </div>

      {/* Search + count */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("rfm.searchContacts")}
            className="w-full rounded-md border border-slate-700 bg-slate-800 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
          />
        </div>
        <span className="text-xs text-slate-500">
          {total.toLocaleString(locale)} {t("rfm.contactsLabel")}
        </span>
      </div>

      {/* Contacts table */}
      <div className="mt-3 overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">{t("rfm.colName")}</th>
              <th className="hidden px-3 py-2 font-medium sm:table-cell">{t("rfm.colPhone")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("rfm.colSpent")}</th>
              <th className="hidden px-3 py-2 text-right font-medium md:table-cell">{t("rfm.colRecency")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading ? (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center">
                  <Loader2 className="mx-auto size-5 animate-spin text-primary" />
                </td>
              </tr>
            ) : contacts.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-xs text-slate-500">
                  <Users className="mx-auto mb-2 size-5 text-slate-600" />
                  {t("rfm.noContacts")}
                </td>
              </tr>
            ) : (
              contacts.map((c) => (
                <tr key={c.id} className="hover:bg-slate-800/40">
                  <td className="px-3 py-2">
                    <div className="font-medium text-white">{c.name || "—"}</div>
                    {c.email && (
                      <div className="text-[11px] text-slate-500">{c.email}</div>
                    )}
                  </td>
                  <td className="hidden px-3 py-2 font-mono text-xs text-slate-400 sm:table-cell">
                    {c.phone || "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                    {formatCurrency(c.monetary_value, locale)}
                  </td>
                  <td className="hidden px-3 py-2 text-right tabular-nums text-slate-400 md:table-cell">
                    {c.recency_days != null
                      ? t("rfm.daysAgo").replace("{d}", String(c.recency_days))
                      : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > pageSize && (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-slate-400">
          <span>
            {page + 1} / {lastPage + 1}
          </span>
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
            className="rounded-md border border-slate-700 bg-slate-800 p-1.5 hover:bg-slate-700 disabled:opacity-40"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            disabled={page >= lastPage || loading}
            className="rounded-md border border-slate-700 bg-slate-800 p-1.5 hover:bg-slate-700 disabled:opacity-40"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      )}
    </section>
  );
}
