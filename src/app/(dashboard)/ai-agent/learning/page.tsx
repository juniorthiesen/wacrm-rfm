'use client'

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Check,
  GraduationCap,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import type { LearningCandidate } from '@/lib/ai/learning-queries'

/**
 * Learning queue review page.
 *
 * Each candidate is an editable card — the operator can tweak title
 * or content before approving. Approval creates a row in
 * `ai_knowledge_entries` (source='learned'); reject just marks the
 * row 'rejected' and keeps it for audit.
 */

type Edit = { title: string; content: string }

export default function LearningPage() {
  const { t } = useTranslation()
  const [items, setItems] = useState<LearningCandidate[]>([])
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [busy, setBusy] = useState<Record<string, 'approve' | 'reject' | null>>(
    {},
  )
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch('/api/ai/learning-queue?status=pending')
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? 'load_failed')
      const rows = (data.items ?? []) as LearningCandidate[]
      setItems(rows)
      setEdits(
        Object.fromEntries(
          rows.map((r) => [
            r.id,
            {
              title: r.suggested_title,
              content: r.suggested_content,
            },
          ]),
        ),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const flashNotice = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 4000)
  }

  const setBusyFor = (id: string, kind: 'approve' | 'reject' | null) =>
    setBusy((prev) => ({ ...prev, [id]: kind }))

  const updateEdit = (id: string, patch: Partial<Edit>) =>
    setEdits((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }))

  const approve = async (c: LearningCandidate) => {
    const edit = edits[c.id]
    if (!edit?.title.trim() || !edit?.content.trim()) {
      setError(t('aiAgent.learning.errEmpty'))
      return
    }
    setBusyFor(c.id, 'approve')
    try {
      const resp = await fetch(`/api/ai/learning-queue/${c.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: edit.title, content: edit.content }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? 'approve_failed')
      setItems((xs) => xs.filter((x) => x.id !== c.id))
      flashNotice(
        data.embedding_error
          ? t('aiAgent.learning.approvedNoEmbed')
          : t('aiAgent.learning.approved'),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error')
    } finally {
      setBusyFor(c.id, null)
    }
  }

  const reject = async (c: LearningCandidate) => {
    setBusyFor(c.id, 'reject')
    try {
      const resp = await fetch(`/api/ai/learning-queue/${c.id}/reject`, {
        method: 'POST',
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.error ?? 'reject_failed')
      setItems((xs) => xs.filter((x) => x.id !== c.id))
      flashNotice(t('aiAgent.learning.rejected'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error')
    } finally {
      setBusyFor(c.id, null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">
          {t('aiAgent.learning.title')}
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          {t('aiAgent.learning.subtitle')}
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-300">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 p-6 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-700 bg-slate-900 p-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-500/10">
            <GraduationCap className="h-6 w-6 text-violet-400" />
          </div>
          <h2 className="text-sm font-semibold text-white">
            {t('aiAgent.learning.emptyTitle')}
          </h2>
          <p className="max-w-md text-xs text-slate-400">
            {t('aiAgent.learning.emptySubtitle')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((c) => {
            const edit = edits[c.id] ?? {
              title: c.suggested_title,
              content: c.suggested_content,
            }
            const state = busy[c.id]
            return (
              <div
                key={c.id}
                className="rounded-xl border border-slate-700 bg-slate-900 p-4"
              >
                <div className="mb-3 flex items-center gap-2 text-xs text-violet-300">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t('aiAgent.learning.cardHeader')}
                </div>

                {c.source_excerpt && (
                  <details className="mb-3 rounded-lg border border-slate-700 bg-slate-800/50 text-xs">
                    <summary className="cursor-pointer px-3 py-2 text-slate-400 hover:text-slate-200">
                      {t('aiAgent.learning.sourceExcerpt')}
                    </summary>
                    <pre className="whitespace-pre-wrap px-3 py-2 text-slate-400">
                      {c.source_excerpt}
                    </pre>
                  </details>
                )}

                <div className="space-y-3">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-300">
                      {t('aiAgent.kb.entryTitle')}
                    </label>
                    <input
                      type="text"
                      value={edit.title}
                      onChange={(e) =>
                        updateEdit(c.id, { title: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-300">
                      {t('aiAgent.kb.entryContent')}
                    </label>
                    <textarea
                      value={edit.content}
                      onChange={(e) =>
                        updateEdit(c.id, { content: e.target.value })
                      }
                      rows={4}
                      className="w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
                    />
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    onClick={() => reject(c)}
                    disabled={!!state}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-rose-300 disabled:opacity-50"
                  >
                    {state === 'reject' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                    {t('aiAgent.learning.reject')}
                  </button>
                  <button
                    onClick={() => approve(c)}
                    disabled={!!state}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {state === 'approve' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    {t('aiAgent.learning.approve')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
