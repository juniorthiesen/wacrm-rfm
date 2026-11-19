import { describe, expect, it } from "vitest";
import { buildCartItemsList, formatBRL, parseCartPayload, urlSuffix } from "./carts";

const cart = (over: Record<string, unknown> = {}) => ({
  id: 41,
  email: "Maria@Gmail.com ",
  phone: "(11) 99876-5432",
  first_name: "Maria",
  last_name: "Souza",
  cart_status: "abandoned",
  cart_url: "https://dly.com.br/?rishi_recover=abc123",
  cart_total: 129.9,
  currency: "BRL",
  reached_checkout: true,
  cart_contents: [
    { name: "Calcinha Fio", price: 39.9, quantity: 2, product_url: "https://dly.com.br/p/a", image_url: "https://dly.com.br/a.jpg" },
    { name: "Sutiã", price: 50.1, quantity: 1 },
  ],
  ...over,
});

describe("parseCartPayload", () => {
  it("normalizes the plugin's array payload", () => {
    const { carts, rejected } = parseCartPayload([cart()]);
    expect(rejected).toBe(0);
    expect(carts).toHaveLength(1);
    expect(carts[0]).toMatchObject({
      externalId: "41",
      email: "maria@gmail.com",
      firstName: "Maria",
      lastName: "Souza",
      status: "abandoned",
      cartUrl: "https://dly.com.br/?rishi_recover=abc123",
      total: 129.9,
      currency: "BRL",
      reachedCheckout: true,
    });
    expect(carts[0].phone).toMatch(/^55\d{10,11}$/);
    expect(carts[0].items).toHaveLength(2);
    expect(carts[0].items[1]).toMatchObject({ name: "Sutiã", quantity: 1, product_url: null });
  });

  it("also accepts { carts: [...] } and a single object", () => {
    expect(parseCartPayload({ carts: [cart()] }).carts).toHaveLength(1);
    expect(parseCartPayload(cart()).carts).toHaveLength(1);
    expect(parseCartPayload("nope").carts).toHaveLength(0);
    expect(parseCartPayload(null).carts).toHaveLength(0);
  });

  it("accepts an e-mail-only cart (no phone), which the old Funnelkit hook dropped", () => {
    const { carts } = parseCartPayload([cart({ phone: "" })]);
    expect(carts[0].phone).toBeNull();
    expect(carts[0].email).toBe("maria@gmail.com");
  });

  it("rejects entries with no id or no way to reach the person", () => {
    const { carts, rejected } = parseCartPayload([
      cart({ id: "" }),
      cart({ email: "not-an-email", phone: "" }),
      cart({ email: "", phone: "" }),
      null,
      cart({ id: 7 }),
    ]);
    expect(carts.map((c) => c.externalId)).toEqual(["7"]);
    expect(rejected).toBe(4);
  });

  it("defaults an unknown status to abandoned and keeps the four known ones", () => {
    expect(parseCartPayload([cart({ cart_status: "weird" })]).carts[0].status).toBe("abandoned");
    for (const s of ["abandoned", "recovered", "converted", "dismissed"]) {
      expect(parseCartPayload([cart({ cart_status: s })]).carts[0].status).toBe(s);
    }
  });

  it("drops non-http(s) URLs instead of passing them to an e-mail button", () => {
    const { carts } = parseCartPayload([cart({ cart_url: "javascript:alert(1)" })]);
    expect(carts[0].cartUrl).toBeNull();
  });

  it("rejects a recovery link that points outside the store host", () => {
    const evil = cart({ cart_url: "https://evil.example/?rishi_recover=abc" });
    expect(parseCartPayload([evil], "https://dly.com.br").carts).toHaveLength(0);
    expect(parseCartPayload([evil], "https://dly.com.br").rejected).toBe(1);
    // www. and scheme-less store settings still match
    expect(parseCartPayload([cart()], "www.dly.com.br").carts).toHaveLength(1);
    expect(parseCartPayload([cart()], "https://www.dly.com.br/").carts).toHaveLength(1);
  });

  it("caps the batch size", () => {
    const many = Array.from({ length: 250 }, (_, i) => cart({ id: i + 1 }));
    const { carts, rejected } = parseCartPayload(many);
    expect(carts).toHaveLength(200);
    expect(rejected).toBe(50);
  });
});

describe("formatting", () => {
  it("formats BRL with dots and a comma", () => {
    expect(formatBRL(0)).toBe("R$ 0,00");
    expect(formatBRL(129.9)).toBe("R$ 129,90");
    expect(formatBRL(1234.5)).toBe("R$ 1.234,50");
    expect(formatBRL(1234567.05)).toBe("R$ 1.234.567,05");
  });

  it("lists items and truncates after ten", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      name: `Item ${i + 1}`,
      quantity: 1,
      price: 1,
      product_url: null,
      image_url: null,
    }));
    const list = buildCartItemsList(items).split("\n");
    expect(list).toHaveLength(11);
    expect(list[0]).toBe("▪️ Item 1 (Qtd: 1)");
    expect(list[10]).toBe("... e mais 2 item(s)");
    expect(buildCartItemsList([])).toBe("");
  });

  it("extracts the query string of a recovery link", () => {
    expect(urlSuffix("https://dly.com.br/?rishi_recover=abc123")).toBe("?rishi_recover=abc123");
    expect(urlSuffix(null)).toBe("");
    expect(urlSuffix("not a url")).toBe("");
  });
});
