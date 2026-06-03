import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/integrations/phone-normalization";
import { normalizeLineItems } from "./line-items";
import type { CommercePlatform } from "./types";

// Shared shape of a normalized order across platforms — both the webhook
// and the REST-API sync call this with their own payloads pre-normalized.
// Keeping the contract small avoids a flood of platform-specific fields
// leaking into the ingestion path; richer data lives on `line_items`.
export interface NormalizedOrder {
  external_order_id: string;
  order_number: string;
  status: string;
  total_amount: number;
  currency: string;
  ordered_at: string;
  customer: {
    first_name: string | null;
    last_name: string | null;
    phone_raw: string | null; // pre-normalization
    email: string | null;
  };
  line_items_raw: unknown; // passed through normalizeLineItems
  platform: CommercePlatform;
}

export interface UpsertOrderResult {
  contactId: string | null;
  previousStatus: string | null;
  currentStatus: string;
  statusChanged: boolean;
}

const PLATFORM_TAG_COLORS: Record<CommercePlatform, string> = {
  woocommerce: "#96588a",
  shopify: "#95bf47",
  nuvemshop: "#0070cc",
};

const PLATFORM_TAG_NAMES: Record<CommercePlatform, string> = {
  woocommerce: "WooCommerce",
  shopify: "Shopify",
  nuvemshop: "Nuvemshop",
};

/**
 * Find an existing contact by phone, falling back to email. Returns null
 * if neither matches — caller decides whether to create one.
 */
export async function findContactByPhoneOrEmail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  userId: string,
  normalizedPhone: string | null,
  email: string | null,
): Promise<{ id: string } | null> {
  if (normalizedPhone) {
    const { data } = await db
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .eq("phone", normalizedPhone)
      .maybeSingle();
    if (data) return data as { id: string };
  }
  if (email) {
    const { data } = await db
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .eq("email", email)
      .limit(1);
    if (data && data.length > 0) return data[0] as { id: string };
  }
  return null;
}

/**
 * Assign the platform tag (e.g. "WooCommerce") to a contact, creating the
 * tag if missing. Idempotent — safe to call on already-tagged contacts;
 * the duplicate insert will fail silently on the contact_tags UNIQUE
 * constraint.
 */
export async function assignPlatformTag(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  userId: string,
  contactId: string,
  platform: CommercePlatform,
): Promise<void> {
  const name = PLATFORM_TAG_NAMES[platform];
  const color = PLATFORM_TAG_COLORS[platform];

  const { data: existingTag } = await db
    .from("tags")
    .select("id")
    .eq("user_id", userId)
    .eq("name", name)
    .maybeSingle();

  let tagId: string | null = existingTag?.id ?? null;
  if (!tagId) {
    const { data: newTag } = await db
      .from("tags")
      .insert({ user_id: userId, name, color })
      .select("id")
      .single();
    tagId = newTag?.id ?? null;
  }

  if (tagId) {
    await db
      .from("contact_tags")
      .insert({ contact_id: contactId, tag_id: tagId })
      // Suppress unique violation — already-tagged contacts shouldn't
      // surface as an error.
      .select()
      .maybeSingle();
  }
}

/**
 * Find-or-create a contact from a billing/customer object, then upsert
 * the order row. Used by both the webhook and the REST-API sync — they
 * differ only in how they obtain the NormalizedOrder.
 *
 * Returns enough to drive automation dispatch downstream (the webhook
 * needs `statusChanged` to avoid spamming the customer on every WC edit).
 */
export async function ingestOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  userId: string,
  order: NormalizedOrder,
): Promise<UpsertOrderResult> {
  const normalizedPhone = normalizePhone(order.customer.phone_raw);
  const email = order.customer.email?.trim() || null;

  let contact = await findContactByPhoneOrEmail(db, userId, normalizedPhone, email);

  if (!contact && (normalizedPhone || email)) {
    const fullName =
      `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim() ||
      `${PLATFORM_TAG_NAMES[order.platform]} Customer`;

    // contacts.phone is NOT NULL; generate a deterministic placeholder
    // when only an email is available so future syncs find the same row.
    const phoneValue =
      normalizedPhone ||
      `${order.platform.slice(0, 4)}_${
        email?.replace(/[^a-zA-Z0-9]/g, "") || Math.floor(Math.random() * 1_000_000)
      }`;

    const { data, error: insertError } = await db
      .from("contacts")
      .insert({
        user_id: userId,
        phone: phoneValue,
        name: fullName,
        email,
      })
      .select("id")
      .single();

    if (!insertError && data) {
      contact = data as { id: string };
      await assignPlatformTag(db, userId, contact.id, order.platform);
    } else if (insertError) {
      // Race with another concurrent ingest: phone constraint hit. Look
      // the contact up again — the other writer just created it.
      const retry = await findContactByPhoneOrEmail(
        db,
        userId,
        normalizedPhone,
        email,
      );
      if (retry) contact = retry;
      else console.error("[order-ingestion] Failed to create contact:", insertError);
    }
  }

  // Status-transition detection: lets the webhook decide whether to fire
  // automations. Sync doesn't care, but reads it for free.
  const { data: previousOrder } = await db
    .from("orders")
    .select("status")
    .eq("user_id", userId)
    .eq("platform", order.platform)
    .eq("external_order_id", order.external_order_id)
    .maybeSingle();
  const previousStatus = (previousOrder?.status as string | undefined) ?? null;
  const statusChanged = previousStatus !== order.status;

  const lineItems = normalizeLineItems(order.line_items_raw, order.platform);

  const { error: orderError } = await db.from("orders").upsert(
    {
      user_id: userId,
      contact_id: contact?.id ?? null,
      external_order_id: order.external_order_id,
      order_number: order.order_number,
      platform: order.platform,
      status: order.status,
      total_amount: order.total_amount,
      currency: order.currency,
      customer_email: email,
      customer_phone: normalizedPhone,
      ordered_at: order.ordered_at,
      line_items: lineItems,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,platform,external_order_id" },
  );

  if (orderError) {
    console.error("[order-ingestion] Failed to upsert order:", orderError);
    throw new Error(orderError.message);
  }

  return {
    contactId: contact?.id ?? null,
    previousStatus,
    currentStatus: order.status,
    statusChanged,
  };
}
