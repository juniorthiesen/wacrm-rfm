import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

/**
 * Daily birthday dispatch.
 *
 * For every tenant that has an active `birthday` automation, finds the
 * contacts whose contacts.birthday matches today (month + day, in BRT),
 * claims each one, and fires `runAutomationsForTrigger('birthday', …)` so
 * the operator's own automation steps run (typically a send_template
 * birthday greeting, optionally followed by a coupon).
 *
 * Idempotency: each contact is claimed with a conditional UPDATE on
 * last_birthday_greeting before dispatch, so overlapping invocations
 * (Vercel Cron + an external pinger) never double-send, and a timeout
 * never burns a birthday — unclaimed rows are picked up on the next run.
 *
 * Auth: 'Authorization: Bearer <CRON_SECRET>' (Vercel Cron) or
 * 'x-cron-secret' (external pinger), mirroring the RFM/drip crons.
 */
export const maxDuration = 60

// Safety cap per run so a huge birthday day can't approach the function
// timeout. Leftovers stay unclaimed and go out on the next invocation.
const MAX_PER_RUN = 300

// en-CA renders YYYY-MM-DD; the timeZone yields the BRT calendar date so
// "today" flips at midnight São Paulo time, not UTC.
function todayInSaoPaulo(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Sao_Paulo',
  })
}

function firstNameOf(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? ''
}

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
  const today = todayInSaoPaulo()

  // Only tenants with an active birthday automation do any work — no point
  // scanning (or claiming) contacts for a tenant that wouldn't send.
  const { data: autos, error: autosErr } = await admin
    .from('automations')
    .select('user_id')
    .eq('trigger_type', 'birthday')
    .eq('is_active', true)
  if (autosErr) {
    return NextResponse.json({ error: autosErr.message }, { status: 500 })
  }

  const userIds = [...new Set((autos ?? []).map((a) => a.user_id as string))]
  const summary: Array<{ user_id: string; fired: number; skipped: number }> = []
  let totalFired = 0

  for (const userId of userIds) {
    if (totalFired >= MAX_PER_RUN) break

    const { data: candidates, error: candErr } = await admin.rpc(
      'birthday_contacts_today',
      { p_user_id: userId, p_today: today, p_limit: MAX_PER_RUN },
    )
    if (candErr) {
      console.error(`[birthday-cron] tenant ${userId} query failed:`, candErr)
      summary.push({ user_id: userId, fired: 0, skipped: 0 })
      continue
    }

    let fired = 0
    let skipped = 0
    for (const c of candidates ?? []) {
      if (totalFired >= MAX_PER_RUN) break
      const contactId = c.contact_id as string

      // Claim: only the run that flips last_birthday_greeting to today
      // proceeds. A concurrent run (or a re-run) gets no row back.
      const { data: claimed } = await admin
        .from('contacts')
        .update({ last_birthday_greeting: today })
        .eq('id', contactId)
        .or(`last_birthday_greeting.is.null,last_birthday_greeting.lt.${today}`)
        .select('id')
        .maybeSingle()
      if (!claimed) {
        skipped++
        continue
      }

      const name = (c.contact_name as string | null) ?? null
      await runAutomationsForTrigger({
        userId,
        triggerType: 'birthday',
        contactId,
        context: {
          customer: {
            name: name ?? undefined,
            first_name: firstNameOf(name),
          },
        },
      })
      fired++
      totalFired++
    }

    summary.push({ user_id: userId, fired, skipped })
  }

  return NextResponse.json({ date: today, tenants: userIds.length, summary })
}
