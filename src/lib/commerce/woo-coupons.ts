import type { CouponSpec, CreatedCoupon } from "./connector";

/**
 * Creates a per-customer coupon in WooCommerce through the REST API v3
 * (POST /wp-json/wc/v3/coupons). Restrictions are enforced BY WOOCOMMERCE, so
 * they hold even if the code leaks: single use, single use per customer,
 * individual use (does not stack with other coupons), tied to one e-mail,
 * expiry date and optional minimum cart.
 *
 * (The legacy VOLTEI20 had no expiry, no minimum and no per-person limit.)
 */

interface WooCfg {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

const MAX_CODE_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function isDuplicateCode(status: number, body: { code?: string }): boolean {
  return status === 400 && body.code === "woocommerce_rest_coupon_code_already_exists";
}

export async function createWooCoupon(
  cfg: WooCfg,
  spec: CouponSpec,
  makeCode: (prefix: string) => string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<CreatedCoupon> {
  const url = `${cfg.storeUrl.replace(/\/+$/, "")}/wp-json/wc/v3/coupons`;
  const authorization = `Basic ${Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString("base64")}`;

  // Woo wants "YYYY-MM-DDTHH:mm:ss" (no milliseconds, no Z) in the *_gmt field.
  const expires = new Date(now.getTime() + spec.validDays * DAY_MS);
  const expiresGmt = expires.toISOString().replace(/\.\d{3}Z$/, "");

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    const code = makeCode(spec.codePrefix);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        code,
        discount_type: spec.discountType,
        amount: String(spec.amount),
        individual_use: true,
        usage_limit: 1,
        usage_limit_per_user: 1,
        email_restrictions: [spec.email.trim().toLowerCase()],
        date_expires_gmt: expiresGmt,
        ...(spec.minimumAmount && spec.minimumAmount > 0 ? { minimum_amount: String(spec.minimumAmount) } : {}),
        ...(spec.description ? { description: spec.description } : {}),
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      id?: number | string;
      code?: string;
      message?: string;
    };

    if (res.ok && body.id !== undefined) {
      return { code: (body.code ?? code).toUpperCase(), externalId: String(body.id), expiresAt: `${expiresGmt}Z` };
    }
    lastError = `${res.status} ${body.message ?? res.statusText}`;
    if (!isDuplicateCode(res.status, body)) break; // only a code collision is worth another random code
  }
  throw new Error(`WooCommerce coupon creation failed: ${lastError}`);
}
