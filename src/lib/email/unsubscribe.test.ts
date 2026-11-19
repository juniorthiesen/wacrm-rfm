import { describe, expect, it } from "vitest";
import {
  buildUnsubscribeUrl,
  normalizeEmail,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe";

const USER = "11111111-2222-3333-4444-555555555555";

describe("unsubscribe tokens", () => {
  it("round-trips the tenant and a normalised e-mail", () => {
    const token = signUnsubscribeToken(USER, "  Maria@Gmail.COM ");
    expect(verifyUnsubscribeToken(token)).toEqual({ userId: USER, email: "maria@gmail.com" });
  });

  it("rejects a tampered payload (someone else's address)", () => {
    const token = signUnsubscribeToken(USER, "maria@gmail.com");
    const [v, , sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ u: USER, e: "outra@gmail.com" })).toString("base64url");
    expect(verifyUnsubscribeToken(`${v}.${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signUnsubscribeToken(USER, "maria@gmail.com");
    expect(verifyUnsubscribeToken(token.slice(0, -2) + "xx")).toBeNull();
  });

  it("rejects malformed input and unknown versions", () => {
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("abc")).toBeNull();
    expect(verifyUnsubscribeToken("v2.a.b")).toBeNull();
    expect(verifyUnsubscribeToken("v1.notbase64!.sig")).toBeNull();
  });

  it("is deterministic for the same inputs (links in old e-mails keep working)", () => {
    expect(signUnsubscribeToken(USER, "a@b.co")).toBe(signUnsubscribeToken(USER, "A@B.co"));
  });

  it("builds a URL-safe link without double slashes", () => {
    const url = buildUnsubscribeUrl("https://crm.example.com/", "v1.a.b");
    expect(url).toBe("https://crm.example.com/api/public/unsubscribe?t=v1.a.b");
    expect(normalizeEmail(" X@Y.com ")).toBe("x@y.com");
  });
});
