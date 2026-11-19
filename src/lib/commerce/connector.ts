import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createWooCoupon } from "./woo-coupons";

/**
 * Store connector seam: what the CRM needs from the shop it is plugged into.
 * Today only WooCommerce is implemented. The Next.js site becomes a second
 * implementation once its coupons can be restricted per customer (see the
 * integration tasks in docs/handoff-email-channel.md, item 5c/5d).
 */

export interface CouponSpec {
  /** Prefix of the generated code, e.g. "VOLTA" → "VOLTA-7KQ2MX". */
  codePrefix: string;
  discountType: "fixed_cart" | "percent";
  /** R$ for fixed_cart, percent (0–100) for percent. */
  amount: number;
  /** Minimum cart value in R$ (0/undefined = none). */
  minimumAmount?: number;
  /** The coupon stops working this many days after creation. */
  validDays: number;
  /** The coupon only works for this e-mail. */
  email: string;
  description?: string;
}

export interface CreatedCoupon {
  /** Upper-cased, ready to show to the customer. */
  code: string;
  externalId: string;
  /** ISO timestamp (UTC). */
  expiresAt: string;
}

export interface StoreConnector {
  readonly platform: "woocommerce";
  createCoupon(spec: CouponSpec): Promise<CreatedCoupon>;
}

// No 0/O/1/I: codes are read aloud and typed by hand.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeCouponPrefix(prefix: string): string {
  return prefix.toUpperCase().replace(/[^A-Z0-9-]/g, "").replace(/-+$/g, "").slice(0, 24) || "CUPOM";
}

export function generateCouponCode(
  prefix: string,
  random: (size: number) => Uint8Array = randomBytes,
): string {
  const bytes = random(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += ALPHABET[bytes[i] % ALPHABET.length];
  return `${normalizeCouponPrefix(prefix)}-${suffix}`;
}

/**
 * The tenant's store connector, or null when no active, write-capable
 * integration is configured. WooCommerce credentials live in
 * integration_configs.credentials ({ consumer_key, consumer_secret }); the REST
 * key needs READ/WRITE permission to create coupons.
 */
export async function loadStoreConnector(
  db: SupabaseClient,
  userId: string,
): Promise<StoreConnector | null> {
  const { data, error } = await db
    .from("integration_configs")
    .select("store_url, credentials, status")
    .eq("user_id", userId)
    .eq("platform", "woocommerce")
    .maybeSingle();
  if (error) throw new Error(`[connector] could not load integration: ${error.message}`);
  if (!data || data.status !== "active") return null;

  const credentials = (data.credentials ?? {}) as { consumer_key?: string; consumer_secret?: string };
  if (!data.store_url || !credentials.consumer_key || !credentials.consumer_secret) return null;

  const cfg = {
    storeUrl: String(data.store_url),
    consumerKey: credentials.consumer_key,
    consumerSecret: credentials.consumer_secret,
  };
  return {
    platform: "woocommerce",
    createCoupon: (spec) => createWooCoupon(cfg, spec, generateCouponCode),
  };
}
