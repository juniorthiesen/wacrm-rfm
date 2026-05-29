'use client'

import { useState, useEffect, useCallback } from 'react'
import { Search, X, Link2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useTranslation } from '@/hooks/use-translation'
import { loadCampaignOptions, saveAttribution } from '@/lib/mensurar/queries'
import type { CampaignOption } from '@/lib/mensurar/types'

interface Contact {
  id: string
  name: string | null
  phone: string
}

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
  /** Pre-fill a specific contact if opened from the contact detail view */
  prefillContact?: Contact
}

export function AttributionModal({ open, onClose, onSaved, prefillContact }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContact, setSelectedContact] = useState<Contact | null>(
    prefillContact ?? null,
  )
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([])
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignOption | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (prefillContact) setSelectedContact(prefillContact)
  }, [prefillContact])

  // Load campaign options
  useEffect(() => {
    if (!open) return
    const db = createClient()
    loadCampaignOptions(db).then(setCampaigns).catch(console.error)
  }, [open])

  // Search contacts
  const searchContacts = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setContacts([])
        return
      }
      const db = createClient()
      const { data } = await db
        .from('contacts')
        .select('id, name, phone')
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .limit(10)
      setContacts((data as Contact[]) ?? [])
    },
    [],
  )

  useEffect(() => {
    const timeout = setTimeout(() => searchContacts(query), 300)
    return () => clearTimeout(timeout)
  }, [query, searchContacts])

  const handleSave = async () => {
    if (!selectedContact || !selectedCampaign) return
    setSaving(true)
    setError(null)
    try {
      const db = createClient()
      await saveAttribution(db, {
        contact_id: selectedContact.id,
        campaign_id: selectedCampaign.campaign_id,
        campaign_name: selectedCampaign.campaign_name,
        adset_id: selectedCampaign.adset_id,
        adset_name: selectedCampaign.adset_name,
        source: 'manual',
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    setQuery('')
    setContacts([])
    setSelectedContact(prefillContact ?? null)
    setSelectedCampaign(null)
    setError(null)
    onClose()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10">
              <Link2 className="h-4 w-4 text-indigo-400" />
            </div>
            <h2 className="text-sm font-semibold text-white">{t('mensurar.attributeContact')}</h2>
          </div>
          <button
            onClick={handleClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-5 p-5">
          {/* Contact picker */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('mensurar.selectContact')}
            </label>
            {selectedContact ? (
              <div className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-white">
                    {selectedContact.name ?? selectedContact.phone}
                  </p>
                  <p className="text-xs text-slate-400">{selectedContact.phone}</p>
                </div>
                {!prefillContact && (
                  <button
                    onClick={() => setSelectedContact(null)}
                    className="text-slate-500 hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('mensurar.searchContactPlaceholder')}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2.5 pl-9 pr-3 text-sm text-white placeholder-slate-500 focus:border-primary focus:outline-none"
                />
                {contacts.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
                    {contacts.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          setSelectedContact(c)
                          setQuery('')
                          setContacts([])
                        }}
                        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-slate-800"
                      >
                        <div>
                          <p className="text-sm text-white">{c.name ?? c.phone}</p>
                          <p className="text-xs text-slate-400">{c.phone}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Campaign picker */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              {t('mensurar.selectCampaign')}
            </label>
            {campaigns.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">
                {t('mensurar.noCampaignsSync')}
              </p>
            ) : (
              <select
                value={
                  selectedCampaign
                    ? `${selectedCampaign.campaign_id}::${selectedCampaign.adset_id}`
                    : ''
                }
                onChange={(e) => {
                  const [cid, aid] = e.target.value.split('::')
                  const found = campaigns.find(
                    (c) => c.campaign_id === cid && c.adset_id === aid,
                  )
                  setSelectedCampaign(found ?? null)
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white focus:border-primary focus:outline-none"
              >
                <option value="">{t('mensurar.chooseCampaignPlaceholder')}</option>
                {campaigns.map((c) => (
                  <option
                    key={`${c.campaign_id}::${c.adset_id}`}
                    value={`${c.campaign_id}::${c.adset_id}`}
                  >
                    {c.campaign_name} › {c.adset_name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {error && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-400">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4">
          <button
            onClick={handleClose}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!selectedContact || !selectedCampaign || saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? t('common.saving') : t('mensurar.saveAttribution')}
          </button>
        </div>
      </div>
    </div>
  )
}
