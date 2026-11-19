import { describe, expect, it } from "vitest";
import { evaluateLimits, startOfLocalDay } from "./limits";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-19T15:00:00Z");

const base = {
  category: "marketing" as const,
  now,
  sentToday: 0,
  dailyLimit: 150,
  lastMarketingSentAt: null,
  minGapDays: 3,
};

describe("evaluateLimits", () => {
  it("allows a first marketing e-mail", () => {
    expect(evaluateLimits(base)).toEqual({ allowed: true });
  });

  it("blocks when the daily cap is reached (and allows just below it)", () => {
    expect(evaluateLimits({ ...base, sentToday: 149 })).toEqual({ allowed: true });
    expect(evaluateLimits({ ...base, sentToday: 150 })).toEqual({ allowed: false, reason: "daily_limit" });
  });

  it("enforces the per-address marketing gap across automations", () => {
    const twoDaysAgo = new Date(now.getTime() - 2 * DAY);
    const threeDaysAgo = new Date(now.getTime() - 3 * DAY);
    expect(evaluateLimits({ ...base, lastMarketingSentAt: twoDaysAgo })).toEqual({
      allowed: false,
      reason: "marketing_gap",
    });
    expect(evaluateLimits({ ...base, lastMarketingSentAt: threeDaysAgo })).toEqual({ allowed: true });
  });

  it("minGapDays = 0 disables the per-address cap", () => {
    expect(evaluateLimits({ ...base, minGapDays: 0, lastMarketingSentAt: new Date(now.getTime() - 1000) })).toEqual({
      allowed: true,
    });
  });

  it("never limits transactional e-mail", () => {
    expect(
      evaluateLimits({
        ...base,
        category: "transactional",
        sentToday: 9999,
        lastMarketingSentAt: new Date(now.getTime() - 1000),
      }),
    ).toEqual({ allowed: true });
  });

  it("daily cap wins over the gap when both apply", () => {
    expect(
      evaluateLimits({ ...base, sentToday: 150, lastMarketingSentAt: new Date(now.getTime() - 1000) }),
    ).toEqual({ allowed: false, reason: "daily_limit" });
  });
});

describe("startOfLocalDay (America/Sao_Paulo)", () => {
  it("returns local midnight (03:00Z) for a midday instant", () => {
    expect(startOfLocalDay(new Date("2026-11-19T12:00:00Z")).toISOString()).toBe("2026-11-19T03:00:00.000Z");
  });

  it("still belongs to the previous local day just after UTC midnight", () => {
    // 02:30Z on the 19th is 23:30 on the 18th in São Paulo.
    expect(startOfLocalDay(new Date("2026-11-19T02:30:00Z")).toISOString()).toBe("2026-11-18T03:00:00.000Z");
  });

  it("is exactly local midnight at the boundary", () => {
    expect(startOfLocalDay(new Date("2026-11-19T03:00:00Z")).toISOString()).toBe("2026-11-19T03:00:00.000Z");
  });

  it("supports other zones", () => {
    expect(startOfLocalDay(new Date("2026-11-19T12:00:00Z"), "UTC").toISOString()).toBe("2026-11-19T00:00:00.000Z");
  });
});
