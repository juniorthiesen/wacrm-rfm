'use client'

import { useState, useEffect } from 'react'
import { CheckCircle, AlertCircle, RefreshCw, Wifi, WifiOff, Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useTranslation } from '@/hooks/use-translation'
import { loadMetaAdsConfig, saveMetaAdsConfig } from '@/lib/mensurar/queries'

interface AccountInfo {
  name: string
  currency: string
  account_status: number
}

export function MetaAdsPanel() {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [lastSynced, setLastSynced] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    account?: AccountInfo
    error?: string
  } | null>(null)
  const [syncResult, setSyncResult] = useState<{
    synced: number
    errors: string[]
  } | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  useEffect(() => {
    const db = createClient()
    loadMetaAdsConfig(db).then((cfg) => {
      if (!cfg) return
      setToken(cfg.access_token)
      setAccountId(cfg.ad_account_id)
      setLastSynced(cfg.last_synced_at)
    })
  }, [])

  const handleSave = async () => {
    if (!token.trim() || !accountId.trim()) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const db = createClient()
      await saveMetaAdsConfig(db, {
        access_token: token.trim(),
        ad_account_id: accountId.trim(),
      })
      setSaveMsg(t('mensurar.configSaved'))
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(null), 4000)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const resp = await fetch('/api/meta/sync')
      const data = await resp.json()
      setTestResult(data)
    } catch {
      setTestResult({ ok: false, error: t('mensurar.connectionFailed') })
    } finally {
      setTesting(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const resp = await fetch('/api/meta/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 30 }),
      })
      const data = await resp.json()
      if (data.error) throw new Error(data.error)
      setSyncResult({ synced: data.synced, errors: data.errors ?? [] })
      setLastSynced(data.last_synced_at)
    } catch (e) {
      setSyncResult({
        synced: 0,
        errors: [e instanceof Error ? e.message : t('common.error')],
      })
    } finally {
      setSyncing(false)
    }
  }

  const formatSyncDate = (iso: string | null) => {
    if (!iso) return t('mensurar.neverSynced')
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso))
  }

  return (
    <div className="space-y-6">
      {/* Card: Credentials */}
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600/10">
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-blue-400">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">{t('mensurar.metaAdsConfig')}</h3>
            <p className="mt-0.5 text-xs text-slate-400">{t('mensurar.metaAdsConfigDesc')}</p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Access Token */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('mensurar.accessToken')}
            </label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="EAAG..."
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 pr-10 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowToken((p) => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">{t('mensurar.accessTokenHelp')}</p>
          </div>

          {/* Ad Account ID */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('mensurar.adAccountId')}
            </label>
            <input
              type="text"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="act_123456789"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
            />
            <p className="mt-1 text-xs text-slate-500">{t('mensurar.adAccountIdHelp')}</p>
          </div>

          {saveMsg && (
            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
              {saveMsg}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !token.trim() || !accountId.trim()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>

            <button
              onClick={handleTest}
              disabled={testing || !token.trim() || !accountId.trim()}
              className="flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {testing ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wifi className="h-3.5 w-3.5" />
              )}
              {t('mensurar.testConnection')}
            </button>
          </div>

          {/* Connection test result */}
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
                {testResult.ok && testResult.account ? (
                  <span>
                    {t('mensurar.connected')}: <strong>{testResult.account.name}</strong>
                    {' '}({testResult.account.currency})
                  </span>
                ) : (
                  <span>{testResult.error ?? t('mensurar.connectionFailed')}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Card: Sync */}
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="mb-1 text-sm font-semibold text-white">{t('mensurar.dataSync')}</h3>
        <p className="mb-4 text-xs text-slate-400">{t('mensurar.dataSyncDesc')}</p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleSync}
            disabled={syncing || !token.trim() || !accountId.trim()}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? t('mensurar.syncing') : t('mensurar.syncNow')}
          </button>
          <p className="text-xs text-slate-500">
            {t('mensurar.lastSynced')}: {formatSyncDate(lastSynced)}
          </p>
        </div>

        {syncResult && (
          <div className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
            syncResult.errors.length === 0
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
          }`}>
            {syncResult.errors.length === 0 ? (
              <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <div>
              <p>{t('mensurar.syncedRows').replace('{count}', syncResult.synced.toString())}</p>
              {syncResult.errors.map((e, i) => (
                <p key={i} className="text-rose-300">{e}</p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
