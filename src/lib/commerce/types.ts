// Shared types for the e-commerce sidebar / aggregation layer.
// Kept platform-agnostic so adding Shopify/Nuvemshop later only requires
// new normalizers + a new branch in `buildOrderAdminUrl`.

export type CommercePlatform = "woocommerce" | "shopify" | "nuvemshop";

export interface NormalizedLineItem {
  name: string;
  quantity: number;
  total: number | null;
  product_id: string | null;
}
