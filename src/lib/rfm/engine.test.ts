import { describe, expect, it } from "vitest";
import { getSegment } from "./engine";

describe("getSegment", () => {
  it("should categorize champions correctly", () => {
    expect(getSegment(5, 5, 5)).toBe("champion");
    expect(getSegment(4, 5, 4)).toBe("champion");
  });

  it("should categorize loyal customers correctly", () => {
    expect(getSegment(3, 4, 4)).toBe("loyal");
    expect(getSegment(4, 3, 4)).toBe("loyal");
  });

  it("should categorize new customers correctly", () => {
    expect(getSegment(5, 1, 1)).toBe("new_customer");
    expect(getSegment(4, 1, 2)).toBe("new_customer");
  });

  it("should categorize customers in risk correctly", () => {
    expect(getSegment(1, 5, 5)).toBe("in_risk");
    expect(getSegment(2, 4, 3)).toBe("in_risk");
  });

  it("should categorize about to sleep correctly", () => {
    expect(getSegment(3, 2, 2)).toBe("about_to_sleep");
    expect(getSegment(3, 1, 2)).toBe("about_to_sleep");
  });

  it("should categorize hibernating correctly", () => {
    expect(getSegment(2, 2, 1)).toBe("hibernating");
    expect(getSegment(1, 2, 2)).toBe("hibernating");
    expect(getSegment(2, 1, 2)).toBe("hibernating");
  });

  it("should categorize lost correctly", () => {
    expect(getSegment(1, 1, 1)).toBe("lost");
  });
});
