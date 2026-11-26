import { describe, expect, it } from "vitest";
import type { SendEmailStepConfig } from "@/types";
import { renderEmailLayout } from "./layout";
import { buildStepEmail } from "./step";

const interpolate = (s: string) => s;
const ctx = { brand: { company_name: "DLY Lingerie" }, unsubscribeUrl: "https://crm.example.com/u?t=x" };

const product = (n: number) => ({
  name: `Kit ${n}`,
  image_url: `https://loja.example.com/img/${n}.png`,
  price: `R$ ${n}9,90`,
  price_note: `R$ ${n}0,00 no Pix`,
  url: `https://loja.example.com/p/${n}/?utm_source=email`,
});

const baseCfg = (over: Partial<SendEmailStepConfig> = {}): SendEmailStepConfig => ({
  subject: "Black Friday",
  heading: "Black Friday DLY",
  body: "Texto.",
  cta_label: "Aproveitar",
  cta_url: "https://loja.example.com/?utm=x",
  ...over,
});

describe("renderEmailLayout hero + products", () => {
  it("renders nothing extra when neither is given (existing e-mails are unchanged)", () => {
    const { html } = renderEmailLayout({ heading: "Oi", paragraphs: ["Texto"] });
    expect(html).not.toContain("max-width:340px");
    expect(html).not.toContain("max-width:170px");
  });

  it("renders a linked hero image under the heading, with alt text", () => {
    const { html } = renderEmailLayout({
      heading: "Oi",
      paragraphs: ["Texto"],
      hero: { image_url: "https://loja.example.com/h.png", alt: "Kit de sutiãs", href: "https://loja.example.com/kit" },
    });
    expect(html).toContain('src="https://loja.example.com/h.png"');
    expect(html).toContain('alt="Kit de sutiãs"');
    expect(html).toContain('href="https://loja.example.com/kit"');
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("h.png"));
    expect(html.indexOf("h.png")).toBeLessThan(html.indexOf("Texto"));
  });

  it("lays out 3 products in one row with price and price note", () => {
    const { html, text } = renderEmailLayout({ heading: "Oi", paragraphs: ["x"], products: [product(1), product(2), product(3)] });
    expect(html.match(/max-width:170px/g)).toHaveLength(3);
    expect(html.match(/<tr><td width="33%"/g)).toHaveLength(1);
    expect(html).toContain("R$ 19,90");
    expect(html).toContain("R$ 10,00 no Pix");
    expect(text).toContain("- Kit 2: R$ 29,90 (R$ 20,00 no Pix)");
    expect(text).toContain("https://loja.example.com/p/2/?utm_source=email");
  });

  it("lays out 4 products as 2 + 2 and pads an odd last row", () => {
    const four = renderEmailLayout({ heading: "Oi", paragraphs: ["x"], products: [1, 2, 3, 4].map(product) }).html;
    expect(four.match(/<tr><td width="50%"/g)).toHaveLength(2);
    const two = renderEmailLayout({ heading: "Oi", paragraphs: ["x"], products: [product(1), product(2)] }).html;
    expect(two.match(/width="50%"/g)).toHaveLength(2);
  });

  it("escapes product text and refuses non-http URLs", () => {
    const { html } = renderEmailLayout({
      heading: "Oi",
      paragraphs: ["x"],
      products: [{ ...product(1), name: '<b>"x"</b>', url: "javascript:alert(1)", image_url: "data:text/html,boom" }],
    });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
  });
});

describe("buildStepEmail hero + products", () => {
  it("builds a hero that links to the button URL by default", () => {
    const built = buildStepEmail(baseCfg({ hero_image_url: "https://loja.example.com/h.png", hero_image_alt: "Kit" }), interpolate, ctx);
    if ("error" in built) throw new Error(built.error);
    expect(built.rendered.html).toContain('src="https://loja.example.com/h.png"');
    expect(built.rendered.html).toContain('href="https://loja.example.com/?utm=x"');
  });

  it("falls back to the heading as alt text", () => {
    const built = buildStepEmail(baseCfg({ hero_image_url: "https://loja.example.com/h.png" }), interpolate, ctx);
    if ("error" in built) throw new Error(built.error);
    expect(built.rendered.html).toContain('alt="Black Friday DLY"');
  });

  it("builds up to 4 products and ignores the rest", () => {
    const built = buildStepEmail(baseCfg({ products: [1, 2, 3, 4, 5].map(product) }), interpolate, ctx);
    if ("error" in built) throw new Error(built.error);
    expect(built.rendered.html.match(/max-width:170px/g)).toHaveLength(4);
    expect(built.rendered.html).not.toContain("Kit 5");
  });

  it("fails loudly on an incomplete product or a bad URL", () => {
    expect(buildStepEmail(baseCfg({ products: [{ ...product(1), price: "" }] }), interpolate, ctx)).toEqual({
      error: "each product needs name, image_url, price and url",
    });
    expect(buildStepEmail(baseCfg({ products: [{ ...product(1), url: "ftp://x" }] }), interpolate, ctx)).toEqual({
      error: "product image_url and url must be http(s) URLs",
    });
    expect(buildStepEmail(baseCfg({ hero_image_url: "javascript:1" }), interpolate, ctx)).toEqual({
      error: "hero_image_url must be an http(s) URL",
    });
  });

  it("leaves an e-mail without media byte-for-byte unchanged in structure", () => {
    const plain = buildStepEmail(baseCfg(), interpolate, ctx);
    if ("error" in plain) throw new Error(plain.error);
    expect(plain.rendered.html).not.toContain("max-width:170px");
    expect(plain.rendered.html).not.toContain("max-width:340px");
  });
});
