import { describe, expect, it, vi } from "vitest";
import { generateCouponCode, normalizeCouponPrefix, type CouponSpec } from "./connector";
import { createWooCoupon } from "./woo-coupons";

const cfg = { storeUrl: "https://dly.com.br/", consumerKey: "ck_test", consumerSecret: "cs_test" };
const spec: CouponSpec = {
  codePrefix: "volta",
  discountType: "fixed_cart",
  amount: 20,
  minimumAmount: 100,
  validDays: 10,
  email: "Maria@Gmail.com",
  description: "Régua de reativação",
};
const NOW = new Date("2026-11-19T15:00:00Z");

const ok = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("generateCouponCode", () => {
  it("builds PREFIX-XXXXXX from an unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCouponCode("volta")).toMatch(/^VOLTA-[A-HJ-NP-Z2-9]{6}$/);
    }
  });

  it("is driven by the injected randomness (testable)", () => {
    const code = generateCouponCode("x", () => new Uint8Array([0, 1, 2, 3, 4, 5]));
    expect(code).toBe("X-ABCDEF");
  });

  it("cleans odd prefixes", () => {
    expect(normalizeCouponPrefix("  vol ta!! ")).toBe("VOLTA");
    expect(normalizeCouponPrefix("%%%")).toBe("CUPOM");
    expect(normalizeCouponPrefix("a".repeat(50))).toHaveLength(24);
  });
});

describe("createWooCoupon", () => {
  it("POSTs a single-use, e-mail-restricted, expiring coupon with Basic auth", async () => {
    const fetchMock = vi.fn(async () => ok({ id: 987, code: "volta-abc123" }));
    const created = await createWooCoupon(cfg, spec, () => "VOLTA-ABC123", fetchMock as unknown as typeof fetch, NOW);

    expect(created).toEqual({ code: "VOLTA-ABC123", externalId: "987", expiresAt: "2026-11-29T15:00:00Z" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://dly.com.br/wp-json/wc/v3/coupons");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("ck_test:cs_test").toString("base64")}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      code: "VOLTA-ABC123",
      discount_type: "fixed_cart",
      amount: "20",
      individual_use: true,
      usage_limit: 1,
      usage_limit_per_user: 1,
      email_restrictions: ["maria@gmail.com"],
      date_expires_gmt: "2026-11-29T15:00:00",
      minimum_amount: "100",
      description: "Régua de reativação",
    });
  });

  it("omits the minimum when there is none", async () => {
    const fetchMock = vi.fn(async () => ok({ id: 1, code: "x" }));
    await createWooCoupon(cfg, { ...spec, minimumAmount: 0 }, () => "X", fetchMock as unknown as typeof fetch, NOW);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("minimum_amount");
  });

  it("retries with a new random code on a code collision", async () => {
    const codes = ["DUP-1", "DUP-2"];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ code: "woocommerce_rest_coupon_code_already_exists", message: "exists" }, 400))
      .mockResolvedValueOnce(ok({ id: 5, code: "dup-2" }));
    const created = await createWooCoupon(cfg, spec, () => codes.shift() as string, fetchMock as unknown as typeof fetch, NOW);
    expect(created.code).toBe("DUP-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after repeated collisions and does not retry other errors", async () => {
    const collision = () => ok({ code: "woocommerce_rest_coupon_code_already_exists", message: "exists" }, 400);
    const many = vi.fn(async () => collision());
    await expect(createWooCoupon(cfg, spec, () => "SAME", many as unknown as typeof fetch, NOW)).rejects.toThrow(
      /coupon creation failed/,
    );
    expect(many).toHaveBeenCalledTimes(3);

    const forbidden = vi.fn(async () => ok({ message: "Sem permissão" }, 401));
    await expect(createWooCoupon(cfg, spec, () => "X", forbidden as unknown as typeof fetch, NOW)).rejects.toThrow(
      "401 Sem permissão",
    );
    expect(forbidden).toHaveBeenCalledTimes(1);
  });
});
