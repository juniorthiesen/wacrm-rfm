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

interface RfmRow {
  contact_id: string;
  segment: RFMSegmentKey | null;
  recency_score: number | null;
  frequency_score: number | null;
  monetary_score: number | null;
  recency_days: number | null;
  frequency_count: number | null;
  monetary_value: number | null;
  last_calculated_at: string | null;
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
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

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pull every RFM row for the tenant. Even on the upper end (~50k
  // customers) this is one Postgres scan; aggregating in JS keeps the
  // code readable and avoids 8 round-trips for the segment counts.
  const { data: rfmData, error: rfmError } = await supabase
    .from("contact_rfm_metrics")
    .select(
      "contact_id, segment, recency_score, frequency_score, monetary_score, recency_days, frequency_count, monetary_value, last_calculated_at",
    )
    .eq("user_id", user.id);
  if (rfmError) {
    return NextResponse.json({ error: rfmError.message }, { status: 500 });
  }
  const rows = (rfmData ?? []) as RfmRow[];

  // Totals + per-segment buckets.
  const segmentBuckets = new Map<
    string,
    { count: number; revenue: number; ticketSum: number }
  >();
  let totalCustomers = 0;
  let totalRevenue = 0;
  let recencySum = 0;
  let lastCalculated: string | null = null;
  // 5x5 grid keyed "r-f".
  const heatmap = new Map<string, { count: number; revenue: number }>();
  // Track top contacts per segment as we scan, to avoid a second pass.
  const topByMonetary: Array<{ contactId: string; row: RfmRow }> = [];

  for (const row of rows) {
    totalCustomers += 1;
    const monetary = Number(row.monetary_value ?? 0);
    totalRevenue += monetary;
    if (row.recency_days != null) recencySum += row.recency_days;
    if (
      row.last_calculated_at &&
      (!lastCalculated || row.last_calculated_at > lastCalculated)
    ) {
      lastCalculated = row.last_calculated_at;
    }

    const seg = row.segment ?? "lost";
    const bucket =
      segmentBuckets.get(seg) ?? { count: 0, revenue: 0, ticketSum: 0 };
    bucket.count += 1;
    bucket.revenue += monetary;
    if (row.frequency_count && row.frequency_count > 0) {
      bucket.ticketSum += monetary / row.frequency_count;
    }
    segmentBuckets.set(seg, bucket);

    if (row.recency_score != null && row.frequency_score != null) {
      const key = `${row.recency_score}-${row.frequency_score}`;
      const cell = heatmap.get(key) ?? { count: 0, revenue: 0 };
      cell.count += 1;
      cell.revenue += monetary;
      heatmap.set(key, cell);
    }

    topByMonetary.push({ contactId: row.contact_id, row });
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
  const heatmapCells: Array<{ r: number; f: number; count: number; revenue: number }> = [];
  for (let r = 1; r <= 5; r++) {
    for (let f = 1; f <= 5; f++) {
      const c = heatmap.get(`${r}-${f}`) ?? { count: 0, revenue: 0 };
      heatmapCells.push({ r, f, count: c.count, revenue: c.revenue });
    }
  }

  // Top contacts per "actionable" segment. Limit a few names worth a
  // round-trip to fetch their display details from `contacts`.
  const topChampions = filterTopBySegment(topByMonetary, "champion", 10);
  const topAtRisk = filterTopBySegment(topByMonetary, "in_risk", 10);
  const contactIds = Array.from(
    new Set([
      ...topChampions.map((x) => x.contactId),
      ...topAtRisk.map((x) => x.contactId),
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

  function hydrate(item: { contactId: string; row: RfmRow }): TopContact {
    const c = contactsById.get(item.contactId);
    return {
      contact_id: item.contactId,
      name: c?.name ?? null,
      phone: c?.phone ?? null,
      email: c?.email ?? null,
      monetary_value: Number(item.row.monetary_value ?? 0),
      recency_days: item.row.recency_days,
      frequency_count: item.row.frequency_count,
    };
  }

  const avgRecency =
    totalCustomers > 0 ? Math.round(recencySum / totalCustomers) : null;
  const avgTicket =
    totalCustomers > 0
      ? rows.reduce((acc, r) => {
          if (r.frequency_count && r.frequency_count > 0) {
            return acc + Number(r.monetary_value ?? 0) / r.frequency_count;
          }
          return acc;
        }, 0) / totalCustomers
      : 0;

  return NextResponse.json({
    total_customers: totalCustomers,
    total_revenue: totalRevenue,
    avg_recency_days: avgRecency,
    avg_ticket: avgTicket,
    last_calculated_at: lastCalculated,
    segments,
    heatmap: heatmapCells,
    top_champions: topChampions.map(hydrate),
    top_at_risk: topAtRisk.map(hydrate),
  });
}

function filterTopBySegment(
  all: Array<{ contactId: string; row: RfmRow }>,
  segment: RFMSegmentKey,
  limit: number,
): Array<{ contactId: string; row: RfmRow }> {
  return all
    .filter((x) => x.row.segment === segment)
    .sort(
      (a, b) =>
        Number(b.row.monetary_value ?? 0) - Number(a.row.monetary_value ?? 0),
    )
    .slice(0, limit);
}
