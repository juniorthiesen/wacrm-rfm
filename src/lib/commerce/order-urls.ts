import type { CommercePlatform } from "./types";

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Build the merchant-facing admin URL for an order. `storeUrl` comes from
 * `integration_configs.store_url` and `externalOrderId` is the platform's
 * native id (number for WC/Shopify, string for some Nuvemshop instances).
 *
 * Returns `null` when we don't have enough data — callers should hide the
 * link rather than render a broken anchor.
 */
export function buildOrderAdminUrl(
  platform: CommercePlatform,
  storeUrl: string | null,
  externalOrderId: string,
): string | null {
  if (!storeUrl || !externalOrderId) return null;
  const base = stripTrailingSlash(storeUrl);

  switch (platform) {
    case "woocommerce":
      // wp-admin order edit screen.
      return `${base}/wp-admin/post.php?post=${encodeURIComponent(externalOrderId)}&action=edit`;
    case "shopify":
      // store_url is the myshopify domain (e.g. https://acme.myshopify.com).
      return `${base}/admin/orders/${encodeURIComponent(externalOrderId)}`;
    case "nuvemshop":
      // Nuvemshop admin lives on the central tiendanube/nuvemshop hostname,
      // not the storefront domain. We still link from the storefront URL —
      // operators click through to the Nuvemshop admin from there.
      return `${base}/admin/v2/orders/${encodeURIComponent(externalOrderId)}`;
  }
}
