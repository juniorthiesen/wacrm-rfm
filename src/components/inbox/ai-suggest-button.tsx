'use client'

import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Loader2,
  Pencil,
  Settings as SettingsIcon,
  Sparkles,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/use-translation'
import type { KnowledgeMatch } from '@/lib/ai/embeddings'

/**
 * "Sugerir IA" — copiloto trigger.
 *
 * The button is disabled when there's no last-inbound text to feed
 * the agent (a fresh conversation, or every message so far is from
 * the operator).
 *
 * The popover is rendered inline inside this component to keep state
 * local. It opens upward so the composer doesn't shift the page
 * layout; the parent positions us above the textarea.
 *
 * Two callbacks let the parent pick the UX:
 *   - onAccept(text) → the composer replaces its draft with `text`.
 *   - onAppend(text) → the composer appends `text` to the existing
 *     draft (used by the "Editar" path).
 */

interface AiSuggestButtonProps {
  /** The customer's last message — feeds the agent. */
  lastInboundText: string | null
  /** For run-log attribution. */
  contactId?: string | null
  /** Replace the composer draft with the suggestion. */
  onAccept: (text: string) => void
  /** Append the suggestion to whatever the operator already typed. */
  onAppend: (text: string) => void
  /** Disable button entirely (e.g. session expired). */
  disabled?: boolean
}

type SuggestState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready'
      text: string
      matches: KnowledgeMatch[]
    }
  | {
      kind: 'unconfigured'
      reason: 'no_agent' | 'inactive' | 'no_key' | string
    }
  | { kind: 'error'; message: string }

export function AiSuggestButton({
  lastInboundText,
  contactId,
  onAccept,
  onAppend,
  disabled,
}: AiSuggestButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<SuggestState>({ kind: 'idle' })
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Close on outside click. We intentionally don't use Escape — losing
  // a generated suggestion to a stray keystroke is annoying.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const hasInput = !!lastInboundText && lastInboundText.trim().length > 0
  const buttonDisabled = disabled || !hasInput || state.kind === 'loading'

  const fetchSuggestion = async () => {
    if (!lastInboundText) return
    setState({ kind: 'loading' })
    try {
      const resp = await fetch('/api/ai/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: lastInboundText,
          contact_id: contactId ?? null,
        }),
      })
      const data = await resp.json()
      if (resp.status === 409 && data.error === 'agent_not_configured') {
        setState({ kind: 'unconfigured', reason: data.reason })
        return
      }
      if (!resp.ok) {
        setState({
          kind: 'error',
          message: data.error ?? `HTTP ${resp.status}`,
        })
        return
      }
      setState({
        kind: 'ready',
        text: data.text ?? '',
        matches: (data.matches ?? []) as KnowledgeMatch[],
      })
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : 'unknown_error',
      })
    }
  }

  const togglePopover = async () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    // Auto-fetch if we don't have a ready suggestion yet.
    if (state.kind === 'idle' || state.kind === 'error') {
      await fetchSuggestion()
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-9 w-9 shrink-0 p-0 text-violet-300 hover:bg-violet-500/10 hover:text-violet-200 disabled:text-slate-600"
        onClick={togglePopover}
        disabled={buttonDisabled}
        title={
          hasInput
            ? t('inbox.aiSuggest.tooltip')
            : t('inbox.aiSuggest.tooltipDisabled')
        }
        aria-label={t('inbox.aiSuggest.tooltip')}
      >
        {state.kind === 'loading' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
      </Button>

      {open && (
        <div
          className={cn(
            'absolute bottom-12 left-0 z-30 w-[min(28rem,calc(100vw-2rem))]',
            'rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl',
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-violet-300">
              <Sparkles className="h-3.5 w-3.5" />
              {t('inbox.aiSuggest.title')}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label={t('common.close')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {state.kind === 'loading' && (
            <div className="flex items-center gap-2 py-6 text-xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('inbox.aiSuggest.generating')}
            </div>
          )}

          {state.kind === 'unconfigured' && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {state.reason === 'no_agent' &&
                    t('inbox.aiSuggest.notConfiguredNoAgent')}
                  {state.reason === 'inactive' &&
                    t('inbox.aiSuggest.notConfiguredInactive')}
                  {state.reason === 'no_key' &&
                    t('inbox.aiSuggest.notConfiguredNoKey')}
                </span>
              </div>
              <Link
                href="/settings?tab=ai-agent"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                <SettingsIcon className="h-3.5 w-3.5" />
                {t('inbox.aiSuggest.openSettings')}
              </Link>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-300">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{state.message}</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={fetchSuggestion}
                className="h-7 text-xs"
              >
                {t('common.retry')}
              </Button>
            </div>
          )}

          {state.kind === 'ready' && (
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 whitespace-pre-wrap">
                {state.text || (
                  <span className="text-slate-500 italic">
                    {t('inbox.aiSuggest.emptyOutput')}
                  </span>
                )}
              </div>

              {state.matches.length > 0 && (
                <details className="rounded-lg border border-slate-700 bg-slate-800/50 text-xs">
                  <summary className="cursor-pointer px-3 py-2 text-slate-400 hover:text-slate-200">
                    {t('inbox.aiSuggest.sourcesLabel').replace(
                      '{count}',
                      String(state.matches.length),
                    )}
                  </summary>
                  <ul className="space-y-2 px-3 py-2">
                    {state.matches.map((m) => (
                      <li
                        key={m.id}
                        className="rounded-md border border-slate-700/50 bg-slate-900/50 px-2 py-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-200">
                            {m.title}
                          </span>
                          <span className="shrink-0 text-[10px] text-slate-500">
                            {(m.similarity * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-slate-400">
                          {m.content}
                        </p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-slate-400 hover:text-white"
                  onClick={fetchSuggestion}
                >
                  {t('inbox.aiSuggest.regenerate')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    if (state.text) onAppend(state.text)
                    setOpen(false)
                  }}
                  disabled={!state.text}
                >
                  <Pencil className="h-3 w-3" />
                  {t('inbox.aiSuggest.edit')}
                </Button>
                <Button
                  size="sm"
                  className="h-7 gap-1 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                  onClick={() => {
                    if (state.text) onAccept(state.text)
                    setOpen(false)
                  }}
                  disabled={!state.text}
                >
                  <Check className="h-3 w-3" />
                  {t('inbox.aiSuggest.use')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
