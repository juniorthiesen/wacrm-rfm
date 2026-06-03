import { describe, it, expect } from "vitest";
import { normalizeLineItems, aggregateProducts } from "./line-items";

describe("normalizeLineItems", () => {
  it("normalizes WooCommerce line items", () => {
    const raw = [
      { name: "Camiseta", quantity: 2, total: "59.80", product_id: 123 },
      { name: "Boné", quantity: 1, total: "29.90", product_id: 456 },
    ];
    expect(normalizeLineItems(raw, "woocommerce")).toEqual([
      { name: "Camiseta", quantity: 2, total: 59.8, product_id: "123" },
      { name: "Boné", quantity: 1, total: 29.9, product_id: "456" },
    ]);
  });

  it("derives total from unit price for Shopify", () => {
    const raw = [{ title: "Hoodie", quantity: 3, price: "20.00", product_id: 7 }];
    expect(normalizeLineItems(raw, "shopify")).toEqual([
      { name: "Hoodie", quantity: 3, total: 60, product_id: "7" },
    ]);
  });

  it("handles missing/invalid input", () => {
    expect(normalizeLineItems(null, "woocommerce")).toEqual([]);
    expect(normalizeLineItems("not an array", "woocommerce")).toEqual([]);
    expect(normalizeLineItems([null, undefined], "woocommerce")).toEqual([]);
  });

  it("defaults quantity to 1 when absent", () => {
    const raw = [{ name: "Mystery", total: "10" }];
    expect(normalizeLineItems(raw, "woocommerce")[0].quantity).toBe(1);
  });
});

describe("aggregateProducts", () => {
  it("dedupes case-insensitively and sums quantities + totals", () => {
    const a = [{ name: "Camiseta", quantity: 1, total: 30, product_id: "1" }];
    const b = [
      { name: "camiseta", quantity: 2, total: 60, product_id: "1" },
      { name: "Boné", quantity: 1, total: 25, product_id: "2" },
    ];
    expect(aggregateProducts([a, b])).toEqual([
      { name: "Camiseta", quantity: 3, total: 90 },
      { name: "Boné", quantity: 1, total: 25 },
    ]);
  });

  it("respects limit", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      name: `P${i}`,
      quantity: 10 - i,
      total: 1,
      product_id: null,
    }));
    expect(aggregateProducts([items], 3)).toHaveLength(3);
  });
});
