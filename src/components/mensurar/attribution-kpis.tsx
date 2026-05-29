'use client'

import {
  Users,
  TrendingUp,
  DollarSign,
  BarChart2,
} from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import type { AttributionKPIs } from '@/lib/mensurar/types'

interface Props {
  data: AttributionKPIs | null
  loading: boolean
  locale: string
}

function formatCurrency(v: number, locale: string): string {
  const isPt = locale.startsWith('pt')
  return new Intl.NumberFormat(isPt ? 'pt-BR' : locale, {
    style: 'currency',
    currency: isPt ? 'BRL' : 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v)
}

function formatMultiplier(v: number): string {
  return `${v.toFixed(2)}x`
}

export function AttributionKPIs({ data, loading, locale }: Props) {
  const { t } = useTranslation()

  const cards = [
    {
      id: 'total-leads',
      label: t('mensurar.totalLeads'),
      value: data ? data.totalLeads.toLocaleString() : '—',
      icon: Users,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
    },
    {
      id: 'total-spend',
      label: t('mensurar.totalSpend'),
      value: data ? formatCurrency(data.totalSpend, locale) : '—',
      icon: DollarSign,
      color: 'text-rose-400',
      bg: 'bg-rose-500/10',
    },
    {
      id: 'avg-cpl',
      label: t('mensurar.avgCPL'),
      value: data ? formatCurrency(data.avgCPL, locale) : '—',
      icon: BarChart2,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
    },
    {
      id: 'roas',
      label: t('mensurar.roas'),
      value: data ? formatMultiplier(data.estimatedROAS) : '—',
      icon: TrendingUp,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.id}
          className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-sm"
        >
          {loading ? (
            <div className="space-y-3">
              <div className="h-8 w-8 animate-pulse rounded-lg bg-slate-800" />
              <div className="h-4 w-20 animate-pulse rounded bg-slate-800" />
              <div className="h-7 w-24 animate-pulse rounded bg-slate-800" />
            </div>
          ) : (
            <>
              <div className={`inline-flex rounded-lg p-2 ${card.bg}`}>
                <card.icon className={`h-5 w-5 ${card.color}`} />
              </div>
              <p className="mt-3 text-sm text-slate-400">{card.label}</p>
              <p className="mt-1 text-2xl font-bold text-white">{card.value}</p>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
