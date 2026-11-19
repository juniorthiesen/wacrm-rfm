import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  maskEmail,
  planRecencyEnrollment,
  supabaseRegueStore,
} from '@/lib/automations/regua';
import { loadRegueReadiness } from '@/lib/automations/regua-preflight';
import { createClient } from '@/lib/supabase/server';
import type { Automation } from '@/types';

/**
 * POST /api/automations/[id]/dry-run  ("ensaio")
 *
 * Shows what the recency régua WOULD do today without enrolling or sending
 * anything: eligible people, today's budget under the daily cap, the
 * treatment/control split, a masked sample, and a pre-flight of everything the
 * sequence depends on (e-mail channel, store integration for coupons, public
 * URL for the unsubscribe link). Meant to be reviewed and approved by a human
 * before the automation is activated.
 *
 * `problems` are blocking: the daily cron will NOT enrol anyone while any
 * remains (same rules, regua-preflight.ts). `warnings` are advisory.
 * `effective_cap` is the daily cap actually applied: the configured one, lowered
 * so the whole sequence fits in the e-mail daily limit.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // RLS: only the owner's automation is visible.
  const { data: automation, error } = await supabase
    .from('automations')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  if (!automation)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if ((automation as Automation).trigger_type !== 'recency_reached') {
    return NextResponse.json(
      { error: 'Not a recency automation' },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();
  const readiness = await loadRegueReadiness(admin, automation as Automation);
  const planned = await planRecencyEnrollment(
    supabaseRegueStore(admin),
    automation as Automation,
    new Date(),
    {
      capOverride: readiness.effectiveCap,
    }
  );
  if (!planned.ok)
    return NextResponse.json(
      { error: planned.errors.join('; '), errors: planned.errors },
      { status: 400 }
    );
  const { plan } = planned;

  const warnings = [...readiness.warnings];
  if (plan.eligibleTotal === 0)
    warnings.push(
      'Ninguém elegível agora. Confira se o cálculo do RFM já rodou e se a janela de dias está certa.'
    );
  if (plan.config.control_percent === 0)
    warnings.push(
      'Sem grupo de controle: não será possível medir o efeito real da régua.'
    );

  return NextResponse.json({
    config: plan.config,
    effective_cap: plan.effectiveCap,
    enrolled_today: plan.enrolledToday,
    budget_today: plan.budget,
    eligible_total: plan.eligibleTotal,
    days_to_drain:
      plan.effectiveCap > 0
        ? Math.ceil(plan.eligibleTotal / plan.effectiveCap)
        : null,
    would_enroll: {
      total: plan.picks.length,
      treatment: plan.treatmentCount,
      control: plan.controlCount,
    },
    sample: plan.picks.slice(0, 10).map((p) => ({
      email: maskEmail(p.email),
      first_name: (p.name ?? '').trim().split(/\s+/)[0] || null,
      recency_days: p.recency_days,
      cohort: p.cohort,
    })),
    ready: readiness.problems.length === 0,
    problems: readiness.problems,
    warnings,
  });
}
