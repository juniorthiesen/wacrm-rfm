import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { MetaSyncResult } from '@/lib/mensurar/types'

// Meta Marketing API version
const META_API_VERSION = 'v23.0'

interface MetaInsightRow {
  campaign_id: string
  campaign_name: string
  adset_id: string
  adset_name: string
  date_start: string
  spend: string
  impressions: string
  clicks: string
  reach: string
}

interface MetaInsightsResponse {
  data: MetaInsightRow[]
  paging?: {
    cursors?: { after?: string }
    next?: string
  }
}

/**
 * POST /api/meta/sync
 * Fetches campaign Insights from the Meta Marketing API for the past 30 days
 * and upserts them into ad_campaigns_cache.
 *
 * Body: { days?: number } — defaults to 30
 */
export async function POST(req: Request) {
  try {
    const db = await createClient()
    const { data: { user } } = await db.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Load config
    const { data: config } = await db
      .from('meta_ads_config')
      .select('access_token, ad_account_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!config?.access_token || !config?.ad_account_id) {
      return NextResponse.json(
        { error: 'Meta Ads not configured. Go to Settings → Meta Ads.' },
        { status: 422 },
      )
    }

    const body = await req.json().catch(() => ({}))
    const days: number = body.days ?? 30

    const datePreset = days <= 7
      ? 'last_7d'
      : days <= 30
        ? 'last_30d'
        : 'last_90d'

    const fields = [
      'campaign_id',
      'campaign_name',
      'adset_id',
      'adset_name',
      'spend',
      'impressions',
      'clicks',
      'reach',
    ].join(',')

    // Fetch all pages from Meta Insights
    const rows: MetaInsightRow[] = []
    let url: string | null =
      `https://graph.facebook.com/${META_API_VERSION}/${config.ad_account_id}/insights` +
      `?fields=${fields}&level=adset&date_preset=${datePreset}&time_increment=1` +
      `&access_token=${encodeURIComponent(config.access_token)}&limit=500`

    while (url) {
      const resp = await fetch(url)
      if (!resp.ok) {
        const errBody = await resp.text()
        return NextResponse.json(
          { error: `Meta API error: ${resp.status} — ${errBody}` },
          { status: 502 },
        )
      }
      const json: MetaInsightsResponse = await resp.json()
      rows.push(...(json.data ?? []))
      url = json.paging?.next ?? null
    }

    if (rows.length === 0) {
      // Update last_synced_at even when no data
      await db
        .from('meta_ads_config')
        .update({ last_synced_at: new Date().toISOString() })
        .eq('user_id', user.id)

      const result: MetaSyncResult = {
        synced: 0,
        errors: [],
        last_synced_at: new Date().toISOString(),
      }
      return NextResponse.json(result)
    }

    // Upsert into ad_campaigns_cache in batches of 200
    const errors: string[] = []
    const toUpsert = rows.map(r => ({
      user_id: user.id,
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      adset_id: r.adset_id,
      adset_name: r.adset_name,
      date: r.date_start,
      spend: parseFloat(r.spend ?? '0'),
      impressions: parseInt(r.impressions ?? '0', 10),
      clicks: parseInt(r.clicks ?? '0', 10),
      reach: parseInt(r.reach ?? '0', 10),
    }))

    const BATCH = 200
    let synced = 0
    for (let i = 0; i < toUpsert.length; i += BATCH) {
      const batch = toUpsert.slice(i, i + BATCH)
      const { error } = await db
        .from('ad_campaigns_cache')
        .upsert(batch, { onConflict: 'user_id,campaign_id,adset_id,date' })
      if (error) {
        errors.push(error.message)
      } else {
        synced += batch.length
      }
    }

    const now = new Date().toISOString()
    await db
      .from('meta_ads_config')
      .update({ last_synced_at: now })
      .eq('user_id', user.id)

    const result: MetaSyncResult = { synced, errors, last_synced_at: now }
    return NextResponse.json(result)
  } catch (err) {
    console.error('[meta/sync] unexpected error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

/**
 * GET /api/meta/sync
 * Quick connectivity test: fetches the ad account name to verify the token.
 */
export async function GET() {
  try {
    const db = await createClient()
    const { data: { user } } = await db.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: config } = await db
      .from('meta_ads_config')
      .select('access_token, ad_account_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!config?.access_token || !config?.ad_account_id) {
      return NextResponse.json({ ok: false, error: 'Not configured' })
    }

    const url =
      `https://graph.facebook.com/${META_API_VERSION}/${config.ad_account_id}` +
      `?fields=name,currency,account_status` +
      `&access_token=${encodeURIComponent(config.access_token)}`

    const resp = await fetch(url)
    if (!resp.ok) {
      const errBody = await resp.text()
      return NextResponse.json({ ok: false, error: errBody })
    }

    const account = await resp.json()
    return NextResponse.json({ ok: true, account })
  } catch (err) {
    console.error('[meta/sync GET] unexpected error:', err)
    return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 })
  }
}
