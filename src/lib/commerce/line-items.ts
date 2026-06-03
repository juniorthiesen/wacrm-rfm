import type { CommercePlatform, NormalizedLineItem } from "./types";

interface UnknownItem {
  [key: string]: unknown;
}

function toNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStringOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = typeof v === "string" ? v : String(v);
  return s.trim() ? s : null;
}

/**
 * Coerce a raw line-item array from any supported platform into the
 * normalized shape we persist on `orders.line_items`.
 *
 * Each platform stores the same data under different keys:
 *
 *   WooCommerce  → { name, quantity, total, product_id }
 *   Shopify      → { title, quantity, price, product_id }
 *   Nuvemshop    → { name, quantity, price, product_id }
 *
 * Returning a single shape lets the inbox sidebar and the future Shopify /
 * Nuvemshop webhooks share one rendering path.
 */
export function normalizeLineItems(
  raw: unknown,
  platform: CommercePlatform,
): NormalizedLineItem[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((it): it is UnknownItem => it != null && typeof it === "object")
    .map((it) => {
      const quantity = toNumber(it.quantity) || 1;

      let name: string;
      let total: number;
      switch (platform) {
        case "woocommerce":
          name = toStringOrNull(it.name) ?? "Item";
          total = toNumber(it.total);
          break;
        case "shopify":
          name = toStringOrNull(it.title) ?? toStringOrNull(it.name) ?? "Item";
          // Shopify gives unit price; total = price * qty.
          total = toNumber(it.price) * quantity;
          break;
        case "nuvemshop":
          name = toStringOrNull(it.name) ?? "Item";
          total = toNumber(it.price) * quantity;
          break;
      }

      return {
        name,
        quantity,
        total: Number.isFinite(total) ? total : null,
        product_id: toStringOrNull(it.product_id),
      };
    });
}

/**
 * Aggregate line items across multiple orders, deduplicated by name, sorted
 * by total quantity. Used by the contact sidebar's "products purchased"
 * widget.
 */
export function aggregateProducts(
  ordersLineItems: NormalizedLineItem[][],
  limit = 5,
): Array<{ name: string; quantity: number; total: number }> {
  const map = new Map<string, { name: string; quantity: number; total: number }>();
  for (const items of ordersLineItems) {
    for (const item of items) {
      const key = item.name.toLowerCase();
      const existing = map.get(key);
      const totalAdd = item.total ?? 0;
      if (existing) {
        existing.quantity += item.quantity;
        existing.total += totalAdd;
      } else {
        map.set(key, {
          name: item.name,
          quantity: item.quantity,
          total: totalAdd,
        });
      }
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, limit);
}
