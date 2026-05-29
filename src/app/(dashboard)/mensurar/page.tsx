'use client'

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Link2, Settings, BarChart2 } from 'lucide-react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useTranslation } from '@/hooks/use-translation'
import {
  loadAttributionKPIs,
  loadCampaignBreakdown,
  loadLeadsTimeline,
} from '@/lib/mensurar/queries'
import type {
  AttributionKPIs,
  CampaignBreakdownRow,
  LeadsTimelinePoint,
} from '@/lib/mensurar/types'
import { AttributionKPIs as KPICards } from '@/components/mensurar/attribution-kpis'
import { CampaignsTable } from '@/components/mensurar/campaigns-table'
import { LeadsTimelineChart } from '@/components/mensurar/leads-timeline-chart'
import { AttributionModal } from '@/components/mensurar/attribution-modal'

type RangeDays = 7 | 30 | 90

export default function MensurarPage() {
  const { t, locale } = useTranslation()
  const [range, setRange] = useState<RangeDays>(30)

  const [kpis, setKpis] = useState<AttributionKPIs | null>(null)
  const [kpisLoading, setKpisLoading] = useState(true)

  const [breakdown, setBreakdown] = useState<CampaignBreakdownRow[]>([])
  const [breakdownLoading, setBreakdownLoading] = useState(true)

  const [timeline, setTimeline] = useState<LeadsTimelinePoint[]>([])
  const [timelineLoading, setTimelineLoading] = useState(true)

  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const [attrModalOpen, setAttrModalOpen] = useState(false)

  const loadAll = useCallback(
    (r: RangeDays) => {
      const db = createClient()

      setKpisLoading(true)
      setBreakdownLoading(true)
      setTimelineLoading(true)

      void loadAttributionKPIs(db, r)
        .then(setKpis)
        .catch((e) => console.error('[mensurar] kpis:', e))
        .finally(() => setKpisLoading(false))

      void loadCampaignBreakdown(db, r)
        .then(setBreakdown)
        .catch((e) => console.error('[mensurar] breakdown:', e))
        .finally(() => setBreakdownLoading(false))

      void loadLeadsTimeline(db, r)
        .then(setTimeline)
        .catch((e) => console.error('[mensurar] timeline:', e))
        .finally(() => setTimelineLoading(false))
    },
    [],
  )

  useEffect(() => {
    loadAll(range)
  }, [loadAll, range])

  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const resp = await fetch('/api/meta/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: range }),
      })
      const data = await resp.json()
      if (data.error) throw new Error(data.error)
      setSyncMsg(
        t('mensurar.syncedRows').replace('{count}', String(data.synced ?? 0)),
      )
      loadAll(range)
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(null), 5000)
    }
  }

  const rangeOptions: { value: RangeDays; label: string }[] = [
    { value: 7, label: t('mensurar.last7d') },
    { value: 30, label: t('mensurar.last30d') },
    { value: 90, label: t('mensurar.last90d') },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10">
            <BarChart2 className="h-5 w-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">{t('mensurar.title')}</h1>
            <p className="mt-0.5 text-sm text-slate-400">{t('mensurar.subtitle')}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Range Selector */}
          <div className="flex items-center rounded-lg border border-slate-700 bg-slate-900 p-1">
            {rangeOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  range === opt.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Attribute manually */}
          <button
            onClick={() => setAttrModalOpen(true)}
            className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            <Link2 className="h-4 w-4" />
            {t('mensurar.attributeContact')}
          </button>

          {/* Sync */}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? t('mensurar.syncing') : t('mensurar.syncWithMeta')}
          </button>

          {/* Go to settings */}
          <Link
            href="/settings?tab=meta-ads"
            className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>
      </div>

      {/* Sync feedback */}
      {syncMsg && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-2.5 text-sm text-indigo-300">
          {syncMsg}
        </div>
      )}

      {/* KPI Cards */}
      <KPICards data={kpis} loading={kpisLoading} locale={locale} />

      {/* Timeline Chart */}
      <LeadsTimelineChart data={timeline} loading={timelineLoading} />

      {/* Campaigns Table */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-200">
          {t('mensurar.campaignsBreakdown')}
        </h2>
        <CampaignsTable data={breakdown} loading={breakdownLoading} locale={locale} />
      </div>

      {/* Attribution Modal */}
      <AttributionModal
        open={attrModalOpen}
        onClose={() => setAttrModalOpen(false)}
        onSaved={() => loadAll(range)}
      />
    </div>
  )
}
