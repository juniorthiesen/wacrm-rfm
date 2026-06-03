import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { aggregateProducts } from "@/lib/commerce/line-items";
import { buildOrderAdminUrl } from "@/lib/commerce/order-urls";
import type {
  CommercePlatform,
  NormalizedLineItem,
} from "@/lib/commerce/types";

// How many recent orders we materialize for the sidebar. Plenty for the
// "products purchased" widget while keeping the payload small even for
// high-volume contacts.
const ORDER_FETCH_LIMIT = 25;

interface OrderRow {
  id: string;
  external_order_id: string;
  order_number: string | null;
  platform: CommercePlatform;
  status: string;
  total_amount: number | string;
  currency: string;
  ordered_at: string;
  line_items: NormalizedLineItem[] | null;
}

interface IntegrationConfigRow {
  platform: CommercePlatform;
  store_url: string | null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: contactId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // RLS scopes contacts to `auth.uid()`. If the row doesn't belong to the
  // caller they get an empty result, which we surface as 404 so the UI can
  // hide the section instead of showing stale data.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .maybeSingle();

  if (contactError) {
    return NextResponse.json(
      { error: contactError.message },
      { status: 500 },
    );
  }
  if (!contact) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Three queries in parallel: RFM metrics, recent orders, integration
  // configs (for admin URL). Total orders + spend come from a separate
  // `count` query so we don't have to read 1k+ rows for a heavy customer.
  const [rfmRes, ordersRes, totalsRes, configsRes] = await Promise.all([
    supabase
      .from("contact_rfm_metrics")
      .select(
        "segment, recency_days, frequency_count, monetary_value, recency_score, frequency_score, monetary_score, rfm_score, last_calculated_at",
      )
      .eq("contact_id", contactId)
      .maybeSingle(),
    supabase
      .from("orders")
      .select(
        "id, external_order_id, order_number, platform, status, total_amount, currency, ordered_at, line_items",
      )
      .eq("contact_id", contactId)
      .order("ordered_at", { ascending: false })
      .limit(ORDER_FETCH_LIMIT),
    // Authoritative counts/totals over ALL orders, not just the fetched
    // window. We exclude cancelled/refunded so the "total spent" matches
    // what RFM uses.
    supabase
      .from("orders")
      .select("total_amount, ordered_at, currency, status")
      .eq("contact_id", contactId)
      .in("status", ["completed", "processing", "pending", "on-hold", "separacao", "enviado"]),
    supabase
      .from("integration_configs")
      .select("platform, store_url")
      .eq("user_id", user.id),
  ]);

  if (ordersRes.error) {
    return NextResponse.json(
      { error: ordersRes.error.message },
      { status: 500 },
    );
  }

  const orders = (ordersRes.data ?? []) as OrderRow[];
  const allActiveOrders = (totalsRes.data ?? []) as Array<{
    total_amount: number | string;
    ordered_at: string;
    currency: string;
    status: string;
  }>;
  const configs = (configsRes.data ?? []) as IntegrationConfigRow[];

  const storeUrlByPlatform = new Map<CommercePlatform, string | null>(
    configs.map((c) => [c.platform, c.store_url]),
  );

  // Aggregate stats: count + spent + last_order date. Computed from the
  // full active-order list so they're correct even when more than
  // ORDER_FETCH_LIMIT exist.
  let totalSpent = 0;
  let orderCount = 0;
  let lastOrderedAt: string | null = null;
  let dominantCurrency = "BRL";
  for (const o of allActiveOrders) {
    const amt =
      typeof o.total_amount === "number"
        ? o.total_amount
        : parseFloat(o.total_amount) || 0;
    totalSpent += amt;
    orderCount += 1;
    if (!lastOrderedAt || o.ordered_at > lastOrderedAt) {
      lastOrderedAt = o.ordered_at;
      dominantCurrency = o.currency || dominantCurrency;
    }
  }
  const daysSinceLast =
    lastOrderedAt != null
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - new Date(lastOrderedAt).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        )
      : null;

  // Last order: first row of the recent window (already sorted desc).
  const lastOrder = orders[0] ?? null;
  const lastOrderAdminUrl = lastOrder
    ? buildOrderAdminUrl(
        lastOrder.platform,
        storeUrlByPlatform.get(lastOrder.platform) ?? null,
        lastOrder.external_order_id,
      )
    : null;

  const productsPurchased = aggregateProducts(
    orders.map((o) => o.line_items ?? []),
    5,
  );

  return NextResponse.json({
    rfm: rfmRes.data ?? null,
    stats: {
      order_count: orderCount,
      total_spent: totalSpent,
      currency: dominantCurrency,
      last_ordered_at: lastOrderedAt,
      days_since_last: daysSinceLast,
    },
    last_order: lastOrder
      ? {
          id: lastOrder.id,
          external_order_id: lastOrder.external_order_id,
          number: lastOrder.order_number ?? lastOrder.external_order_id,
          platform: lastOrder.platform,
          status: lastOrder.status,
          total:
            typeof lastOrder.total_amount === "number"
              ? lastOrder.total_amount
              : parseFloat(String(lastOrder.total_amount)) || 0,
          currency: lastOrder.currency,
          ordered_at: lastOrder.ordered_at,
          items: lastOrder.line_items ?? [],
          admin_url: lastOrderAdminUrl,
        }
      : null,
    products_purchased: productsPurchased,
  });
}
