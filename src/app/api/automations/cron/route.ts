import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger). Auth: `Authorization:
 * Bearer <CRON_SECRET>` (Vercel Cron) or the `x-cron-secret` header, matched
 * against `CRON_SECRET` (falling back to `AUTOMATION_CRON_SECRET`).
 * Keeps draining batches until nothing is due or ~48 s have passed.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export const maxDuration = 60

/** Rows claimed per query, and how long to keep draining before stopping. */
const BATCH = 50
const TIME_BUDGET_MS = 48_000

export async function GET(request: Request) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; external pingers
  // use `x-cron-secret`. Either must match (same scheme as birthday/recency crons).
  const expected = process.env.CRON_SECRET ?? process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  const bearer = request.headers.get('authorization')
  if (supplied !== expected && bearer !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const startedAt = Date.now()
  let processed = 0

  // Drain in batches until nothing is due or the time budget is spent. With a
  // once-a-day trigger (Vercel Cron) a single batch of 50 would leave a backlog
  // of every Wait step that came due, e.g. a week-long win-back sequence.
  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const { data: due, error } = await admin
      .from('automation_pending_executions')
      .select('*')
      .eq('status', 'pending')
      .lte('run_at', new Date().toISOString())
      .order('run_at', { ascending: true })
      .limit(BATCH)

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    if (!due || due.length === 0) break

    let claimedInBatch = 0
    for (const row of due) {
      const { data: claim } = await admin
        .from('automation_pending_executions')
        .update({ status: 'running' })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()
      if (!claim) continue

      await resumePendingExecution({
        id: row.id as string,
        automation_id: row.automation_id as string,
        user_id: row.user_id as string,
        contact_id: (row.contact_id as string | null) ?? null,
        log_id: (row.log_id as string | null) ?? null,
        parent_step_id: (row.parent_step_id as string | null) ?? null,
        branch: (row.branch as 'yes' | 'no' | null) ?? null,
        next_step_position: row.next_step_position as number,
        context: (row.context as AutomationContext) ?? {},
      })
      processed++
      claimedInBatch++
    }
    // Everything in this batch was claimed by a concurrent run: stop instead of spinning.
    if (claimedInBatch === 0) break
  }

  return NextResponse.json({ processed })
}
