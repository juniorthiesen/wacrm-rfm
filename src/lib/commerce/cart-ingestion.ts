import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutomationContext } from "@/lib/automations/engine";
import { findContactByPhoneOrEmail } from "./order-ingestion";
import { buildCartItemsList, formatBRL, urlSuffix, type NormalizedCart } from "./carts";

/**
 * Turns the plugin's abandoned-cart events into automation runs.
 *
 * Rules (see docs/handoff-email-channel.md, seção 16):
 *  - the same plugin cart never starts the sequence twice (the plugin retries a
 *    batch when we answer non-2xx, so every step here is idempotent);
 *  - one sequence per person at a time: a new cart from the same e-mail inside
 *    SEQUENCE_PROTECTION_DAYS is recorded but does not start another one;
 *  - the row is saved BEFORE dispatching, so a crash never causes a second run;
 *  - recovered / converted / dismissed only update the record (the automation
 *    itself stops through its "purchased since" condition).
 */

/** The cart sequence lasts about 3 days (1 h, 24 h, 72 h): protect a bit more. */
export const SEQUENCE_PROTECTION_DAYS = 4;

export interface StoredCart {
  status: string;
  sequence_started_at: string | null;
  contact_id: string | null;
}

export interface CartSavePatch {
  contactId?: string | null;
  /** undefined = leave as is. */
  sequenceStartedAt?: string | null;
  skipReason?: string | null;
}

export interface CartStore {
  getCart(userId: string, externalId: string): Promise<StoredCart | null>;
  /** Any OTHER cart of this e-mail whose sequence started at/after `sinceIso`. */
  hasRecentSequence(userId: string, email: string, sinceIso: string, excludeExternalId: string): Promise<boolean>;
  findOrCreateContact(userId: string, cart: NormalizedCart): Promise<string | null>;
  saveCart(userId: string, cart: NormalizedCart, patch: CartSavePatch, nowIso: string): Promise<void>;
}

export interface CartDispatch {
  (input: { userId: string; contactId: string | null; context: AutomationContext }): Promise<void>;
}

export interface CartIngestionSummary {
  started: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Count per skip reason, e.g. { already_started: 1, recent_sequence: 2 }. */
  reasons: Record<string, number>;
}

export function buildCartContext(cart: NormalizedCart, now: Date): AutomationContext {
  const fullName = `${cart.firstName} ${cart.lastName}`.trim() || cart.email || "Cliente";
  const recoveryUrl = cart.cartUrl ?? "";
  return {
    cart: {
      // Same keys the Funnelkit handler fills, so WhatsApp templates keep working.
      // `checkout_url` is the recovery link (it carries the token that restores the cart).
      checkout_url: recoveryUrl,
      checkout_url_suffix: urlSuffix(cart.cartUrl),
      coupon_code: "",
      total: formatBRL(cart.total),
      product_names: cart.items.map((i) => i.name).join(", "),
      // New keys for e-mail.
      recovery_url: recoveryUrl,
      items_list: buildCartItemsList(cart.items),
      items_count: cart.items.reduce((n, i) => n + i.quantity, 0),
      total_value: cart.total,
    },
    customer: {
      name: fullName,
      first_name: cart.firstName,
      last_name: cart.lastName,
      phone: cart.phone ?? undefined,
      email: cart.email ?? undefined,
    },
    // `purchased_since_enrollment` reads this: the sequence ends when a paid order shows up.
    vars: { enrolled_at: now.toISOString(), cart_external_id: cart.externalId },
  };
}

export async function processCartEvents(
  deps: { store: CartStore; dispatch: CartDispatch; now?: () => Date },
  userId: string,
  carts: NormalizedCart[],
): Promise<CartIngestionSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const summary: CartIngestionSummary = { started: 0, updated: 0, skipped: 0, failed: 0, reasons: {} };
  const skip = (reason: string) => {
    summary.skipped++;
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
  };

  for (const cart of carts) {
    try {
      const existing = await deps.store.getCart(userId, cart.externalId);

      // Recovered / converted / dismissed: bookkeeping only.
      if (cart.status !== "abandoned") {
        await deps.store.saveCart(userId, cart, {}, nowIso);
        summary.updated++;
        continue;
      }

      // The plugin re-sent a cart we already started (retry of a failed batch).
      if (existing?.sequence_started_at) {
        await deps.store.saveCart(userId, cart, {}, nowIso);
        skip("already_started");
        continue;
      }

      // One sequence per person at a time.
      if (cart.email) {
        const since = new Date(now.getTime() - SEQUENCE_PROTECTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
        if (await deps.store.hasRecentSequence(userId, cart.email, since, cart.externalId)) {
          await deps.store.saveCart(userId, cart, { skipReason: "recent_sequence" }, nowIso);
          skip("recent_sequence");
          continue;
        }
      }

      const contactId = await deps.store.findOrCreateContact(userId, cart);
      // Save first: a crash after this point can never start the sequence twice.
      await deps.store.saveCart(userId, cart, { contactId, sequenceStartedAt: nowIso, skipReason: null }, nowIso);
      await deps.dispatch({ userId, contactId, context: buildCartContext(cart, now) });
      summary.started++;
    } catch (err) {
      summary.failed++;
      console.error("[cart-ingestion] cart failed:", cart.externalId, err);
    }
  }
  return summary;
}

// ------------------------------------------------------------
// Supabase implementation
// ------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function supabaseCartStore(db: SupabaseClient<any>): CartStore {
  return {
    async getCart(userId, externalId) {
      const { data, error } = await db
        .from("abandoned_carts")
        .select("status, sequence_started_at, contact_id")
        .eq("user_id", userId)
        .eq("external_id", externalId)
        .maybeSingle();
      if (error) throw new Error(`abandoned_carts read failed: ${error.message}`);
      return (data as StoredCart | null) ?? null;
    },

    async hasRecentSequence(userId, email, sinceIso, excludeExternalId) {
      const { count, error } = await db
        .from("abandoned_carts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("email", email)
        .neq("external_id", excludeExternalId)
        .gte("sequence_started_at", sinceIso);
      if (error) throw new Error(`abandoned_carts lookup failed: ${error.message}`);
      return (count ?? 0) > 0;
    },

    async findOrCreateContact(userId, cart) {
      const existing = await findContactByPhoneOrEmail(db, userId, cart.phone, cart.email);
      if (existing) return existing.id;

      const name = `${cart.firstName} ${cart.lastName}`.trim() || cart.email || "Cliente";
      const { data, error } = await db
        .from("contacts")
        .insert({ user_id: userId, phone: cart.phone, email: cart.email, name })
        .select("id")
        .single();
      if (error) throw new Error(`contact create failed: ${error.message}`);
      return (data?.id as string | undefined) ?? null;
    },

    async saveCart(userId, cart, patch, nowIso) {
      const row: Record<string, unknown> = {
        user_id: userId,
        external_id: cart.externalId,
        email: cart.email,
        phone: cart.phone,
        status: cart.status,
        cart_url: cart.cartUrl,
        items: cart.items,
        total: cart.total,
        currency: cart.currency,
        reached_checkout: cart.reachedCheckout,
        last_event_at: nowIso,
      };
      // Only touch these when the caller decided something; never null out a known contact.
      if (patch.contactId) row.contact_id = patch.contactId;
      if (patch.sequenceStartedAt !== undefined) row.sequence_started_at = patch.sequenceStartedAt;
      if (patch.skipReason !== undefined) row.skip_reason = patch.skipReason;

      const { error } = await db.from("abandoned_carts").upsert(row, { onConflict: "user_id,external_id" });
      if (error) throw new Error(`abandoned_carts save failed: ${error.message}`);
    },
  };
}
