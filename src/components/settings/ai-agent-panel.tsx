'use client'

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle,
  Eye,
  EyeOff,
  RefreshCw,
  Sparkles,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'
import type {
  AiAgent,
  AiProvider,
  AiProviderKeyStatus,
} from '@/lib/ai/types'
import { DEFAULT_MODEL } from '@/lib/ai/types'

/**
 * AI Agent settings panel.
 *
 * Phase 1: single agent per workspace, single provider (OpenRouter).
 * Adapter layer below lets us extend the provider dropdown later
 * without rewriting this component.
 *
 * The key is never round-tripped to the browser — we only ever know
 * "has_key" + "updated_at". When the user wants to swap keys they
 * type a fresh one into the input.
 */

const PROVIDER: AiProvider = 'openrouter'

interface AgentFormState {
  name: string
  model: string
  systemPrompt: string
  temperature: number
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyThreshold: number
  autoReplyDailyCap: number
}

const EMPTY_FORM: AgentFormState = {
  name: '',
  model: DEFAULT_MODEL,
  systemPrompt: '',
  temperature: 0.3,
  isActive: false,
  autoReplyEnabled: false,
  autoReplyThreshold: 0.55,
  autoReplyDailyCap: 50,
}

export function AiAgentPanel() {
  const { t } = useTranslation()

  const [form, setForm] = useState<AgentFormState>(EMPTY_FORM)
  const [keyStatus, setKeyStatus] = useState<AiProviderKeyStatus | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [deletingKey, setDeletingKey] = useState(false)

  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<
    { ok: true } | { ok: false; error: string } | null
  >(null)

  // Initial load — agent + key status in parallel.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/ai/agent').then((r) => r.json()),
      fetch(`/api/ai/provider-key?provider=${PROVIDER}`).then((r) => r.json()),
    ])
      .then(([agentResp, keyResp]) => {
        if (cancelled) return
        const a = (agentResp.agent ?? null) as AiAgent | null
        if (a) {
          setForm({
            name: a.name,
            model: a.model,
            systemPrompt: a.system_prompt,
            temperature: Number(a.temperature),
            isActive: a.is_active,
            autoReplyEnabled: !!a.auto_reply_enabled,
            autoReplyThreshold: Number(a.auto_reply_threshold ?? 0.55),
            autoReplyDailyCap: Number(a.auto_reply_daily_cap ?? 50),
          })
        }
        setKeyStatus(keyResp as AiProviderKeyStatus)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSaveAgent = async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      const resp = await fetch('/api/ai/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          provider: PROVIDER,
          model: form.model,
          system_prompt: form.systemPrompt,
          temperature: form.temperature,
          is_active: form.isActive,
          auto_reply_enabled: form.autoReplyEnabled,
          auto_reply_threshold: form.autoReplyThreshold,
          auto_reply_daily_cap: form.autoReplyDailyCap,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? 'save_failed')
      setSaveMsg(t('aiAgent.saved'))
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(null), 4000)
    }
  }

  const handleSaveKey = async () => {
    const k = apiKeyInput.trim()
    if (!k) return
    setSavingKey(true)
    try {
      const resp = await fetch('/api/ai/provider-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: PROVIDER, apiKey: k }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? 'save_key_failed')
      setKeyStatus(data as AiProviderKeyStatus)
      setApiKeyInput('')
      setShowKey(false)
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : t('common.error'))
      setTimeout(() => setSaveMsg(null), 4000)
    } finally {
      setSavingKey(false)
    }
  }

  const handleDeleteKey = async () => {
    if (!confirm(t('aiAgent.deleteKeyConfirm'))) return
    setDeletingKey(true)
    try {
      const resp = await fetch(
        `/api/ai/provider-key?provider=${PROVIDER}`,
        { method: 'DELETE' },
      )
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        throw new Error(data.error ?? 'delete_key_failed')
      }
      setKeyStatus({
        provider: PROVIDER,
        has_key: false,
        updated_at: null,
      })
      setTestResult(null)
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : t('common.error'))
      setTimeout(() => setSaveMsg(null), 4000)
    } finally {
      setDeletingKey(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // If the user typed a key but didn't save yet, test that one.
      // Otherwise fall back to the stored key.
      const body: { provider: AiProvider; apiKey?: string } = {
        provider: PROVIDER,
      }
      const candidate = apiKeyInput.trim()
      if (candidate) body.apiKey = candidate
      const resp = await fetch('/api/ai/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      setTestResult(data)
    } catch (e) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : 'unknown',
      })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6 text-sm text-slate-400">
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Card 1: Agent config */}
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-600/10">
            <Sparkles className="h-5 w-5 text-violet-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">
              {t('aiAgent.title')}
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {t('aiAgent.subtitle')}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Enable */}
          <label className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800 px-3 py-3">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) =>
                setForm((f) => ({ ...f, isActive: e.target.checked }))
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 text-primary"
            />
            <div>
              <div className="text-sm font-medium text-white">
                {t('aiAgent.enable')}
              </div>
              <div className="mt-0.5 text-xs text-slate-400">
                {t('aiAgent.enableDesc')}
              </div>
            </div>
          </label>

          {/* Name */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('aiAgent.name')}
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
              placeholder={t('aiAgent.namePlaceholder')}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
            />
          </div>

          {/* Provider (read-only for now) */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('aiAgent.provider')}
            </label>
            <div className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5">
              <div className="text-sm text-white">
                {t('aiAgent.providerOpenrouter')}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {t('aiAgent.providerOpenrouterDesc')}
              </div>
            </div>
          </div>

          {/* Model */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('aiAgent.model')}
            </label>
            <input
              type="text"
              value={form.model}
              onChange={(e) =>
                setForm((f) => ({ ...f, model: e.target.value }))
              }
              placeholder={DEFAULT_MODEL}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
            />
            <p className="mt-1 text-xs text-slate-500">
              {t('aiAgent.modelHelp')}
            </p>
          </div>

          {/* Temperature */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('aiAgent.temperature')} — {form.temperature.toFixed(2)}
            </label>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={form.temperature}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  temperature: Number(e.target.value),
                }))
              }
              className="w-full"
            />
            <div className="mt-0.5 flex justify-between text-xs text-slate-500">
              <span>{t('aiAgent.temperatureLow')}</span>
              <span>{t('aiAgent.temperatureHigh')}</span>
            </div>
          </div>

          {/* System prompt */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('aiAgent.systemPrompt')}
            </label>
            <textarea
              value={form.systemPrompt}
              onChange={(e) =>
                setForm((f) => ({ ...f, systemPrompt: e.target.value }))
              }
              placeholder={t('aiAgent.systemPromptPlaceholder')}
              rows={6}
              className="w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
            />
          </div>

          {saveMsg && (
            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
              {saveMsg}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleSaveAgent}
              disabled={saving}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>

      {/* Card 1.5: Auto-reply */}
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="mb-1 text-sm font-semibold text-white">
          {t('aiAgent.autoReply.title')}
        </h3>
        <p className="mb-4 text-xs text-slate-400">
          {t('aiAgent.autoReply.subtitle')}
        </p>

        <div className="space-y-4">
          <label className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800 px-3 py-3">
            <input
              type="checkbox"
              checked={form.autoReplyEnabled}
              onChange={(e) =>
                setForm((f) => ({ ...f, autoReplyEnabled: e.target.checked }))
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 text-primary"
            />
            <div>
              <div className="text-sm font-medium text-white">
                {t('aiAgent.autoReply.enable')}
              </div>
              <div className="mt-0.5 text-xs text-slate-400">
                {t('aiAgent.autoReply.enableDesc')}
              </div>
            </div>
          </label>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('aiAgent.autoReply.threshold')} —{' '}
              {(form.autoReplyThreshold * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={form.autoReplyThreshold}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  autoReplyThreshold: Number(e.target.value),
                }))
              }
              disabled={!form.autoReplyEnabled}
              className="w-full"
            />
            <p className="mt-1 text-xs text-slate-500">
              {t('aiAgent.autoReply.thresholdHelp')}
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('aiAgent.autoReply.dailyCap')}
            </label>
            <input
              type="number"
              min={0}
              max={1000}
              step={1}
              value={form.autoReplyDailyCap}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  autoReplyDailyCap: Number(e.target.value),
                }))
              }
              disabled={!form.autoReplyEnabled}
              className="w-32 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-slate-500">
              {t('aiAgent.autoReply.dailyCapHelp')}
            </p>
          </div>
        </div>
      </div>

      {/* Card 2: API key */}
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="mb-1 text-sm font-semibold text-white">
          {t('aiAgent.apiKey')}
        </h3>
        <p className="mb-4 text-xs text-slate-400">
          {t('aiAgent.apiKeyHelp')}
        </p>

        <div className="space-y-3">
          {keyStatus?.has_key && (
            <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
              <span className="inline-flex items-center gap-2">
                <CheckCircle className="h-3.5 w-3.5" />
                {t('aiAgent.apiKeyStored')}
                {keyStatus.updated_at && (
                  <span className="text-emerald-400/70">
                    · {new Date(keyStatus.updated_at).toLocaleString()}
                  </span>
                )}
              </span>
              <button
                onClick={handleDeleteKey}
                disabled={deletingKey}
                className="inline-flex items-center gap-1 text-rose-300 hover:text-rose-200 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('aiAgent.deleteKey')}
              </button>
            </div>
          )}

          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={
                keyStatus?.has_key
                  ? t('aiAgent.apiKeyReplace')
                  : t('aiAgent.apiKeyPlaceholder')
              }
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 pr-10 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowKey((p) => !p)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
            >
              {showKey ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleSaveKey}
              disabled={savingKey || !apiKeyInput.trim()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {savingKey ? t('common.saving') : t('common.save')}
            </button>

            <button
              onClick={handleTest}
              disabled={
                testing || (!apiKeyInput.trim() && !keyStatus?.has_key)
              }
              className="flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {testing ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wifi className="h-3.5 w-3.5" />
              )}
              {testing ? t('aiAgent.testing') : t('aiAgent.testConnection')}
            </button>
          </div>

          {testResult && (
            <div
              className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
                testResult.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <div>
                {testResult.ok ? (
                  <span>{t('aiAgent.connectionOk')}</span>
                ) : (
                  <span>
                    {t('aiAgent.connectionFailed')}: {testResult.error}
                  </span>
                )}
              </div>
            </div>
          )}

          {!keyStatus?.has_key && !apiKeyInput && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('aiAgent.apiKeyHelp')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
