import { describe, it, expect } from "vitest";
import { parseBirthday, extractBirthdayRaw } from "./birthday";

describe("parseBirthday", () => {
  it("parses ISO dates (with and without time)", () => {
    expect(parseBirthday("1990-05-14")).toBe("1990-05-14");
    expect(parseBirthday("1990/05/14")).toBe("1990-05-14");
    expect(parseBirthday("1990-05-14T00:00:00")).toBe("1990-05-14");
  });

  it("parses pt-BR day-first dates with year", () => {
    expect(parseBirthday("14/05/1990")).toBe("1990-05-14");
    expect(parseBirthday("14-05-1990")).toBe("1990-05-14");
    expect(parseBirthday("7/3/1985")).toBe("1985-03-07");
  });

  it("stamps a leap-safe placeholder year when none is given", () => {
    expect(parseBirthday("14/05")).toBe("1904-05-14");
    expect(parseBirthday("29/02")).toBe("1904-02-29");
  });

  it("rejects impossible dates", () => {
    expect(parseBirthday("31/02/1990")).toBeNull();
    expect(parseBirthday("00/13/1990")).toBeNull();
    expect(parseBirthday("1990-13-40")).toBeNull();
  });

  it("returns null for blank/garbage/missing input", () => {
    expect(parseBirthday(null)).toBeNull();
    expect(parseBirthday(undefined)).toBeNull();
    expect(parseBirthday("   ")).toBeNull();
    expect(parseBirthday("não informado")).toBeNull();
  });
});

describe("extractBirthdayRaw", () => {
  it("reads a billing field", () => {
    expect(extractBirthdayRaw({ birthdate: "1990-05-14" }, null)).toBe(
      "1990-05-14",
    );
    expect(extractBirthdayRaw({ data_nascimento: "14/05/1990" }, [])).toBe(
      "14/05/1990",
    );
  });

  it("reads a meta_data entry by key", () => {
    const meta = [
      { key: "_unrelated", value: "x" },
      { key: "_billing_birthdate", value: "1988-12-01" },
    ];
    expect(extractBirthdayRaw(null, meta)).toBe("1988-12-01");
  });

  it("prefers meta_data over billing (billing.birthdate is ambiguous MM-DD)", () => {
    // Real DLY shape: billing.birthdate is US MM-DD-YYYY with a time
    // suffix; meta carries the same date as clean pt-BR DD/MM/YYYY. We
    // must take the meta value so the parsed date is correct.
    const raw = extractBirthdayRaw({ birthdate: "10-11-1994T00:00:00" }, [
      { key: "_billing_birthdate", value: "11/10/1994" },
    ]);
    expect(raw).toBe("11/10/1994");
    expect(parseBirthday(raw)).toBe("1994-10-11"); // 11 October, not 10 Nov
  });

  it("ignores empty values and unknown keys", () => {
    expect(extractBirthdayRaw({ birthdate: "  " }, [{ key: "foo", value: "x" }])).toBeNull();
    expect(extractBirthdayRaw(null, null)).toBeNull();
    expect(extractBirthdayRaw(undefined, undefined)).toBeNull();
  });
});
