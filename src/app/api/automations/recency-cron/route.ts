import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { runAutomationForContact } from '@/lib/automations/engine';
import { loadRegueReadiness } from '@/lib/automations/regua-preflight';
import {
  executeRecencyEnrollment,
  planRecencyEnrollment,
  supabaseRegueStore,
} from '@/lib/automations/regua';
import type { Automation } from '@/types';

/**
 * Daily enrolment for "lapsed customer" réguas (trigger `recency_reached`).
 *
 * For every active automation of that type: work out how many people may enter
 * today (daily cap minus those already enrolled today), pick the eligible ones
 * (recency window, valid e-mail, not opted out/suppressed, not yet enrolled),
 * split them into treatment/control, record the enrolment, and start the
 * automation for the treatment group only. Control people are enrolled and
 * measured but never contacted.
 *
 * Safety: the cap is per local day; the enrolment row is written before the
 * automation runs (a crash can never make someone receive the sequence twice);
 * a time budget stops the run before the 60 s function limit (people not
 * reached stay eligible for the next run).
 *
 * Auth: 'Authorization: Bearer <CRON_SECRET>' (Vercel Cron) or
 * 'x-cron-secret' (external pinger), same as the birthday/RFM crons.
 * Dry run (no writes): POST /api/automations/[id]/dry-run.
 */
export const maxDuration = 60;

/** Hard ceiling across every automation in one invocation. */
const MAX_PER_RUN = 250;
/** Stop starting new people after this long (ms), leaving headroom under maxDuration. */
const TIME_BUDGET_MS = 48_000;

function firstNameOf(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? process.env.AUTOMATION_CRON_SECRET;
  if (!secret)
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  const authed =
    request.headers.get('authorization') === `Bearer ${secret}` ||
    request.headers.get('x-cron-secret') === secret;
  if (!authed)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const startedAt = Date.now();
  const shouldStop = () => Date.now() - startedAt > TIME_BUDGET_MS;

  const admin = supabaseAdmin();
  const store = supabaseRegueStore(admin);

  const { data: autos, error } = await admin
    .from('automations')
    .select('*')
    .eq('trigger_type', 'recency_reached')
    .eq('is_active', true);
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  const summary: Array<Record<string, unknown>> = [];
  let remaining = MAX_PER_RUN;

  for (const automation of (autos ?? []) as Automation[]) {
    if (remaining <= 0 || shouldStop()) break;
    try {
      // Never enrol people the sequence cannot serve. The engine logs a failed
      // step without throwing, so a not-ready channel would otherwise burn up to
      // `daily_cap` people per day who are never enrolled again (regua-preflight.ts).
      const readiness = await loadRegueReadiness(admin, automation);
      if (readiness.problems.length > 0) {
        summary.push({
          automation_id: automation.id,
          skipped: 'not ready',
          problems: readiness.problems,
        });
        continue;
      }
      const planned = await planRecencyEnrollment(
        store,
        automation,
        new Date(),
        {
          capOverride: readiness.effectiveCap,
        }
      );
      if (!planned.ok) {
        summary.push({
          automation_id: automation.id,
          skipped: 'invalid config',
          errors: planned.errors,
        });
        continue;
      }
      const picks = planned.plan.picks.slice(0, remaining);
      const result = await executeRecencyEnrollment(
        store,
        automation,
        picks,
        (pick) =>
          runAutomationForContact(automation, pick.contact_id, {
            customer: {
              name: pick.name ?? undefined,
              first_name: firstNameOf(pick.name),
              email: pick.email,
            },
            // The condition "purchased_since_enrollment" compares orders against this.
            vars: { enrolled_at: new Date().toISOString() },
          }),
        shouldStop
      );
      remaining -= result.enrolled + result.alreadyEnrolled;
      summary.push({
        automation_id: automation.id,
        budget: planned.plan.budget,
        effective_cap: planned.plan.effectiveCap,
        eligible_total: planned.plan.eligibleTotal,
        ...result,
      });
    } catch (err) {
      console.error('[recency-cron] automation failed:', automation.id, err);
      summary.push({
        automation_id: automation.id,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return NextResponse.json({
    ok: true,
    ran_ms: Date.now() - startedAt,
    automations: summary,
  });
}
