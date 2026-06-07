'use client'

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  BookOpen,
  CheckCircle,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import type {
  KnowledgeEntry,
  KnowledgeSource,
} from '@/lib/ai/knowledge-queries'

/**
 * Knowledge base management page.
 *
 * Lists entries newest-first, with inline create/edit dialog. We avoid
 * the shadcn Dialog primitive here so the edit form lives in the same
 * tree and benefits from React form state without prop-drilling
 * controlled props through the Dialog Root. The dialog is just a
 * floating panel toggled by `editingId`.
 */

type DraftMode = 'closed' | 'create' | 'edit'

interface DraftState {
  mode: DraftMode
  id: string | null
  title: string
  content: string
}

const EMPTY_DRAFT: DraftState = {
  mode: 'closed',
  id: null,
  title: '',
  content: '',
}

type IngestKind = 'text' | 'url'
interface IngestState {
  open: boolean
  kind: IngestKind
  sourceName: string
  text: string
  url: string
  running: boolean
  result: {
    created: number
    with_embedding: number
    total_chunks: number
    errors: string[]
  } | null
  error: string | null
}

const EMPTY_INGEST: IngestState = {
  open: false,
  kind: 'text',
  sourceName: '',
  text: '',
  url: '',
  running: false,
  result: null,
  error: null,
}

function sourceBadge(source: KnowledgeSource, t: (k: string) => string) {
  switch (source) {
    case 'manual':
      return {
        label: t('aiAgent.kb.sourceManual'),
        className: 'bg-slate-700/40 text-slate-300 border-slate-600',
      }
    case 'learned':
      return {
        label: t('aiAgent.kb.sourceLearned'),
        className: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
      }
    case 'document':
      return {
        label: t('aiAgent.kb.sourceDocument'),
        className: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
      }
    case 'url':
      return {
        label: t('aiAgent.kb.sourceUrl'),
        className: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
      }
  }
}

export default function KnowledgePage() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT)
  const [ingest, setIngest] = useState<IngestState>(EMPTY_INGEST)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/ai/knowledge?status=active')
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? 'load_failed')
      setEntries((data.entries ?? []) as KnowledgeEntry[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const openCreate = () =>
    setDraft({ mode: 'create', id: null, title: '', content: '' })
  const openEdit = (entry: KnowledgeEntry) =>
    setDraft({
      mode: 'edit',
      id: entry.id,
      title: entry.title,
      content: entry.content,
    })
  const closeDraft = () => setDraft(EMPTY_DRAFT)

  const flashNotice = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 4000)
  }

  const handleSave = async () => {
    if (!draft.title.trim() || !draft.content.trim()) return
    setSaving(true)
    setError(null)
    try {
      const isEdit = draft.mode === 'edit' && draft.id
      const resp = await fetch(
        isEdit ? `/api/ai/knowledge/${draft.id}` : '/api/ai/knowledge',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: draft.title,
            content: draft.content,
          }),
        },
      )
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? 'save_failed')
      if (data.embedding_error) {
        flashNotice(
          `${t('aiAgent.kb.savedNoEmbedding')}: ${data.embedding_error}`,
        )
      } else {
        flashNotice(t('aiAgent.kb.saved'))
      }
      closeDraft()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error')
    } finally {
      setSaving(false)
    }
  }

  const openIngest = () => setIngest({ ...EMPTY_INGEST, open: true })
  const closeIngest = () =>
    setIngest((s) => (s.running ? s : EMPTY_INGEST))

  const runIngest = async () => {
    if (ingest.kind === 'text' && !ingest.text.trim()) return
    if (ingest.kind === 'url' && !ingest.url.trim()) return
    setIngest((s) => ({ ...s, running: true, result: null, error: null }))
    try {
      const resp = await fetch('/api/ai/knowledge/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          ingest.kind === 'text'
            ? {
                mode: 'text',
                source_name: ingest.sourceName || undefined,
                text: ingest.text,
              }
            : {
                mode: 'url',
                source_name: ingest.sourceName || undefined,
                url: ingest.url,
              },
        ),
      })
      const data = await resp.json()
      if (!resp.ok) {
        setIngest((s) => ({
          ...s,
          running: false,
          error: data.message ?? data.error ?? 'ingest_failed',
        }))
        return
      }
      setIngest((s) => ({ ...s, running: false, result: data }))
      flashNotice(
        t('aiAgent.kb.ingestDone').replace(
          '{count}',
          String(data.created ?? 0),
        ),
      )
      await load()
    } catch (e) {
      setIngest((s) => ({
        ...s,
        running: false,
        error: e instanceof Error ? e.message : 'unknown_error',
      }))
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm(t('aiAgent.kb.deleteConfirm'))) return
    try {
      const resp = await fetch(`/api/ai/knowledge/${id}`, {
        method: 'DELETE',
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        throw new Error(data.error ?? 'delete_failed')
      }
      setEntries((es) => es.filter((e) => e.id !== id))
      flashNotice(t('aiAgent.kb.deleted'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">
            {t('aiAgent.kb.title')}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {t('aiAgent.kb.subtitle')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={openIngest}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3.5 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            <Upload className="h-4 w-4" />
            {t('aiAgent.kb.ingest')}
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('aiAgent.kb.add')}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-300">
          <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 p-6 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-700 bg-slate-900 p-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-500/10">
            <BookOpen className="h-6 w-6 text-violet-400" />
          </div>
          <h2 className="text-sm font-semibold text-white">
            {t('aiAgent.kb.emptyTitle')}
          </h2>
          <p className="max-w-md text-xs text-slate-400">
            {t('aiAgent.kb.emptySubtitle')}
          </p>
          <button
            onClick={openCreate}
            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('aiAgent.kb.addFirst')}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => {
            const badge = sourceBadge(e.source, t)
            return (
              <div
                key={e.id}
                className="group rounded-xl border border-slate-700 bg-slate-900 p-4 transition-colors hover:border-slate-600"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-white">
                        {e.title}
                      </h3>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                      {!e.has_embedding && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                          <AlertCircle className="h-2.5 w-2.5" />
                          {t('aiAgent.kb.noEmbedding')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-xs text-slate-400">
                      {e.content}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={() => openEdit(e)}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                      aria-label={t('common.edit')}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(e.id)}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-300"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Draft panel — overlay */}
      {draft.mode !== 'closed' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-400" />
              <h2 className="text-sm font-semibold text-white">
                {draft.mode === 'create'
                  ? t('aiAgent.kb.createTitle')
                  : t('aiAgent.kb.editTitle')}
              </h2>
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  {t('aiAgent.kb.entryTitle')}
                </label>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, title: e.target.value }))
                  }
                  placeholder={t('aiAgent.kb.entryTitlePlaceholder')}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  {t('aiAgent.kb.entryContent')}
                </label>
                <textarea
                  value={draft.content}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, content: e.target.value }))
                  }
                  placeholder={t('aiAgent.kb.entryContentPlaceholder')}
                  rows={8}
                  className="w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
                />
                <p className="mt-1 text-xs text-slate-500">
                  {t('aiAgent.kb.entryContentHelp')}
                </p>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={closeDraft}
                disabled={saving}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={
                  saving || !draft.title.trim() || !draft.content.trim()
                }
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ingest dialog */}
      {ingest.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center gap-2">
              <Upload className="h-4 w-4 text-violet-400" />
              <h2 className="text-sm font-semibold text-white">
                {t('aiAgent.kb.ingestTitle')}
              </h2>
            </div>

            <div className="mb-4 flex gap-1 rounded-lg border border-slate-700 bg-slate-800 p-1 text-xs">
              {(['text', 'url'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() =>
                    setIngest((s) =>
                      s.running ? s : { ...s, kind: k, result: null, error: null },
                    )
                  }
                  className={`flex-1 rounded-md px-3 py-1.5 transition-colors ${
                    ingest.kind === k
                      ? 'bg-slate-700 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {t(`aiAgent.kb.ingest${k === 'text' ? 'Text' : 'Url'}`)}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  {t('aiAgent.kb.ingestSourceName')}
                </label>
                <input
                  type="text"
                  value={ingest.sourceName}
                  onChange={(e) =>
                    setIngest((s) => ({ ...s, sourceName: e.target.value }))
                  }
                  placeholder={t('aiAgent.kb.ingestSourceNamePlaceholder')}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
                />
              </div>

              {ingest.kind === 'text' ? (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    {t('aiAgent.kb.ingestTextLabel')}
                  </label>
                  <textarea
                    value={ingest.text}
                    onChange={(e) =>
                      setIngest((s) => ({ ...s, text: e.target.value }))
                    }
                    placeholder={t('aiAgent.kb.ingestTextPlaceholder')}
                    rows={10}
                    className="w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
                  />
                </div>
              ) : (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    {t('aiAgent.kb.ingestUrlLabel')}
                  </label>
                  <input
                    type="url"
                    value={ingest.url}
                    onChange={(e) =>
                      setIngest((s) => ({ ...s, url: e.target.value }))
                    }
                    placeholder="https://example.com/faq"
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    {t('aiAgent.kb.ingestUrlHelp')}
                  </p>
                </div>
              )}

              {ingest.error && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-300">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{ingest.error}</span>
                </div>
              )}

              {ingest.result && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-300">
                  <div>
                    {t('aiAgent.kb.ingestResult')
                      .replace('{created}', String(ingest.result.created))
                      .replace(
                        '{embedded}',
                        String(ingest.result.with_embedding),
                      )
                      .replace(
                        '{total}',
                        String(ingest.result.total_chunks),
                      )}
                  </div>
                  {ingest.result.errors.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-amber-300">
                        {t('aiAgent.kb.ingestErrors').replace(
                          '{count}',
                          String(ingest.result.errors.length),
                        )}
                      </summary>
                      <ul className="mt-1 space-y-0.5 pl-4 text-amber-300/80">
                        {ingest.result.errors.slice(0, 10).map((er, i) => (
                          <li key={i}>{er}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={closeIngest}
                disabled={ingest.running}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {ingest.result ? t('common.close') : t('common.cancel')}
              </button>
              {!ingest.result && (
                <button
                  onClick={runIngest}
                  disabled={
                    ingest.running ||
                    (ingest.kind === 'text' && !ingest.text.trim()) ||
                    (ingest.kind === 'url' && !ingest.url.trim())
                  }
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {ingest.running && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {ingest.running
                    ? t('aiAgent.kb.ingestRunning')
                    : t('aiAgent.kb.ingestRun')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
