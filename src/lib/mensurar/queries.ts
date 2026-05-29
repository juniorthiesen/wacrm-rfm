import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AttributionKPIs,
  CampaignBreakdownRow,
  LeadsTimelinePoint,
  CampaignOption,
  MetaAdsConfig,
} from './types'

// ─── Config ──────────────────────────────────────────────────────────────────

export async function loadMetaAdsConfig(
  db: SupabaseClient,
): Promise<MetaAdsConfig | null> {
  const { data } = await db
    .from('meta_ads_config')
    .select('*')
    .maybeSingle()
  return data ?? null
}

export async function saveMetaAdsConfig(
  db: SupabaseClient,
  config: { access_token: string; ad_account_id: string },
): Promise<void> {
  const { data: { user } } = await db.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await db.from('meta_ads_config').upsert({
    user_id: user.id,
    access_token: config.access_token,
    ad_account_id: config.ad_account_id,
  }, { onConflict: 'user_id' })
}

// ─── KPI Summary ─────────────────────────────────────────────────────────────

export async function loadAttributionKPIs(
  db: SupabaseClient,
  rangeDays: number,
): Promise<AttributionKPIs> {
  const since = new Date()
  since.setDate(since.getDate() - rangeDays)
  const sinceStr = since.toISOString().split('T')[0]

  // Total leads attributed in the period
  const { count: totalLeads } = await db
    .from('ad_attributions')
    .select('*', { count: 'exact', head: true })
    .gte('attributed_at', sinceStr)

  // Total spend in the period
  const { data: spendData } = await db
    .from('ad_campaigns_cache')
    .select('spend')
    .gte('date', sinceStr)

  const totalSpend = (spendData ?? []).reduce(
    (sum, r) => sum + Number(r.spend),
    0,
  )

  // Total revenue from deals linked to attributions in the period
  const { data: dealsData } = await db
    .from('ad_attributions')
    .select('deal_id, deals(value)')
    .gte('attributed_at', sinceStr)
    .not('deal_id', 'is', null)

  const totalRevenue = (dealsData ?? []).reduce((sum, r) => {
    const d = r.deals as { value?: number } | null
    return sum + Number(d?.value ?? 0)
  }, 0)

  const totalConversions = (dealsData ?? []).filter(r => r.deal_id).length
  const avgCPL = totalLeads && totalLeads > 0 ? totalSpend / totalLeads : 0
  const estimatedROAS = totalSpend > 0 ? totalRevenue / totalSpend : 0

  return {
    totalLeads: totalLeads ?? 0,
    totalSpend,
    avgCPL,
    estimatedROAS,
    totalRevenue,
    totalConversions,
  }
}

// ─── Campaigns Breakdown Table ────────────────────────────────────────────────

export async function loadCampaignBreakdown(
  db: SupabaseClient,
  rangeDays: number,
): Promise<CampaignBreakdownRow[]> {
  const since = new Date()
  since.setDate(since.getDate() - rangeDays)
  const sinceStr = since.toISOString().split('T')[0]

  // Fetch spend data grouped by campaign+adset
  const { data: spendRows } = await db
    .from('ad_campaigns_cache')
    .select('campaign_id, campaign_name, adset_id, adset_name, spend, impressions, clicks')
    .gte('date', sinceStr)

  // Aggregate spend by campaign+adset
  const spendMap = new Map<string, {
    campaign_name: string
    adset_name: string
    spend: number
    impressions: number
    clicks: number
  }>()

  for (const row of spendRows ?? []) {
    const key = `${row.campaign_id}::${row.adset_id}`
    const existing = spendMap.get(key)
    if (existing) {
      existing.spend += Number(row.spend)
      existing.impressions += Number(row.impressions)
      existing.clicks += Number(row.clicks)
    } else {
      spendMap.set(key, {
        campaign_name: row.campaign_name,
        adset_name: row.adset_name,
        spend: Number(row.spend),
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
      })
    }
  }

  // Fetch attribution data with deals
  const { data: attrRows } = await db
    .from('ad_attributions')
    .select('campaign_id, adset_id, deal_id, deals(value)')
    .gte('attributed_at', sinceStr)

  // Aggregate leads/conversions/revenue by campaign+adset
  const attrMap = new Map<string, { leads: number; conversions: number; revenue: number }>()
  for (const row of attrRows ?? []) {
    const key = `${row.campaign_id}::${row.adset_id ?? ''}`
    const existing = attrMap.get(key) ?? { leads: 0, conversions: 0, revenue: 0 }
    existing.leads++
    const d = row.deals as { value?: number } | null
    if (row.deal_id && d?.value) {
      existing.conversions++
      existing.revenue += Number(d.value)
    }
    attrMap.set(key, existing)
  }

  // Merge spend + attribution data
  const rows: CampaignBreakdownRow[] = []
  for (const [key, spend] of spendMap.entries()) {
    const [campaign_id, adset_id] = key.split('::')
    const attr = attrMap.get(key) ?? { leads: 0, conversions: 0, revenue: 0 }
    rows.push({
      campaign_id,
      campaign_name: spend.campaign_name,
      adset_id,
      adset_name: spend.adset_name,
      leads: attr.leads,
      conversions: attr.conversions,
      spend: spend.spend,
      cpl: attr.leads > 0 ? spend.spend / attr.leads : 0,
      revenue: attr.revenue,
      roas: spend.spend > 0 ? attr.revenue / spend.spend : 0,
      impressions: spend.impressions,
      clicks: spend.clicks,
      ctr: spend.impressions > 0 ? spend.clicks / spend.impressions : 0,
      cpc: spend.clicks > 0 ? spend.spend / spend.clicks : 0,
    })
  }

  // Also add attributions for campaigns not in the spend cache
  for (const [key, attr] of attrMap.entries()) {
    if (!spendMap.has(key)) {
      const [campaign_id, adset_id] = key.split('::')
      // Find names from attribution rows
      const sample = (attrRows ?? []).find(
        r => r.campaign_id === campaign_id && (r.adset_id ?? '') === adset_id,
      )
      rows.push({
        campaign_id,
        campaign_name: '',
        adset_id,
        adset_name: '',
        leads: attr.leads,
        conversions: attr.conversions,
        spend: 0,
        cpl: 0,
        revenue: attr.revenue,
        roas: 0,
        impressions: 0,
        clicks: 0,
        ctr: 0,
        cpc: 0,
      })
      void sample // used for type checking
    }
  }

  return rows.sort((a, b) => b.leads - a.leads)
}

// ─── Leads Timeline ───────────────────────────────────────────────────────────

export async function loadLeadsTimeline(
  db: SupabaseClient,
  rangeDays: number,
): Promise<LeadsTimelinePoint[]> {
  const since = new Date()
  since.setDate(since.getDate() - rangeDays)
  const sinceStr = since.toISOString().split('T')[0]

  const { data } = await db
    .from('ad_attributions')
    .select('attributed_at, campaign_name')
    .gte('attributed_at', sinceStr)
    .order('attributed_at', { ascending: true })

  // Group by date + campaign
  const map = new Map<string, number>()
  const points: LeadsTimelinePoint[] = []

  for (const row of data ?? []) {
    const date = (row.attributed_at as string).split('T')[0]
    const key = `${date}::${row.campaign_name}`
    if (!map.has(key)) {
      map.set(key, points.length)
      points.push({ date, leads: 0, campaign_name: row.campaign_name })
    }
    points[map.get(key)!].leads++
  }

  return points
}

// ─── Campaign Options for Picker ─────────────────────────────────────────────

export async function loadCampaignOptions(
  db: SupabaseClient,
): Promise<CampaignOption[]> {
  const { data } = await db
    .from('ad_campaigns_cache')
    .select('campaign_id, campaign_name, adset_id, adset_name')
    .order('campaign_name', { ascending: true })

  if (!data) return []

  // Deduplicate by campaign+adset
  const seen = new Set<string>()
  const options: CampaignOption[] = []
  for (const row of data) {
    const key = `${row.campaign_id}::${row.adset_id}`
    if (!seen.has(key)) {
      seen.add(key)
      options.push({
        campaign_id: row.campaign_id,
        campaign_name: row.campaign_name,
        adset_id: row.adset_id,
        adset_name: row.adset_name,
      })
    }
  }
  return options
}

// ─── Save Attribution ─────────────────────────────────────────────────────────

export async function saveAttribution(
  db: SupabaseClient,
  payload: {
    contact_id: string
    campaign_id: string
    campaign_name: string
    adset_id: string
    adset_name: string
    deal_id?: string
    source?: 'manual' | 'ctwa'
  },
): Promise<void> {
  const { data: { user } } = await db.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await db.from('ad_attributions').upsert({
    user_id: user.id,
    contact_id: payload.contact_id,
    campaign_id: payload.campaign_id,
    campaign_name: payload.campaign_name,
    adset_id: payload.adset_id,
    adset_name: payload.adset_name,
    deal_id: payload.deal_id ?? null,
    source: payload.source ?? 'manual',
    attributed_at: new Date().toISOString(),
  }, { onConflict: 'user_id,contact_id' })
}
