'use client'

import { useState } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import type { CampaignBreakdownRow } from '@/lib/mensurar/types'

interface Props {
  data: CampaignBreakdownRow[]
  loading: boolean
  locale: string
}

type SortKey = keyof Pick<
  CampaignBreakdownRow,
  'leads' | 'conversions' | 'spend' | 'cpl' | 'revenue' | 'roas' | 'clicks' | 'ctr'
>

function formatCurrency(v: number, locale: string): string {
  const isPt = locale.startsWith('pt')
  return new Intl.NumberFormat(isPt ? 'pt-BR' : locale, {
    style: 'currency',
    currency: isPt ? 'BRL' : 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v)
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`
}

export function CampaignsTable({ data, loading, locale }: Props) {
  const { t } = useTranslation()
  const [sortKey, setSortKey] = useState<SortKey>('leads')
  const [sortAsc, setSortAsc] = useState(false)

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((p) => !p)
    else {
      setSortKey(key)
      setSortAsc(false)
    }
  }

  const sorted = [...data].sort((a, b) => {
    const av = a[sortKey] as number
    const bv = b[sortKey] as number
    return sortAsc ? av - bv : bv - av
  })

  const cols: { key: SortKey; label: string; fmt: (r: CampaignBreakdownRow) => string }[] = [
    { key: 'leads', label: t('mensurar.colLeads'), fmt: (r) => r.leads.toLocaleString() },
    { key: 'conversions', label: t('mensurar.colConversions'), fmt: (r) => r.conversions.toLocaleString() },
    { key: 'spend', label: t('mensurar.colSpend'), fmt: (r) => formatCurrency(r.spend, locale) },
    { key: 'cpl', label: t('mensurar.colCPL'), fmt: (r) => r.cpl > 0 ? formatCurrency(r.cpl, locale) : '—' },
    { key: 'revenue', label: t('mensurar.colRevenue'), fmt: (r) => formatCurrency(r.revenue, locale) },
    { key: 'roas', label: t('mensurar.colROAS'), fmt: (r) => r.roas > 0 ? `${r.roas.toFixed(2)}x` : '—' },
    { key: 'clicks', label: t('mensurar.colClicks'), fmt: (r) => r.clicks.toLocaleString() },
    { key: 'ctr', label: 'CTR', fmt: (r) => formatPct(r.ctr) },
  ]

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-800" />
          ))}
        </div>
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-10 text-center">
        <p className="text-sm text-slate-500">{t('mensurar.noCampaignData')}</p>
        <p className="mt-1 text-xs text-slate-600">{t('mensurar.noCampaignDataHint')}</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-4 py-3 text-left font-medium text-slate-400">
                {t('mensurar.colCampaign')}
              </th>
              <th className="px-4 py-3 text-left font-medium text-slate-400">
                {t('mensurar.colAdset')}
              </th>
              {cols.map((col) => (
                <th
                  key={col.key}
                  className="cursor-pointer select-none whitespace-nowrap px-4 py-3 text-right font-medium text-slate-400 hover:text-white"
                  onClick={() => handleSort(col.key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {sortKey === col.key
                      ? sortAsc
                        ? <ChevronUp className="h-3 w-3 text-primary" />
                        : <ChevronDown className="h-3 w-3 text-primary" />
                      : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, idx) => (
              <tr
                key={`${row.campaign_id}-${row.adset_id}-${idx}`}
                className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30 transition-colors"
              >
                <td className="max-w-[200px] truncate px-4 py-3 text-white">
                  {row.campaign_name || row.campaign_id}
                </td>
                <td className="max-w-[160px] truncate px-4 py-3 text-slate-300">
                  {row.adset_name || row.adset_id}
                </td>
                {cols.map((col) => (
                  <td key={col.key} className="whitespace-nowrap px-4 py-3 text-right text-slate-200">
                    {col.fmt(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
