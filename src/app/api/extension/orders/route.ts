import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { buildOrderAdminUrl } from "@/lib/commerce/order-urls";
import type { CommercePlatform, NormalizedLineItem } from "@/lib/commerce/types";

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

export async function GET(request: NextRequest) {
  const apiKey = request.headers.get("x-api-key") || request.nextUrl.searchParams.get("api_key");
  const expectedKey = process.env.EXTENSION_API_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey || (expectedKey && apiKey !== expectedKey)) {
    return NextResponse.json(
      { error: "Unauthorized: Invalid or missing x-api-key" },
      { status: 401 }
    );
  }

  if (request.nextUrl.searchParams.get("test") === "true") {
    return NextResponse.json({
      status: "ok",
      message: "WACRM Extension API connected successfully",
      timestamp: new Date().toISOString(),
    });
  }

  const rawPhone = request.nextUrl.searchParams.get("phone");
  if (!rawPhone) {
    return NextResponse.json(
      { error: "Missing required parameter: phone" },
      { status: 400 }
    );
  }

  const cleanPhone = rawPhone.replace(/\D/g, "");
  const last8 = cleanPhone.slice(-8);

  if (last8.length < 8) {
    return NextResponse.json(
      { error: "Phone number too short" },
      { status: 400 }
    );
  }

  const supabase = supabaseAdmin();

  // Find contact by matching last 8 digits
  const { data: contacts, error: contactError } = await supabase
    .from("contacts")
    .select("id, name, phone, email, avatar_url, user_id")
    .filter("phone", "not.is", null)
    .order("created_at", { ascending: false });

  if (contactError) {
    return NextResponse.json({ error: contactError.message }, { status: 500 });
  }

  const matchedContact = (contacts || []).find((c) => {
    const cClean = (c.phone || "").replace(/\D/g, "");
    return cClean.slice(-8) === last8;
  });

  const contactId = matchedContact?.id || null;
  const userId = matchedContact?.user_id || null;

  let ordersQuery = supabase
    .from("orders")
    .select("id, external_order_id, order_number, platform, status, total_amount, currency, ordered_at, line_items, user_id")
    .order("ordered_at", { ascending: false })
    .limit(20);

  if (contactId) {
    ordersQuery = ordersQuery.eq("contact_id", contactId);
  } else {
    ordersQuery = ordersQuery.ilike("customer_phone", `%${last8}%`);
  }

  const { data: ordersData, error: ordersError } = await ordersQuery;

  if (ordersError) {
    return NextResponse.json({ error: ordersError.message }, { status: 500 });
  }

  const orders = (ordersData ?? []) as (OrderRow & { user_id?: string })[];

  let rfm = null;
  if (contactId) {
    const { data: rfmData } = await supabase
      .from("contact_rfm_metrics")
      .select("segment, recency_days, frequency_count, monetary_value, rfm_score")
      .eq("contact_id", contactId)
      .maybeSingle();
    rfm = rfmData || null;
  }

  const activeUserId = userId || orders[0]?.user_id;
  let configs: Array<{ platform: CommercePlatform; store_url: string | null }> = [];
  if (activeUserId) {
    const { data: configsData } = await supabase
      .from("integration_configs")
      .select("platform, store_url")
      .eq("user_id", activeUserId);
    configs = (configsData || []) as any;
  }

  const storeUrlByPlatform = new Map<CommercePlatform, string | null>(
    configs.map((c) => [c.platform, c.store_url])
  );

  let totalSpent = 0;
  for (const o of orders) {
    const val = typeof o.total_amount === "number" ? o.total_amount : parseFloat(String(o.total_amount)) || 0;
    totalSpent += val;
  }

  const formattedOrders = orders.map((o) => {
    const storeUrl = storeUrlByPlatform.get(o.platform) ?? null;
    const adminUrl = buildOrderAdminUrl(o.platform, storeUrl, o.external_order_id);
    const total = typeof o.total_amount === "number" ? o.total_amount : parseFloat(String(o.total_amount)) || 0;

    return {
      id: o.id,
      external_order_id: o.external_order_id,
      order_number: o.order_number || o.external_order_id,
      platform: o.platform,
      status: o.status,
      total_amount: total,
      currency: o.currency || "BRL",
      ordered_at: o.ordered_at,
      admin_url: adminUrl,
      line_items: (o.line_items || []).map((item) => ({
        name: item.name,
        quantity: item.quantity,
        total: item.total,
      })),
    };
  });

  return NextResponse.json({
    found: !!matchedContact || formattedOrders.length > 0,
    contact: matchedContact
      ? {
          id: matchedContact.id,
          name: matchedContact.name,
          phone: matchedContact.phone,
          email: matchedContact.email,
          avatar_url: matchedContact.avatar_url,
        }
      : null,
    rfm,
    stats: {
      order_count: formattedOrders.length,
      total_spent: totalSpent,
      currency: formattedOrders[0]?.currency || "BRL",
      last_ordered_at: formattedOrders[0]?.ordered_at || null,
    },
    orders: formattedOrders,
  });
}
