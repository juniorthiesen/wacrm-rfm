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
      paragraphs,
      coupon,
      cta,
      benefit: oneLine(interpolate(cfg.benefit ?? "")) || undefined,
      unsubscribeUrl: ctx.unsubscribeUrl,
    },
    ctx.brand,
  );
  return { subject, rendered };
}
