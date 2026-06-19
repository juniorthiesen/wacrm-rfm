import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchOrdersPage,
  fetchCustomersPage,
  type WooClientConfig,
  type WooOrder,
  type WooCustomer,
} from "../woocommerce-client";
import {
  ingestOrder,
  findContactByPhoneOrEmail,
  assignPlatformTag,
  type NormalizedOrder,
} from "../order-ingestion";
import { extractBirthdayRaw, parseBirthday } from "../birthday";
import { normalizePhone } from "@/lib/integrations/phone-normalization";

// Per-page size. WC docs say the max is 100; we use 50 so a single page
// roundtrip stays comfortably under typical Vercel timeouts even when
// downstream Supabase writes are slow.
const PAGE_SIZE = 50;

export type SyncPhase = "orders" | "customers";

export interface SyncState {
  status: "idle" | "running" | "error" | "completed";
  phase: SyncPhase;
  started_at: string | null;
  completed_at: string | null;
  orders: {
    current_page: number;
    total_pages: number | null;
    synced_count: number;
  };
  customers: {
    current_page: number;
    total_pages: number | null;
    synced_count: number;
  };
  error: string | null;
}

export function emptySyncState(): SyncState {
  return {
    status: "idle",
    phase: "orders",
    started_at: null,
    completed_at: null,
    orders: { current_page: 0, total_pages: null, synced_count: 0 },
    customers: { current_page: 0, total_pages: null, synced_count: 0 },
    error: null,
  };
}

export function freshlyStartedSyncState(): SyncState {
  return {
    ...emptySyncState(),
    status: "running",
    phase: "orders",
    started_at: new Date().toISOString(),
  };
}

/**
 * Map a raw WooCommerce order from the REST API into the shape
 * `ingestOrder` expects. Field names match the webhook payload because
 * Woo uses the same JSON schema on both ingress paths.
 */
function wcOrderToNormalized(o: WooOrder): NormalizedOrder | null {
  if (!o.id) return null;
  return {
    external_order_id: o.id.toString(),
    order_number: o.number?.toString() || o.id.toString(),
    status: o.status || "pending",
    total_amount: parseFloat(o.total || "0") || 0,
    currency: o.currency || "BRL",
    ordered_at: o.date_created_gmt
      ? new Date(o.date_created_gmt + "Z").toISOString()
      : new Date().toISOString(),
    customer: {
      first_name: o.billing?.first_name || o.shipping?.first_name || null,
      last_name: o.billing?.last_name || o.shipping?.last_name || null,
      phone_raw: o.billing?.phone || o.shipping?.phone || null,
      email: o.billing?.email || null,
      birthday: extractBirthdayRaw(o.billing, o.meta_data),
    },
    line_items_raw: o.line_items,
    platform: "woocommerce",
  };
}

/**
 * Sync one page of orders. Returns the updated counter slice and whether
 * the orders phase is done. The caller is responsible for persisting the
 * resulting `SyncState` to `integration_configs.sync_state`.
 */
export async function syncOrdersPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  userId: string,
  cfg: WooClientConfig,
  page: number,
): Promise<{ syncedThisPage: number; totalPages: number }> {
  const result = await fetchOrdersPage(cfg, page, PAGE_SIZE);

  for (const raw of result.items) {
    const normalized = wcOrderToNormalized(raw);
    if (!normalized) continue;
    try {
      await ingestOrder(db, userId, normalized);
    } catch (err) {
      // One bad order shouldn't poison the whole sync. Log and continue —
      // the operator can re-sync later to pick up anything we skipped.
      console.error(
        `[sync-wc] Failed to ingest order ${normalized.external_order_id}:`,
        err,
      );
    }
  }

  return {
    syncedThisPage: result.items.length,
    totalPages: result.totalPages,
  };
}

/**
 * Sync one page of customers. Creates a CRM contact for each WC customer
 * who isn't already linked (by phone or email), then assigns the
 * WooCommerce tag. This is what catches *leads* — people in the WC user
 * table who never placed an order.
 *
 * Customers who already match an existing contact get the tag too so
 * operators can filter "all WC customers" without surprises.
 */
export async function syncCustomersPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  userId: string,
  cfg: WooClientConfig,
  page: number,
): Promise<{ syncedThisPage: number; totalPages: number }> {
  const result = await fetchCustomersPage(cfg, page, PAGE_SIZE);

  for (const c of result.items) {
    await ingestCustomer(db, userId, c).catch((err) =>
      console.error(`[sync-wc] Failed to ingest customer ${c.id}:`, err),
    );
  }

  return {
    syncedThisPage: result.items.length,
    totalPages: result.totalPages,
  };
}

async function ingestCustomer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  userId: string,
  c: WooCustomer,
): Promise<void> {
  const rawPhone = c.billing?.phone || c.shipping?.phone || null;
  const normalizedPhone = normalizePhone(rawPhone);
  const email = (c.email ?? c.billing?.email ?? null) || null;
  // WhatsApp CRM: a contact with no real phone can't be messaged and
  // never enters RFM. Skip phone-less leads instead of minting a
  // `wooc_<email>` placeholder — those inflated the contact list with
  // unactionable rows whose "phone" was the email. Buyers still come in
  // through the orders phase, which always has a billing phone.
  if (!normalizedPhone) return;

  let contact = await findContactByPhoneOrEmail(
    db,
    userId,
    normalizedPhone,
    email,
  );

  if (!contact) {
    const fullName =
      `${c.first_name ?? c.billing?.first_name ?? ""} ${c.last_name ?? c.billing?.last_name ?? ""}`.trim() ||
      "WooCommerce Customer";

    const birthday = parseBirthday(
      extractBirthdayRaw(
        c.billing,
        (c as { meta_data?: unknown }).meta_data,
      ),
    );

    const { data, error } = await db
      .from("contacts")
      .insert({
        user_id: userId,
        phone: normalizedPhone,
        name: fullName,
        email,
        birthday,
      })
      .select("id")
      .single();
    if (error || !data) {
      // Likely a race with another sync or the webhook. Re-find.
      contact = await findContactByPhoneOrEmail(
        db,
        userId,
        normalizedPhone,
        email,
      );
    } else {
      contact = data as { id: string };
    }
  }

  if (contact) {
    await assignPlatformTag(db, userId, contact.id, "woocommerce");
  }
}
