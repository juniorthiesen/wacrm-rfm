import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Aggregate endpoint feeding the /dashboard/rfm page. One round trip,
// no client-side aggregation, returns a payload that maps 1:1 onto the
// UI widgets.
//
// Why query `contact_rfm_metrics` and not raw `orders`:
//   The RFM engine (lib/rfm/engine.ts) already does the heavy lifting —
//   percentile scores, segment assignment — and stores results in
//   `contact_rfm_metrics`. Re-deriving here would just duplicate logic
//   and risk drift. The price is that "last recalculated_at" matters:
//   the page surfaces it so operators know to run recalc after a sync.

export const SEGMENTS = [
  "champion",
  "loyal",
  "new_customer",
  "about_to_sleep",
  "in_risk",
  "hibernating",
  "lost",
  "new_lead",
] as const;
export type RFMSegmentKey = (typeof SEGMENTS)[number];

interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

interface TopMetricRow {
  contact_id: string;
  monetary_value: number | null;
  recency_days: number | null;
  frequency_count: number | null;
}

interface TopContact {
  contact_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  monetary_value: number;
  recency_days: number | null;
  frequency_count: number | null;
}

// Shape of the jsonb returned by the rfm_insights() Postgres function.
interface InsightsAgg {
  total_customers: number | string | null;
  total_revenue: number | string | null;
  avg_recency_days: number | string | null;
  avg_ticket: number | string | null;
  last_calculated_at: string | null;
  segments: Array<{
    segment: string;
    count: number | string;
    revenue: number | string;
    ticket_sum: number | string;
  }> | null;
  heatmap: Array<{
    r: number;
    f: number;
    count: number | string;
    revenue: number | string;
  }> | null;
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Aggregate set-based in Postgres (rfm_insights, migration 027). The
  // previous in-app aggregation read contact_rfm_metrics with a plain
  // select capped at 1000 rows, so every total was computed over at
  // most 1000 customers regardless of the real base.
  const { data: aggData, error: aggError } = await supabase.rpc(
    "rfm_insights",
    { p_user_id: user.id },
  );
  if (aggError) {
    return NextResponse.json({ error: aggError.message }, { status: 500 });
  }
  const agg = (aggData ?? {}) as InsightsAgg;

  const totalCustomers = Number(agg.total_customers ?? 0);
  const totalRevenue = Number(agg.total_revenue ?? 0);
  const avgRecency =
    agg.avg_recency_days != null ? Math.round(Number(agg.avg_recency_days)) : null;
  const avgTicket = Number(agg.avg_ticket ?? 0);
  const lastCalculated = agg.last_calculated_at ?? null;

  const segmentBuckets = new Map<
    string,
    { count: number; revenue: number; ticketSum: number }
  >();
  for (const s of agg.segments ?? []) {
    segmentBuckets.set(s.segment, {
      count: Number(s.count),
      revenue: Number(s.revenue),
      ticketSum: Number(s.ticket_sum),
    });
  }

  // Build segment array in stable order so the UI palette aligns.
  const segments = SEGMENTS.map((key) => {
    const b = segmentBuckets.get(key) ?? { count: 0, revenue: 0, ticketSum: 0 };
    return {
      key,
      count: b.count,
      revenue: b.revenue,
      customers_pct: totalCustomers > 0 ? (b.count / totalCustomers) * 100 : 0,
      revenue_pct: totalRevenue > 0 ? (b.revenue / totalRevenue) * 100 : 0,
      avg_ticket: b.count > 0 ? b.ticketSum / b.count : 0,
    };
  });

  // Heatmap as a 25-cell array (always 5x5 so the renderer doesn't
  // need to handle missing cells).
  const heatLookup = new Map<string, { count: number; revenue: number }>();
  for (const c of agg.heatmap ?? []) {
    heatLookup.set(`${c.r}-${c.f}`, {
      count: Number(c.count),
      revenue: Number(c.revenue),
    });
  }
  const heatmapCells: Array<{ r: number; f: number; count: number; revenue: number }> = [];
  for (let r = 1; r <= 5; r++) {
    for (let f = 1; f <= 5; f++) {
      const c = heatLookup.get(`${r}-${f}`) ?? { count: 0, revenue: 0 };
      heatmapCells.push({ r, f, count: c.count, revenue: c.revenue });
    }
  }

  // Top contacts per "actionable" segment — ordered + limited in the DB
  // so they're never subject to the 1000-row cap.
  const [championRows, atRiskRows] = await Promise.all([
    fetchTopBySegment(supabase, user.id, "champion"),
    fetchTopBySegment(supabase, user.id, "in_risk"),
  ]);

  const contactIds = Array.from(
    new Set([
      ...championRows.map((x) => x.contact_id),
      ...atRiskRows.map((x) => x.contact_id),
    ]),
  );

  let contactsById = new Map<string, ContactRow>();
  if (contactIds.length > 0) {
    const { data: contactRows } = await supabase
      .from("contacts")
      .select("id, name, phone, email")
      .in("id", contactIds);
    contactsById = new Map(
      ((contactRows ?? []) as ContactRow[]).map((c) => [c.id, c]),
    );
  }

  function hydrate(row: TopMetricRow): TopContact {
    const c = contactsById.get(row.contact_id);
    return {
      contact_id: row.contact_id,
      name: c?.name ?? null,
      phone: c?.phone ?? null,
      email: c?.email ?? null,
      monetary_value: Number(row.monetary_value ?? 0),
      recency_days: row.recency_days,
      frequency_count: row.frequency_count,
    };
  }

  return NextResponse.json({
    total_customers: totalCustomers,
    total_revenue: totalRevenue,
    avg_recency_days: avgRecency,
    avg_ticket: avgTicket,
    last_calculated_at: lastCalculated,
    segments,
    heatmap: heatmapCells,
    top_champions: championRows.map(hydrate),
    top_at_risk: atRiskRows.map(hydrate),
  });
}

async function fetchTopBySegment(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  segment: RFMSegmentKey,
): Promise<TopMetricRow[]> {
  const { data } = await supabase
    .from("contact_rfm_metrics")
    .select("contact_id, monetary_value, recency_days, frequency_count")
    .eq("user_id", userId)
    .eq("segment", segment)
    .order("monetary_value", { ascending: false })
    .limit(10);
  return (data ?? []) as TopMetricRow[];
}
