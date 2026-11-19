import type { SupabaseClient } from "@supabase/supabase-js";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { parseCartPayload } from "./carts";
import { processCartEvents, supabaseCartStore } from "./cart-ingestion";

/**
 * Shared by the two URLs that can receive the checkout plugin's abandoned-cart
 * webhook, so the operator can paste either one in the plugin:
 *   - POST /api/integrations/woocommerce/carts    (dedicated)
 *   - POST /api/integrations/woocommerce/webhook  (the generic Woo URL, which
 *     recognises the cart batch by its shape, like it does for magic-login)
 * Authentication happens in the routes; this only handles an already-trusted body.
 */

/** True for the plugin's cart batch: an array of carts, `{ carts: [...] }` or a single cart. */
export function isCartPayload(body: unknown): boolean {
  const looksLikeCart = (v: unknown): boolean =>
    !!v && typeof v === "object" && ("cart_contents" in v || "cart_status" in v || "cart_url" in v);

  if (Array.isArray(body)) return body.length > 0 && body.every(looksLikeCart);
  if (body && typeof body === "object") {
    const carts = (body as { carts?: unknown }).carts;
    if (Array.isArray(carts)) return carts.length > 0 && carts.every(looksLikeCart);
    return looksLikeCart(body);
  }
  return false;
}

export async function ingestCartWebhook(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  userId: string,
  storeUrl: string | null | undefined,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Recovery links must point at the configured store, never anywhere else.
  const { carts, rejected } = parseCartPayload(body, storeUrl);

  const summary = await processCartEvents(
    {
      store: supabaseCartStore(db),
      dispatch: ({ userId: uid, contactId, context }) =>
        runAutomationsForTrigger({ userId: uid, triggerType: "cart_abandoned", contactId, context }),
    },
    userId,
    carts,
  );

  // Non-2xx makes the plugin resend the whole batch; safe because processing is idempotent.
  return {
    status: summary.failed === 0 ? 200 : 500,
    body: { success: summary.failed === 0, event: "carts", received: carts.length, rejected, ...summary },
  };
}
