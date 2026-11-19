import { describe, expect, it } from "vitest";
import { escapeHtml, renderEmailLayout, renderVars, safeUrl } from "./layout";

describe("renderVars", () => {
  it("substitutes variables and applies fallbacks", () => {
    const vars = { first_name: "Maria", empty: "  ", missing: undefined };
    expect(renderVars("Oi, {{first_name}}!", vars)).toBe("Oi, Maria!");
    expect(renderVars("Oi, {{ empty | linda }}!", vars)).toBe("Oi, linda!");
    expect(renderVars("Oi, {{missing|}}!", vars)).toBe("Oi, !");
    expect(renderVars("Oi, {{unknown}}!", vars)).toBe("Oi, !");
  });
});

describe("safety helpers", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#039;y&#039;&lt;/script&gt;",
    );
  });

  it("only lets http(s) URLs through", () => {
    expect(safeUrl("https://dly.com.br/a?b=1")).toBe("https://dly.com.br/a?b=1");
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html;base64,xx")).toBe("#");
    expect(safeUrl("  http://x.co ")).toBe("http://x.co");
  });
});

describe("renderEmailLayout", () => {
  const brand = {
    logo_url: "https://dly.com.br/logo.png",
    company_name: "DLY Lingerie",
    strip_text: "kits com desconto automático",
    footer_note: "DLY Lingerie · CNPJ 00.000.000/0001-00",
  };

  it("renders heading, copy, coupon, CTA, benefit and unsubscribe link", () => {
    const { html, text } = renderEmailLayout(
      {
        preheader: "Seu cupom chegou",
        heading: "Sentimos sua falta",
        paragraphs: ["Oi, Maria.", "Passou da hora de voltar."],
        coupon: { headline: "R$ 20 de desconto", code: "VOLTA-ABC123", note: "Válido por 72 h." },
        cta: { label: "Usar meu cupom", url: "https://dly.com.br/?cupom=1" },
        benefit: "Pague no Pix ou em até 6x sem juros.",
        unsubscribeUrl: "https://crm.example.com/api/public/unsubscribe?t=v1.a.b",
      },
      brand,
    );
    expect(html).toContain("Sentimos sua falta");
    expect(html).toContain("VOLTA-ABC123");
    expect(html).toContain("USAR MEU CUPOM");
    expect(html).toContain("https://dly.com.br/logo.png");
    expect(html).toContain("KITS COM DESCONTO AUTOMÁTICO");
    expect(html).toContain("Cancelar inscrição");
    expect(html).toContain("Pague no Pix");
    expect(text).toContain("VOLTA-ABC123");
    expect(text).toContain("https://dly.com.br/?cupom=1");
    expect(text).toContain("Cancelar inscrição: https://crm.example.com/api/public/unsubscribe?t=v1.a.b");
  });

  it("escapes user-controlled text and blocks javascript: links", () => {
    const { html } = renderEmailLayout(
      {
        heading: `<img src=x onerror=alert(1)>`,
        paragraphs: [`<b>oi</b>`],
        cta: { label: "Clique", url: "javascript:alert(1)" },
      },
      {},
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>oi</b>");
    expect(html).toContain("&lt;b&gt;oi&lt;/b&gt;");
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });

  it("renders items with a total and omits optional blocks cleanly", () => {
    const { html, text } = renderEmailLayout(
      {
        heading: "Seu carrinho",
        paragraphs: ["Oi."],
        items: [{ name: "Calçola Cintura Alta", variant: "Preto · P", quantity: 2, price: "R$ 75,90" }],
        total: "R$ 75,90",
      },
      {},
    );
    expect(html).toContain("CALÇOLA CINTURA ALTA");
    expect(html).toContain("Preto · P");
    expect(html).toContain("2x");
    expect(html).toContain("TOTAL");
    expect(html).not.toContain("Cancelar inscrição");
    expect(text).toContain("- Calçola Cintura Alta (Preto · P) x2: R$ 75,90");
  });

  it("falls back to default colours when the brand colour is invalid", () => {
    const { html } = renderEmailLayout(
      { heading: "x", paragraphs: [], cta: { label: "ok", url: "https://a.co" } },
      { accent: "red;background:url(x)", ink: "#222" },
    );
    expect(html).toContain("#087f58");
    expect(html).not.toContain("url(x)");
    expect(html).toContain("#222");
  });
});
