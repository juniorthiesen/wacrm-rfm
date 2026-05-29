'use client'

import { useMemo } from 'react'
import { useTranslation } from '@/hooks/use-translation'
import type { LeadsTimelinePoint } from '@/lib/mensurar/types'

interface Props {
  data: LeadsTimelinePoint[]
  loading: boolean
}

// Colour palette for campaigns (cycles for > 8)
const PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#f97316', '#84cc16',
]

const VB_W = 760
const VB_H = 220
const PAD = { top: 16, right: 16, bottom: 36, left: 44 }
const INNER_W = VB_W - PAD.left - PAD.right
const INNER_H = VB_H - PAD.top - PAD.bottom

function formatDateShort(d: string) {
  const dt = new Date(`${d}T00:00:00`)
  return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

export function LeadsTimelineChart({ data, loading }: Props) {
  const { t } = useTranslation()

  // Pivot: group by date, then by campaign
  const { dates, campaigns, matrix, maxVal } = useMemo(() => {
    const campaignSet = new Set<string>()
    const dateMap = new Map<string, Map<string, number>>()

    for (const p of data) {
      campaignSet.add(p.campaign_name)
      if (!dateMap.has(p.date)) dateMap.set(p.date, new Map())
      const row = dateMap.get(p.date)!
      row.set(p.campaign_name, (row.get(p.campaign_name) ?? 0) + p.leads)
    }

    const campaigns = [...campaignSet]
    const dates = [...dateMap.keys()].sort()

    // Build matrix[dateIndex][campaignIndex] = count
    const matrix: number[][] = dates.map((d) => {
      const row = dateMap.get(d)!
      return campaigns.map((c) => row.get(c) ?? 0)
    })

    // Max stacked total per date for Y scaling
    const totals = matrix.map((row) => row.reduce((a, b) => a + b, 0))
    const maxVal = Math.max(...totals, 1)

    return { dates, campaigns, matrix, maxVal }
  }, [data])

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="h-5 w-48 animate-pulse rounded bg-slate-800" />
        <div className="mt-6 h-[220px] animate-pulse rounded-lg bg-slate-800" />
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <p className="text-sm text-slate-500">{t('mensurar.noTimelineData')}</p>
      </div>
    )
  }

  // Bar geometry
  const barGroupW = dates.length > 0 ? INNER_W / dates.length : INNER_W
  const barW = Math.max(4, Math.min(32, barGroupW * 0.6))
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * maxVal))

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="mb-4 text-sm font-semibold text-slate-200">
        {t('mensurar.leadsTimeline')}
      </h3>

      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full"
        aria-label={t('mensurar.leadsTimeline')}
      >
        {/* Y-axis grid lines + labels */}
        {yTicks.map((tick) => {
          const y = PAD.top + INNER_H - (tick / maxVal) * INNER_H
          return (
            <g key={tick}>
              <line
                x1={PAD.left}
                y1={y}
                x2={PAD.left + INNER_W}
                y2={y}
                stroke="#1e293b"
                strokeDasharray="4 3"
              />
              <text
                x={PAD.left - 6}
                y={y + 4}
                textAnchor="end"
                fill="#64748b"
                fontSize={11}
              >
                {tick}
              </text>
            </g>
          )
        })}

        {/* Bars */}
        {dates.map((date, di) => {
          const cx = PAD.left + (di + 0.5) * barGroupW
          const x0 = cx - barW / 2
          let stackY = PAD.top + INNER_H

          return (
            <g key={date}>
              {campaigns.map((campaign, ci) => {
                const count = matrix[di][ci]
                if (count === 0) return null
                const barH = (count / maxVal) * INNER_H
                stackY -= barH
                return (
                  <rect
                    key={campaign}
                    x={x0}
                    y={stackY}
                    width={barW}
                    height={barH}
                    fill={PALETTE[ci % PALETTE.length]}
                    rx={ci === campaigns.length - 1 ? 3 : 0}
                  >
                    <title>{`${campaign}: ${count} leads (${formatDateShort(date)})`}</title>
                  </rect>
                )
              })}

              {/* X-axis label */}
              <text
                x={cx}
                y={PAD.top + INNER_H + 18}
                textAnchor="middle"
                fill="#64748b"
                fontSize={10}
              >
                {formatDateShort(date)}
              </text>
            </g>
          )
        })}
      </svg>

      {/* Legend */}
      {campaigns.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {campaigns.map((campaign, i) => (
            <div key={campaign} className="flex items-center gap-1.5">
              <div
                className="h-2.5 w-2.5 rounded-sm"
                style={{ background: PALETTE[i % PALETTE.length] }}
              />
              <span className="max-w-[160px] truncate text-xs text-slate-400">
                {campaign}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
