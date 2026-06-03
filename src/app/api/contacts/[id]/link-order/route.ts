import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizePhone } from "@/lib/integrations/phone-normalization";
import { recalculateUserRFM } from "@/lib/rfm/engine";

// Endpoint for manually associating e-commerce orders with a CRM contact
// when the webhook's automatic phone/email match couldn't make the link
// (e.g. customer used a different phone format, or the contact was created
// in WACRM after the order arrived).
//
// GET   — returns orphan orders (`contact_id IS NULL`) that look like
//         candidates for this contact, ranked by match quality:
//           1. Same normalized phone
//           2. Same email
//           3. Any orphan order (so operators can manually pick anything)
//
// POST  — body: { order_ids: string[] }. Links the listed orders to this
//         contact, then re-runs RFM in the background. Returns the updated
//         count.

const MAX_SUGGESTIONS = 50;

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

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, phone, email")
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

  // Build the OR filter. We always include orphans-without-match so the
  // operator can manually pick something even if neither phone nor email
  // are populated on the contact.
  const phone = normalizePhone(contact.phone);
  const email = contact.email?.trim() || null;

  // Pull a window of orphan orders sorted by date. RLS scopes this to
  // the caller's user_id.
  const query = supabase
    .from("orders")
    .select(
      "id, external_order_id, order_number, platform, status, total_amount, currency, customer_phone, customer_email, ordered_at",
    )
    .is("contact_id", null)
    .order("ordered_at", { ascending: false })
    .limit(MAX_SUGGESTIONS);

  const { data: orphans, error: orphansError } = await query;
  if (orphansError) {
    return NextResponse.json(
      { error: orphansError.message },
      { status: 500 },
    );
  }

  // Rank in JS rather than DB so the heuristic stays close to the webhook
  // matching logic (phone first, then email, then everything else).
  const ranked = (orphans ?? [])
    .map((o) => {
      let score = 0;
      let matchedOn: "phone" | "email" | null = null;
      if (phone && o.customer_phone && normalizePhone(o.customer_phone) === phone) {
        score = 3;
        matchedOn = "phone";
      } else if (email && o.customer_email && o.customer_email.toLowerCase() === email.toLowerCase()) {
        score = 2;
        matchedOn = "email";
      } else {
        score = 1;
      }
      return { ...o, _score: score, matched_on: matchedOn };
    })
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return a.ordered_at < b.ordered_at ? 1 : -1;
    })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ _score, ...rest }) => rest);

  return NextResponse.json({ suggestions: ranked });
}

export async function POST(
  request: Request,
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

  const body = await request.json().catch(() => null);
  const orderIds: unknown = body?.order_ids;
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return NextResponse.json(
      { error: "order_ids must be a non-empty array" },
      { status: 400 },
    );
  }
  const ids = orderIds
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .slice(0, 200);
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "order_ids contains no valid ids" },
      { status: 400 },
    );
  }

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

  // RLS keeps this scoped to the caller's orders. We don't restrict to
  // `contact_id IS NULL` here so operators can also *reassign* orders
  // that were attached to the wrong contact by an earlier match.
  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({ contact_id: contactId })
    .in("id", ids)
    .select("id");
  if (updateError) {
    return NextResponse.json(
      { error: updateError.message },
      { status: 500 },
    );
  }

  // Recalculate RFM for the tenant. Fire-and-forget would be lost in a
  // serverless environment, so we await — the call is O(orders) and runs
  // in well under a second for typical tenants.
  await recalculateUserRFM(supabase, user.id);

  return NextResponse.json({
    success: true,
    linked_count: updated?.length ?? 0,
  });
}
