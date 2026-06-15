"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Users,
  DollarSign,
  Clock,
  ShoppingCart,
  RefreshCw,
  Loader2,
  Target,
  AlertTriangle,
  Crown,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/use-translation";
import { SegmentExplorer } from "@/components/rfm/segment-explorer";

// RFM cockpit. Reads the aggregate from /api/rfm/insights once on mount
// and renders 4 metric cards + donut + revenue bars + R×F heatmap +
// two top-customer lists + auto-generated insights. Pure SVG charts —
// no chart library, follows the existing /dashboard widgets' approach.

type SegmentKey =
  | "champion"
  | "loyal"
  | "new_customer"
  | "about_to_sleep"
  | "in_risk"
  | "hibernating"
  | "lost"
  | "new_lead";

// Mirror inbox/commerce-section.tsx so segments are visually consistent
// across the app.
const SEGMENT_COLORS: Record<SegmentKey, string> = {
  champion: "#facc15",
  loyal: "#3b82f6",
  new_customer: "#10b981",
  about_to_sleep: "#eab308",
  in_risk: "#f97316",
  hibernating: "#a855f7",
  lost: "#94a3b8",
  new_lead: "#06b6d4",
};

interface SegmentRow {
  key: SegmentKey;
  count: number;
  revenue: number;
  customers_pct: number;
  revenue_pct: number;
  avg_ticket: number;
}

interface TopContact {
  contact_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  monetary_value: number;
  recency_days: number | null;
  frequency_count: number | null;
}

interface HeatmapCell {
  r: number;
  f: number;
  count: number;
  revenue: number;
}

interface Insights {
  total_customers: number;
  total_revenue: number;
  avg_recency_days: number | null;
  avg_ticket: number;
  last_calculated_at: string | null;
  segments: SegmentRow[];
  heatmap: HeatmapCell[];
  top_champions: TopContact[];
  top_at_risk: TopContact[];
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

function compactNumber(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

export default function RfmPage() {
  const { t, locale } = useTranslation();
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/rfm/insights", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRecalculate() {
    setRecalculating(true);
    try {
      const res = await fetch("/api/rfm/recalculate", { method: "POST" });
      if (res.ok) {
        toast.success(t("rfm.recalculated"));
        await load();
      } else {
        toast.error(t("rfm.recalculateError"));
      }
    } finally {
      setRecalculating(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="flex h-96 items-center justify-center text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  if (!data || data.total_customers === 0) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <Target className="mx-auto h-12 w-12 text-slate-600" />
        <h1 className="mt-4 text-xl font-semibold text-white">
          {t("rfm.emptyTitle")}
        </h1>
        <p className="mt-2 text-sm text-slate-400">{t("rfm.emptyDesc")}</p>
      </div>
    );
  }

  const insights = buildAutoInsights(data, locale, t);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">
            {t("rfm.title")}
          </h1>
          <p className="mt-1 text-sm text-slate-400">{t("rfm.subtitle")}</p>
          {data.last_calculated_at && (
            <p className="mt-1 text-xs text-slate-600">
              {t("rfm.lastCalculated")}:{" "}
              {new Date(data.last_calculated_at).toLocaleString(locale)}
            </p>
          )}
        </div>
        <Button
          onClick={handleRecalculate}
          disabled={recalculating}
          variant="outline"
          className="border-slate-700 bg-slate-800"
        >
          {recalculating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {t("rfm.recalculate")}
        </Button>
      </header>

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          icon={Users}
          label={t("rfm.metrics.customers")}
          value={compactNumber(data.total_customers)}
        />
        <MetricCard
          icon={DollarSign}
          label={t("rfm.metrics.totalRevenue")}
          value={formatCurrency(data.total_revenue, locale)}
        />
        <MetricCard
          icon={ShoppingCart}
          label={t("rfm.metrics.avgTicket")}
          value={formatCurrency(data.avg_ticket, locale)}
        />
        <MetricCard
          icon={Clock}
          label={t("rfm.metrics.avgRecency")}
          value={
            data.avg_recency_days != null
              ? `${data.avg_recency_days}d`
              : "—"
          }
        />
      </div>

      {/* Auto-insights */}
      {insights.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-white">
            {t("rfm.insightsTitle")}
          </h2>
          <ul className="mt-3 space-y-2">
            {insights.map((ins, i) => (
              <li
                key={i}
                className={`rounded-lg border p-3 text-sm ${
                  ins.severity === "warn"
                    ? "border-orange-500/30 bg-orange-500/10 text-orange-200"
                    : ins.severity === "good"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                      : "border-slate-700 bg-slate-800 text-slate-300"
                }`}
              >
                {ins.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Donut + Revenue bars */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-white">
            {t("rfm.distribution")}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {t("rfm.distributionDesc")}
          </p>
          <div className="mt-4">
            <SegmentDonut segments={data.segments} t={t} />
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-white">
            {t("rfm.revenueBySegment")}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {t("rfm.revenueBySegmentDesc")}
          </p>
          <ul className="mt-4 space-y-2">
            {[...data.segments]
              .sort((a, b) => b.revenue - a.revenue)
              .map((s) => (
                <li key={s.key}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-300">
                      {t(`inbox.commerce.segments.${s.key}`)}
                    </span>
                    <span className="tabular-nums text-slate-400">
                      {formatCurrency(s.revenue, locale)} ·{" "}
                      {s.revenue_pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full"
                      style={{
                        width: `${Math.min(s.revenue_pct, 100)}%`,
                        background: SEGMENT_COLORS[s.key],
                      }}
                    />
                  </div>
                </li>
              ))}
          </ul>
        </section>
      </div>

      {/* Segment explorer — click a segment to drill into its customers */}
      <SegmentExplorer
        segments={data.segments}
        colors={SEGMENT_COLORS}
        locale={locale}
      />

      {/* Heatmap */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-sm font-semibold text-white">
          {t("rfm.heatmapTitle")}
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {t("rfm.heatmapDesc")}
        </p>
        <div className="mt-4">
          <RFMHeatmap cells={data.heatmap} t={t} />
        </div>
      </section>

      {/* Top lists */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TopList
          icon={AlertTriangle}
          tone="warn"
          title={t("rfm.topAtRisk")}
          subtitle={t("rfm.topAtRiskDesc")}
          contacts={data.top_at_risk}
          locale={locale}
          t={t}
        />
        <TopList
          icon={Crown}
          tone="good"
          title={t("rfm.topChampions")}
          subtitle={t("rfm.topChampionsDesc")}
          contacts={data.top_champions}
          locale={locale}
          t={t}
        />
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-slate-500">
          {label}
        </p>
        <Icon className="h-4 w-4 text-slate-600" />
      </div>
      <p className="mt-2 text-xl font-semibold text-white tabular-nums">
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------
// Donut — segments as arcs on a 200x200 SVG ring. Same approach the
// pipeline-donut uses, but driven by RFM percentages instead of deal
// totals.
// ---------------------------------------------------------------------

function SegmentDonut({
  segments,
  t,
}: {
  segments: SegmentRow[];
  t: (key: string) => string;
}) {
  const size = 220;
  const r = 88;
  const ringWidth = 22;
  const cx = size / 2;
  const cy = size / 2;
  const total = segments.reduce((acc, s) => acc + s.count, 0) || 1;

  const minFrac = 0.015;
  const rawShares = segments.map((s) => s.count / total);
  const floored = rawShares.map((x) => (x > 0 ? Math.max(x, minFrac) : 0));
  const sumFloored = floored.reduce((a, b) => a + b, 0) || 1;
  const shares = floored.map((x) => x / sumFloored);

  const offsets: number[] = [0];
  for (let i = 0; i < shares.length; i++) offsets.push(offsets[i] + shares[i]);

  return (
    <div className="flex flex-col items-center gap-4 lg:flex-row lg:items-start">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-48 w-48"
        role="img"
        aria-label="Segment distribution"
      >
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="rgb(30 41 59)"
          strokeWidth={ringWidth}
        />
        {segments.map((s, i) => {
          if (s.count === 0) return null;
          const start = offsets[i] * Math.PI * 2 - Math.PI / 2;
          const end = offsets[i + 1] * Math.PI * 2 - Math.PI / 2;
          return (
            <path
              key={s.key}
              d={arcPath(cx, cy, r, start, end)}
              fill="none"
              stroke={SEGMENT_COLORS[s.key]}
              strokeWidth={ringWidth}
            />
          );
        })}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          className="fill-slate-500 text-[11px]"
        >
          {t("rfm.metrics.customers")}
        </text>
        <text
          x={cx}
          y={cy + 16}
          textAnchor="middle"
          className="fill-white text-[18px] font-semibold tabular-nums"
        >
          {compactNumber(total)}
        </text>
      </svg>
      <ul className="grid w-full flex-1 grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
              style={{ background: SEGMENT_COLORS[s.key] }}
            />
            <span className="flex-1 truncate text-slate-300">
              {t(`inbox.commerce.segments.${s.key}`)}
            </span>
            <span className="tabular-nums text-slate-500">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startRad: number,
  endRad: number,
): string {
  const x1 = cx + r * Math.cos(startRad);
  const y1 = cy + r * Math.sin(startRad);
  const x2 = cx + r * Math.cos(endRad);
  const y2 = cy + r * Math.sin(endRad);
  const large = endRad - startRad > Math.PI ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

// ---------------------------------------------------------------------
// R×F Heatmap — 5x5 grid. Background opacity scales with the cell's
// share of total customers. Reading: top-left (low recency, low freq)
// = "no compraram há muito e raramente"; bottom-right (high R, high F)
// = champions.
// ---------------------------------------------------------------------

function RFMHeatmap({
  cells,
  t,
}: {
  cells: HeatmapCell[];
  t: (key: string) => string;
}) {
  const maxCount = Math.max(1, ...cells.map((c) => c.count));

  // Grid: rows are Recency (5 best → 1 worst), columns are Frequency
  // (1 → 5). Layout follows the conventional RFM matrix.
  return (
    <div className="overflow-x-auto">
      <div className="inline-grid grid-cols-[auto_repeat(5,minmax(56px,1fr))] gap-1">
        <div />
        {[1, 2, 3, 4, 5].map((f) => (
          <div
            key={`fh-${f}`}
            className="px-2 text-center text-[10px] uppercase tracking-wider text-slate-500"
          >
            F{f}
          </div>
        ))}
        {[5, 4, 3, 2, 1].map((r) => (
          <div key={`row-${r}`} className="contents">
            <div className="flex items-center justify-end pr-2 text-[10px] uppercase tracking-wider text-slate-500">
              R{r}
            </div>
            {[1, 2, 3, 4, 5].map((f) => {
              const cell = cells.find((c) => c.r === r && c.f === f) ?? {
                r,
                f,
                count: 0,
                revenue: 0,
              };
              const opacity = cell.count === 0 ? 0.05 : 0.15 + (cell.count / maxCount) * 0.7;
              return (
                <div
                  key={`c-${r}-${f}`}
                  className="flex aspect-square min-w-14 flex-col items-center justify-center rounded text-center"
                  style={{
                    background: `rgba(99, 102, 241, ${opacity})`,
                  }}
                  title={`R${r}·F${f} · ${cell.count} ${t("rfm.metrics.customers").toLowerCase()}`}
                >
                  <span className="text-sm font-semibold text-white tabular-nums">
                    {cell.count}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10px] text-slate-600">
        {t("rfm.heatmapLegend")}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------
// Top list — links into the inbox by contact_id for one-click action.
// ---------------------------------------------------------------------

function TopList({
  icon: Icon,
  tone,
  title,
  subtitle,
  contacts,
  locale,
  t,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: "warn" | "good";
  title: string;
  subtitle: string;
  contacts: TopContact[];
  locale: string;
  t: (key: string) => string;
}) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center gap-2">
        <Icon
          className={`h-4 w-4 ${tone === "warn" ? "text-orange-400" : "text-amber-400"}`}
        />
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
      {contacts.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">{t("rfm.noContacts")}</p>
      ) : (
        <ul className="mt-3 space-y-1">
          {contacts.map((c) => (
            <li key={c.contact_id}>
              <Link
                href={`/inbox?contact=${c.contact_id}`}
                className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-slate-800"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">
                    {c.name ?? c.phone ?? c.email ?? "—"}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {c.frequency_count ?? 0}× ·{" "}
                    {c.recency_days != null ? `${c.recency_days}d` : "—"}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-300">
                  {formatCurrency(c.monetary_value, locale)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------
// Auto-insights — simple heuristics that produce actionable copy. Each
// returns a {text, severity} pair so the UI can color them.
// ---------------------------------------------------------------------

function buildAutoInsights(
  data: Insights,
  locale: string,
  t: (key: string) => string,
): Array<{ text: string; severity: "info" | "warn" | "good" }> {
  const out: Array<{ text: string; severity: "info" | "warn" | "good" }> = [];

  const champion = data.segments.find((s) => s.key === "champion");
  const inRisk = data.segments.find((s) => s.key === "in_risk");
  const lost = data.segments.find((s) => s.key === "lost");
  const hibernating = data.segments.find((s) => s.key === "hibernating");

  if (champion && champion.count > 0 && champion.revenue_pct >= 15) {
    out.push({
      severity: "good",
      text: t("rfm.insight.paretoChampions")
        .replace("{count}", String(champion.count))
        .replace("{custPct}", champion.customers_pct.toFixed(1))
        .replace("{revPct}", champion.revenue_pct.toFixed(1)),
    });
  }

  if (inRisk && inRisk.count > 0) {
    out.push({
      severity: "warn",
      text: t("rfm.insight.atRisk")
        .replace("{count}", String(inRisk.count))
        .replace("{revenue}", formatCurrency(inRisk.revenue, locale)),
    });
  }

  if (lost && lost.customers_pct >= 40) {
    out.push({
      severity: "warn",
      text: t("rfm.insight.manyLost").replace(
        "{pct}",
        lost.customers_pct.toFixed(0),
      ),
    });
  }

  if (hibernating && hibernating.count > 0) {
    out.push({
      severity: "info",
      text: t("rfm.insight.winback").replace(
        "{count}",
        String(hibernating.count),
      ),
    });
  }

  if (champion && champion.avg_ticket > data.avg_ticket * 2) {
    const multiple = (champion.avg_ticket / Math.max(data.avg_ticket, 1)).toFixed(
      1,
    );
    out.push({
      severity: "good",
      text: t("rfm.insight.championTicket")
        .replace("{multiple}", multiple)
        .replace("{ticket}", formatCurrency(champion.avg_ticket, locale)),
    });
  }

  return out;
}
