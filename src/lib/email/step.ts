import type { SendEmailStepConfig } from "@/types";
import { renderEmailLayout } from "./layout";
import type { EmailBrand, RenderedEmail } from "./types";

/**
 * Turns the config of an automation `send_email` step into a subject + rendered
 * e-mail. Pure: the engine passes in its own `interpolate` (so `{{customer.x}}`,
 * `{{vars.x}}`, `{{cart.x}}`, `{{order.x}}` and the `{{x|fallback}}` form all
 * work) and the tenant brand / unsubscribe URL that send.ts provides.
 */

export type BuiltStepEmail =
  | { subject: string; rendered: RenderedEmail }
  | { error: string };

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function buildStepEmail(
  cfg: SendEmailStepConfig,
  interpolate: (template: string) => string,
  ctx: { brand: EmailBrand; unsubscribeUrl: string | null },
): BuiltStepEmail {
  // Subject/heading are single-line: stripping CR/LF also blocks header injection
  // through a variable that carries a newline.
  const subject = oneLine(interpolate(cfg.subject ?? ""));
  if (!subject) return { error: "subject is empty" };

  const heading = oneLine(interpolate(cfg.heading ?? ""));
  if (!heading) return { error: "heading is empty" };

  const paragraphs = interpolate(cfg.body ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return { error: "body is empty" };

  const ctaLabel = oneLine(interpolate(cfg.cta_label ?? ""));
  const ctaUrl = oneLine(interpolate(cfg.cta_url ?? ""));
  let cta: { label: string; url: string } | undefined;
  if (ctaLabel || ctaUrl) {
    if (!ctaLabel || !ctaUrl) return { error: "button label and URL must be filled together" };
    if (!/^https?:\/\//i.test(ctaUrl)) return { error: "cta_url must be an http(s) URL" };
    cta = { label: ctaLabel, url: ctaUrl };
  }

  const isHttp = (u: string) => /^https?:\/\//i.test(u);

  const heroUrl = oneLine(interpolate(cfg.hero_image_url ?? ""));
  let hero: { image_url: string; alt: string; href?: string } | undefined;
  if (heroUrl) {
    if (!isHttp(heroUrl)) return { error: "hero_image_url must be an http(s) URL" };
    const heroLink = oneLine(interpolate(cfg.hero_link_url ?? "")) || (cta?.url ?? "");
    hero = {
      image_url: heroUrl,
      alt: oneLine(interpolate(cfg.hero_image_alt ?? "")) || heading,
      href: isHttp(heroLink) ? heroLink : undefined,
    };
  }

  // At most 4 products: more would not fit a phone-width grid. A product with a
  // missing field is a configuration mistake, so fail loudly instead of sending
  // a broken e-mail to thousands of people.
  const products: NonNullable<Parameters<typeof renderEmailLayout>[0]["products"]> = [];
  for (const p of (cfg.products ?? []).slice(0, 4)) {
    const name = oneLine(interpolate(p.name ?? ""));
    const image_url = oneLine(interpolate(p.image_url ?? ""));
    const url = oneLine(interpolate(p.url ?? ""));
    const price = oneLine(interpolate(p.price ?? ""));
    if (!name || !image_url || !url || !price) {
      return { error: "each product needs name, image_url, price and url" };
    }
    if (!isHttp(image_url) || !isHttp(url)) {
      return { error: "product image_url and url must be http(s) URLs" };
    }
    products.push({
      name,
      image_url,
      url,
      price,
      price_note: oneLine(interpolate(p.price_note ?? "")) || undefined,
    });
  }

  const couponCode = oneLine(interpolate(cfg.coupon_code ?? ""));
  const coupon = couponCode
    ? {
        headline: oneLine(interpolate(cfg.coupon_headline ?? "")) || "Seu cupom",
        code: couponCode,
        note: oneLine(interpolate(cfg.coupon_note ?? "")) || undefined,
      }
    : undefined;

  const rendered = renderEmailLayout(
    {
      preheader: oneLine(interpolate(cfg.preheader ?? "")) || undefined,
      heading,
      hero,
      paragraphs,
      products: products.length > 0 ? products : undefined,
      coupon,
      cta,
      benefit: oneLine(interpolate(cfg.benefit ?? "")) || undefined,
      unsubscribeUrl: ctx.unsubscribeUrl,
    },
    ctx.brand,
  );
  return { subject, rendered };
}
