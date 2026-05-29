import { describe, expect, it } from "vitest";
import { normalizePhone } from "./phone-normalization";

describe("normalizePhone", () => {
  it("should return null for empty input", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
  });

  it("should strip formatting characters", () => {
    expect(normalizePhone("+55 (51) 99888-7766")).toBe("5551998887766");
    expect(normalizePhone("55-51-99888-7766")).toBe("5551998887766");
  });

  it("should remove leading single zero", () => {
    expect(normalizePhone("051998887766")).toBe("5551998887766");
    expect(normalizePhone("01133334444")).toBe("551133334444");
  });

  it("should remove leading double zeros", () => {
    expect(normalizePhone("005551998887766")).toBe("5551998887766");
  });

  it("should prepend country code 55 for 10 or 11 digit numbers", () => {
    // 11 digits (mobile)
    expect(normalizePhone("51998887766")).toBe("5551998887766");
    // 10 digits (landline)
    expect(normalizePhone("1133334444")).toBe("551133334444");
  });

  it("should keep already complete international numbers as-is", () => {
    // Already has 55 (13 digits)
    expect(normalizePhone("5551998887766")).toBe("5551998887766");
    // US number with +1
    expect(normalizePhone("+1 (415) 555-2671")).toBe("14155552671");
  });
});
