"use client"

import { Repeat, Ticket, ShoppingBag, CalendarClock } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import type { RepurchaseMetrics } from '@/lib/dashboard/types'

/**
 * Repurchase cockpit on the main dashboard. Surfaces the strategy's
 * north-star KPI (% of customers who bought 2x+) plus the repurchase
 * ladder (1x → 2x → 3x+/VIP) and the matured-cohort 30/60/90-day
 * repurchase rates. Pure SVG-free layout — mirrors the existing
 * dashboard widgets' look (slate panels, tabular-nums).
 */
export function RepurchaseSection({
  data,
  loading,
  locale,
}: {
  data: RepurchaseMetrics | null
  loading: boolean
  locale: string
}) {
  const { t } = useTranslation()

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">
          {t('dashboard.repurchase.title')}
        </h2>
        <p className="mt-0.5 text-sm text-slate-400">
          {t('dashboard.repurchase.subtitle')}
        </p>
      </div>

      {loading || !data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : data.total_customers === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-500">
          {t('dashboard.repurchase.empty')}
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title={t('dashboard.repurchase.repeatRate')}
              value={`${formatPct(data.repeat_rate)}%`}
              icon={Repeat}
              subtitle={t('dashboard.repurchase.repeatRateHint')
                .replace('{count}', data.repeat_customers.toLocaleString())
                .replace('{total}', data.total_customers.toLocaleString())}
            />
            <MetricCard
              title={t('dashboard.repurchase.window90')}
              value={`${formatPct(windowRate(data, 90))}%`}
              icon={CalendarClock}
              subtitle={t('dashboard.repurchase.windowEligible').replace(
                '{count}',
                windowEligible(data, 90).toLocaleString(),
              )}
            />
            <MetricCard
              title={t('dashboard.repurchase.avgTicket')}
              value={formatCurrency(data.avg_ticket, locale)}
              icon={Ticket}
            />
            <MetricCard
              title={t('dashboard.repurchase.ordersPerCustomer')}
              value={data.avg_orders_per_customer.toLocaleString(locale, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              icon={ShoppingBag}
            />
          </div>

          {/* Ladder + windows */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <Ladder data={data} t={t} />
            </div>
            <div className="lg:col-span-2">
              <Windows data={data} t={t} />
            </div>
          </div>
        </>
      )}
    </section>
  )
}

// ------------------------------------------------------------
// Repurchase ladder: 1x / 2x / 3x+ as proportional bars with the
// conversion % between steps called out.
// ------------------------------------------------------------

function Ladder({
  data,
  t,
}: {
  data: RepurchaseMetrics
  t: (key: string) => string
}) {
  const { one, two, three_plus } = data.funnel
  const max = Math.max(one, two, three_plus, 1)
  const rows = [
    { key: 'buyers1x', count: one, color: '#64748b' },
    { key: 'buyers2x', count: two, color: '#3b82f6' },
    { key: 'buyers3x', count: three_plus, color: '#facc15' },
  ]

  return (
    <div className="h-full rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h3 className="text-sm font-semibold text-white">
        {t('dashboard.repurchase.ladderTitle')}
      </h3>
      <p className="mt-0.5 text-xs text-slate-500">
        {t('dashboard.repurchase.ladderSubtitle')}
      </p>
      <ul className="mt-4 space-y-3">
        {rows.map((r) => (
          <li key={r.key}>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-300">
                {t(`dashboard.repurchase.${r.key}`)}
              </span>
              <span className="tabular-nums text-slate-400">
                {r.count.toLocaleString()} {t('dashboard.repurchase.customers')}
              </span>
            </div>
            <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max((r.count / max) * 100, r.count > 0 ? 2 : 0)}%`,
                  background: r.color,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
      {/* Conversion callouts */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <ConvChip
          value={`${formatPct(data.conversion.to_2nd)}%`}
          label={t('dashboard.repurchase.toSecond')}
        />
        <ConvChip
          value={`${formatPct(data.conversion.to_3rd)}%`}
          label={t('dashboard.repurchase.toThird')}
        />
      </div>
    </div>
  )
}

function ConvChip({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <p className="text-lg font-semibold tabular-nums text-white">{value}</p>
      <p className="mt-0.5 text-[11px] leading-tight text-slate-500">{label}</p>
    </div>
  )
}

// ------------------------------------------------------------
// Windowed repurchase: 30 / 60 / 90 day rates as horizontal bars.
// ------------------------------------------------------------

function Windows({
  data,
  t,
}: {
  data: RepurchaseMetrics
  t: (key: string) => string
}) {
  const ordered = [...data.windows].sort((a, b) => a.days - b.days)
  return (
    <div className="h-full rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h3 className="text-sm font-semibold text-white">
        {t('dashboard.repurchase.windowsTitle')}
      </h3>
      <p className="mt-0.5 text-xs text-slate-500">
        {t('dashboard.repurchase.windowsSubtitle')}
      </p>
      <ul className="mt-4 space-y-3">
        {ordered.map((w) => (
          <li key={w.days}>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-300">
                {t('dashboard.repurchase.daysLabel').replace(
                  '{days}',
                  String(w.days),
                )}
              </span>
              <span className="tabular-nums text-slate-400">
                {formatPct(w.rate)}% ·{' '}
                <span className="text-slate-600">
                  {w.repurchased.toLocaleString()}/{w.eligible.toLocaleString()}
                </span>
              </span>
            </div>
            <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-emerald-500"
                style={{ width: `${Math.min(w.rate, 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ------------------------------------------------------------

function windowRate(data: RepurchaseMetrics, days: number): number {
  return data.windows.find((w) => w.days === days)?.rate ?? 0
}

function windowEligible(data: RepurchaseMetrics, days: number): number {
  return data.windows.find((w) => w.days === days)?.eligible ?? 0
}

function formatPct(v: number): string {
  // RPC already rounds to 1 decimal; drop a trailing ".0" for clean cards.
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function formatCurrency(v: number, locale: string): string {
  const isPt = locale.startsWith('pt')
  return new Intl.NumberFormat(isPt ? 'pt-BR' : locale, {
    style: 'currency',
    currency: isPt ? 'BRL' : 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(v)
}
