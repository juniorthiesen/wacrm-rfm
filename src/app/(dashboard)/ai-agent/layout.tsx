'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { BookOpen, GraduationCap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Sub-navigation for the /ai-agent section.
 *
 * Polls the learning-queue count every 30s so the pending badge
 * reflects items extracted from the inbox without a full reload.
 * Cheap query (`head: true` count on a single-user partial), so 30s
 * is conservative.
 */

const TABS = [
  {
    href: '/ai-agent/knowledge',
    label: 'aiAgent.nav.knowledge',
    icon: BookOpen,
  },
  {
    href: '/ai-agent/learning',
    label: 'aiAgent.nav.learning',
    icon: GraduationCap,
    badge: 'pending' as const,
  },
]

export default function AiAgentLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const pathname = usePathname()
  const [pending, setPending] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    const fetchCount = () => {
      fetch('/api/ai/learning-queue?count_only=1')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          if (d && typeof d.pending === 'number') setPending(d.pending)
        })
        .catch(() => {})
    }
    fetchCount()
    const id = setInterval(fetchCount, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href)
          const Icon = tab.icon
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:bg-slate-800/50 hover:text-white',
              )}
            >
              <Icon className="h-4 w-4" />
              {t(tab.label)}
              {tab.badge === 'pending' && pending > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-violet-500 px-1 text-[10px] font-medium text-white">
                  {pending > 99 ? '99+' : pending}
                </span>
              )}
            </Link>
          )
        })}
      </div>

      {children}
    </div>
  )
}
