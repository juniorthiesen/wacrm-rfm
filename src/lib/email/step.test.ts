import { describe, expect, it } from "vitest";
import type { SendEmailStepConfig } from "@/types";
import { buildStepEmail } from "./step";

/** Minimal stand-in for the engine's interpolate: {{key}} / {{key|fallback}}. */
function interpolator(vars: Record<string, string>) {
  return (s: string) =>
    s.replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_m, key: string, fallback?: string) => {
      const v = vars[key] ?? "";
      return v === "" && fallback !== undefined ? fallback.trim() : v;
    });
}

const cfg = (over: Partial<SendEmailStepConfig> = {}): SendEmailStepConfig => ({
  subject: "{{customer.first_name|Oi}}, sentimos sua falta",
  heading: "Sentimos sua falta",
  body: "Oi, {{customer.first_name|linda}}.\n\nPassou da hora de voltar.",
  ...over,
});

const ctx = { brand: { company_name: "DLY Lingerie" }, unsubscribeUrl: "https://crm.example.com/u?t=x" };

describe("buildStepEmail", () => {
  it("interpolates subject and body, splitting paragraphs on blank lines", () => {
    const built = buildStepEmail(cfg(), interpolator({ "customer.first_name": "Maria" }), ctx);
    if ("error" in built) throw new Error(built.error);
    expect(built.subject).toBe("Maria, sentimos sua falta");
    expect(built.rendered.html).toContain("Oi, Maria.");
    expect(built.rendered.html).toContain("Passou da hora de voltar.");
    expect(built.rendered.html).toContain("Cancelar inscrição");
  });

  it("uses fallbacks when the customer has no name", () => {
    const built = buildStepEmail(cfg(), interpolator({}), ctx);
    if ("error" in built) throw new Error(built.error);
    expect(built.subject).toBe("Oi, sentimos sua falta");
    expect(built.rendered.text).toContain("Oi, linda.");
  });

  it("renders a coupon box and CTA when configured", () => {
    const built = buildStepEmail(
      cfg({
        coupon_code: "{{vars.coupon}}",
        coupon_headline: "R$ 20 de desconto",
        coupon_note: "Válido por 72 h.",
        cta_label: "Usar meu cupom",
        cta_url: "https://dly.com.br/?cupom={{vars.coupon}}",
        benefit: "Pague no Pix ou em até 6x sem juros.",
      }),
      interpolator({ "vars.coupon": "VOLTA-AB12" }),
      ctx,
    );
    if ("error" in built) throw new Error(built.error);
    expect(built.rendered.html).toContain("VOLTA-AB12");
    expect(built.rendered.html).toContain("R$ 20 DE DESCONTO");
    expect(built.rendered.html).toContain("USAR MEU CUPOM");
    expect(built.rendered.html).toContain("https://dly.com.br/?cupom=VOLTA-AB12");
  });

  it("omits the coupon box when the coupon variable is empty", () => {
    const built = buildStepEmail(cfg({ coupon_code: "{{vars.coupon}}" }), interpolator({}), ctx);
    if ("error" in built) throw new Error(built.error);
    expect(built.rendered.html).not.toContain("Seu cupom");
  });

  it("reports precise errors for incomplete steps", () => {
    const i = interpolator({});
    expect(buildStepEmail(cfg({ subject: "  " }), i, ctx)).toEqual({ error: "subject is empty" });
    expect(buildStepEmail(cfg({ heading: "" }), i, ctx)).toEqual({ error: "heading is empty" });
    expect(buildStepEmail(cfg({ body: " \n\n " }), i, ctx)).toEqual({ error: "body is empty" });
    expect(buildStepEmail(cfg({ cta_label: "Ir" }), i, ctx)).toEqual({
      error: "button label and URL must be filled together",
    });
    expect(buildStepEmail(cfg({ cta_label: "Ir", cta_url: "javascript:alert(1)" }), i, ctx)).toEqual({
      error: "cta_url must be an http(s) URL",
    });
  });

  it("strips line breaks from subject and heading (header-injection guard)", () => {
    const built = buildStepEmail(
      cfg({ subject: "Oi {{customer.name}}", heading: "Título" }),
      interpolator({ "customer.name": "Maria\r\nBcc: attacker@evil.com" }),
      ctx,
    );
    if ("error" in built) throw new Error(built.error);
    expect(built.subject).toBe("Oi Maria Bcc: attacker@evil.com");
    expect(built.subject).not.toMatch(/[\r\n]/);
  });
});
