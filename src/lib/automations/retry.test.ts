import { describe, expect, it } from "vitest";
import { MAX_RETRIES, planRetry, RetryStep } from "./retry";

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-11-19T15:00:00Z"); // 12:00 in São Paulo

describe("planRetry (kind: error)", () => {
  it("backs off 1 h, 4 h, 12 h, 24 h", () => {
    const hours = [1, 2, 3, 4].map((a) => {
      const d = planRetry("error", a, now);
      if (!d.retry) throw new Error("expected retry");
      return (d.at.getTime() - now.getTime()) / HOUR;
    });
    expect(hours).toEqual([1, 4, 12, 24]);
  });

  it("gives up after the maximum number of retries", () => {
    expect(planRetry("error", MAX_RETRIES.error, now).retry).toBe(true);
    expect(planRetry("error", MAX_RETRIES.error + 1, now)).toEqual({ retry: false, max: MAX_RETRIES.error });
  });

  it("reports the attempt and the maximum for the log message", () => {
    expect(planRetry("error", 2, now)).toMatchObject({ retry: true, attempt: 2, max: 4 });
  });
});

describe("planRetry (kind: limit)", () => {
  it("retries just after the next local midnight (São Paulo), not after a fixed delay", () => {
    const d = planRetry("limit", 1, now);
    if (!d.retry) throw new Error("expected retry");
    // local midnight of the 20th is 03:00Z, plus 10 minutes
    expect(d.at.toISOString()).toBe("2026-11-20T03:10:00.000Z");
  });

  it("late in the local day it waits only until the limit resets", () => {
    const lateLocal = new Date("2026-11-20T02:30:00Z"); // 23:30 on the 19th in São Paulo
    const d = planRetry("limit", 1, lateLocal);
    if (!d.retry) throw new Error("expected retry");
    expect(d.at.toISOString()).toBe("2026-11-20T03:10:00.000Z");
  });

  it("gives up after 6 tries", () => {
    expect(planRetry("limit", 6, now).retry).toBe(true);
    expect(planRetry("limit", 7, now)).toEqual({ retry: false, max: 6 });
  });
});

describe("RetryStep", () => {
  it("is an Error that carries its kind", () => {
    const e = new RetryStep("woo down", "error");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(RetryStep);
    expect(e.kind).toBe("error");
    expect(e.message).toBe("woo down");
  });

  it("treats a non-positive attempt as the first", () => {
    expect(planRetry("error", 0, now)).toMatchObject({ retry: true, attempt: 1 });
  });
});
