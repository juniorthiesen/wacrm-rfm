import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { summarizeRegueReport, type ReportRow } from '@/lib/automations/regua';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/automations/[id]/report?days=7
 *
 * Treatment vs control for a recency régua: who entered, who bought within
 * `days` after entering (paid orders only), revenue, the estimated extra
 * buyers/revenue the régua caused, plus e-mail delivery numbers.
 * Read-only; ownership is checked through RLS.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const requested = Number(request.nextUrl.searchParams.get('days') ?? 7);
  const days = Number.isInteger(requested)
    ? Math.min(60, Math.max(1, requested))
    : 7;

  const { data: automation, error } = await supabase
    .from('automations')
    .select('id, name, trigger_type')
    .eq('id', id)
    .maybeSingle();
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  if (!automation)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const admin = supabaseAdmin();

  const { data: rows, error: reportError } = await admin.rpc('regua_report', {
    p_automation_id: id,
    p_window_days: days,
  });
  if (reportError)
    return NextResponse.json({ error: reportError.message }, { status: 500 });

  const report = summarizeRegueReport(
    ((rows ?? []) as Array<Record<string, unknown>>).map(
      (r): ReportRow => ({
        cohort: r.cohort === 'control' ? 'control' : 'treatment',
        enrolled: Number(r.enrolled),
        matured: Number(r.matured),
        converted: Number(r.converted),
        orders_count: Number(r.orders_count),
        revenue: Number(r.revenue),
      })
    )
  );

  // E-mail delivery for this automation (counted in JS: PostgREST has no GROUP BY).
  const { data: messages } = await admin
    .from('email_messages')
    .select('status')
    .eq('automation_id', id)
    .limit(100000);
  const emails: Record<string, number> = {};
  for (const m of messages ?? []) {
    const status = String((m as { status: string }).status);
    emails[status] = (emails[status] ?? 0) + 1;
  }

  // The engine records a failed step in the automation log without throwing, so
  // this is the only place a broken sequence (e.g. coupon creation failing) shows up.
  const { data: logs } = await admin
    .from('automation_logs')
    .select('status')
    .eq('automation_id', id)
    .limit(100000);
  const runs: Record<string, number> = {};
  for (const l of logs ?? []) {
    const status = String((l as { status: string }).status);
    runs[status] = (runs[status] ?? 0) + 1;
  }

  const { count: couponsIssued } = await admin
    .from('automation_enrollments')
    .select('id', { count: 'exact', head: true })
    .eq('automation_id', id)
    .not('coupon_code', 'is', null);

  return NextResponse.json({
    automation: { id: automation.id, name: automation.name },
    window_days: days,
    report,
    emails,
    runs,
    coupons_issued: couponsIssued ?? 0,
  });
}
