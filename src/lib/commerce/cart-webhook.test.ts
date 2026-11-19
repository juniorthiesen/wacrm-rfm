import { describe, expect, it, vi } from "vitest";

// cart-webhook imports the automation engine (Supabase client at module load).
vi.mock("@/lib/automations/engine", () => ({ runAutomationsForTrigger: vi.fn() }));

import { isCartPayload } from "./cart-webhook";

const cart = { id: 1, email: "a@a.co", cart_status: "abandoned", cart_contents: [], cart_url: "https://dly.com.br/?x=1" };

describe("isCartPayload", () => {
  it("recognises the plugin's array batch, { carts } and a single cart", () => {
    expect(isCartPayload([cart, cart])).toBe(true);
    expect(isCartPayload({ carts: [cart] })).toBe(true);
    expect(isCartPayload(cart)).toBe(true);
  });

  it("does not take a WooCommerce order for a cart", () => {
    const order = {
      id: 123,
      number: "123",
      status: "processing",
      total: "99.90",
      billing: { email: "a@a.co" },
      line_items: [],
      meta_data: [],
      cart_hash: "abc",
    };
    expect(isCartPayload(order)).toBe(false);
  });

  it("does not take the magic-login payload for a cart", () => {
    expect(isCartPayload({ url: "https://dly.com.br/?magic_login=1&uid=2", user: { email: "a@a.co" } })).toBe(false);
  });

  it("rejects empty, mixed and non-object bodies", () => {
    expect(isCartPayload([])).toBe(false);
    expect(isCartPayload({ carts: [] })).toBe(false);
    expect(isCartPayload([cart, { id: 5, status: "processing" }])).toBe(false);
    expect(isCartPayload(null)).toBe(false);
    expect(isCartPayload("cart_status")).toBe(false);
    expect(isCartPayload(42)).toBe(false);
  });
});
