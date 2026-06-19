import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

/**
 * Daily birthday dispatch.
 *
 * Two parallel flows fire from the same cron — the trigger row each
 * tenant has decides which one runs for them:
 *
 *   1. `birthday`        — fires on the contact's actual birthday
 *                          (matched on month + day, BRT). Once-per-year
 *                          via contacts.last_birthday_greeting.
 *   2. `birthday_month`  — fires once per year for every contact whose
 *                          birth MONTH equals the current month, the
 *                          first time the cron sees them in that month.
 *                          Lets the operator send a "your month is on"
 *                          coupon ahead of the actual birthday. Once-
 *                          per-year via contacts.last_birthday_month_greeting.
 *
 * Idempotency: each contact is claimed with a conditional UPDATE on
 * the dedupe column before dispatch, so overlapping invocations
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

  // One query picks up both trigger types — we then split per-user so
  // a tenant that only enabled the month message doesn't pay for the
  // day-of scan and vice versa.
  const { data: autos, error: autosErr } = await admin
    .from('automations')
    .select('user_id, trigger_type')
    .in('trigger_type', ['birthday', 'birthday_month'])
    .eq('is_active', true)
  if (autosErr) {
    return NextResponse.json({ error: autosErr.message }, { status: 500 })
  }

  const dayUsers = new Set<string>()
  const monthUsers = new Set<string>()
  for (const a of autos ?? []) {
    if (a.trigger_type === 'birthday') dayUsers.add(a.user_id as string)
    if (a.trigger_type === 'birthday_month') monthUsers.add(a.user_id as string)
  }
  const allUsers = new Set<string>([...dayUsers, ...monthUsers])

  const summary: Array<{
    user_id: string
    day_fired: number
    day_skipped: number
    month_fired: number
    month_skipped: number
  }> = []
  let totalFired = 0

  for (const userId of allUsers) {
    if (totalFired >= MAX_PER_RUN) break
    let day_fired = 0
    let day_skipped = 0
    let month_fired = 0
    let month_skipped = 0

    // ---- 1. Day-of birthday ----
    if (dayUsers.has(userId) && totalFired < MAX_PER_RUN) {
      const { data: candidates, error: candErr } = await admin.rpc(
        'birthday_contacts_today',
        { p_user_id: userId, p_today: today, p_limit: MAX_PER_RUN },
      )
      if (candErr) {
        console.error(`[birthday-cron] day query failed for ${userId}:`, candErr)
      } else {
        for (const c of candidates ?? []) {
          if (totalFired >= MAX_PER_RUN) break
          const contactId = c.contact_id as string

          // Claim by flipping last_birthday_greeting to today.
          const { data: claimed } = await admin
            .from('contacts')
            .update({ last_birthday_greeting: today })
            .eq('id', contactId)
            .or(`last_birthday_greeting.is.null,last_birthday_greeting.lt.${today}`)
            .select('id')
            .maybeSingle()
          if (!claimed) {
            day_skipped++
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
          day_fired++
          totalFired++
        }
      }
    }

    // ---- 2. Month-of birthday ----
    // Same shape as the day-of path, just a different RPC + dedupe column.
    if (monthUsers.has(userId) && totalFired < MAX_PER_RUN) {
      const { data: candidates, error: candErr } = await admin.rpc(
        'birthday_month_contacts_today',
        { p_user_id: userId, p_today: today, p_limit: MAX_PER_RUN },
      )
      if (candErr) {
        console.error(
          `[birthday-cron] month query failed for ${userId}:`,
          candErr,
        )
      } else {
        // Claim only contacts whose last_birthday_month_greeting is
        // older than the start of the current year. Storing the date
        // means we can re-run safely every day in the month — only the
        // first claim of the year succeeds.
        const yearStart = `${today.slice(0, 4)}-01-01`
        for (const c of candidates ?? []) {
          if (totalFired >= MAX_PER_RUN) break
          const contactId = c.contact_id as string

          const { data: claimed } = await admin
            .from('contacts')
            .update({ last_birthday_month_greeting: today })
            .eq('id', contactId)
            .or(
              `last_birthday_month_greeting.is.null,last_birthday_month_greeting.lt.${yearStart}`,
            )
            .select('id')
            .maybeSingle()
          if (!claimed) {
            month_skipped++
            continue
          }

          const name = (c.contact_name as string | null) ?? null
          await runAutomationsForTrigger({
            userId,
            triggerType: 'birthday_month',
            contactId,
            context: {
              customer: {
                name: name ?? undefined,
                first_name: firstNameOf(name),
              },
            },
          })
          month_fired++
          totalFired++
        }
      }
    }

    summary.push({
      user_id: userId,
      day_fired,
      day_skipped,
      month_fired,
      month_skipped,
    })
  }

  return NextResponse.json({
    date: today,
    tenants: allUsers.size,
    summary,
  })
}
