import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// RFM scores + segment tags drift as customers buy (or go quiet), so a
// nightly refresh keeps the dashboard and the broadcast segment tags
// current without anyone clicking "Recalcular". A single SQL round-trip
// per tenant (both steps are set-based functions), so this stays fast.
export const maxDuration = 60

/**
 * Daily RFM refresh for every WooCommerce tenant:
 *   recalculate_user_rfm  → fresh scores/segments
 *   sync_rfm_tags         → segment tags follow the new segments
 *
 * Scheduled by Vercel Cron (vercel.json) at 06:00 UTC = 03:00 BRT.
 * Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`; an external
 * pinger (the VPS deploy) can use the `x-cron-secret` header instead.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? process.env.AUTOMATION_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const authed =
    request.headers.get('authorization') === `Bearer ${secret}` ||
    request.headers.get('x-cron-secret') === secret
  if (!authed) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: configs, error } = await admin
    .from('integration_configs')
    .select('user_id')
    .eq('platform', 'woocommerce')
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const userIds = [...new Set((configs ?? []).map((c) => c.user_id as string))]
  const results: { user_id: string; updated?: number; error?: string }[] = []

  for (const userId of userIds) {
    try {
      const { data: updated, error: rfmErr } = await admin.rpc(
        'recalculate_user_rfm',
        { p_user_id: userId },
      )
      if (rfmErr) throw new Error(rfmErr.message)
      const { error: tagErr } = await admin.rpc('sync_rfm_tags', {
        p_user_id: userId,
      })
      if (tagErr) throw new Error(tagErr.message)
      results.push({
        user_id: userId,
        updated: typeof updated === 'number' ? updated : 0,
      })
    } catch (e) {
      console.error(`[rfm-cron] tenant ${userId} failed:`, e)
      results.push({
        user_id: userId,
        error: e instanceof Error ? e.message : 'failed',
      })
    }
  }

  return NextResponse.json({ tenants: userIds.length, results })
}
