import type { EmailBrand, RenderedEmail } from "./types";

/**
 * Transactional/marketing e-mail layout in the DLY design system:
 * thin ink band → logo → heading → copy → items → coupon box → green CTA →
 * tint benefit note → ink footer with the unsubscribe link.
 *
 * Tokens (from the DLY storefront): ink #111111, line #e5e5e5, accent/green
 * #087f58, tint #f2f8f4, soft #f6f3f0, nude #d7c3b4, font Jost (falls back to
 * Arial where web fonts are blocked), square corners.
 *
 * Everything is inline-styled tables for mail-client compatibility. All dynamic
 * text is HTML-escaped and every URL is restricted to http(s).
 */

const FONT = "font-family:Jost,Arial,Helvetica,sans-serif;";
const DEFAULTS = {
  ink: "#111111",
  accent: "#087f58",
  tint: "#f2f8f4",
  tintLine: "#d8eadf",
  soft: "#f6f3f0",
  line: "#e5e5e5",
  nude: "#d7c3b4",
  muted: "#667085",
} as const;

export interface LayoutItem {
  name: string;
  variant?: string;
  quantity: number;
  /** Already formatted, e.g. "R$ 37,95". */
  price: string;
  image_url?: string;
}

export interface LayoutInput {
  /** Hidden preview text shown by the inbox list. */
  preheader?: string;
  heading: string;
  paragraphs: string[];
  items?: LayoutItem[];
  /** Already formatted. Shown under the items when present. */
  total?: string;
  coupon?: { headline: string; code: string; note?: string };
  cta?: { label: string; url: string };
  /** Small tinted note under the CTA ("Pague no Pix ou em até 6x sem juros."). */
  benefit?: string;
  /** Required by send.ts for marketing; renders the "Cancelar inscrição" link. */
  unsubscribeUrl?: string | null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Only http(s) URLs may reach an href/src; anything else becomes "#". */
export function safeUrl(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : "#";
}

function safeColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback;
}

/**
 * `{{first_name}}` → value; `{{first_name|linda}}` → value, or "linda" when the
 * value is empty. Unknown variables render as their fallback (or ""). Output is
 * NOT escaped: pass it through renderEmailLayout, which escapes.
 */
export function renderVars(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}\}/g, (_m, name: string, fallback?: string) => {
    const value = vars[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
    return fallback?.trim() ?? "";
  });
}

function paragraphHtml(text: string): string {
  return `<p style="margin:0 0 16px;${FONT}color:#444444;font-size:15px;line-height:1.6;text-align:center;">${escapeHtml(text).replace(/\n/g, "<br />")}</p>`;
}

function itemsHtml(items: LayoutItem[], total: string | undefined, ink: string): string {
  const rows = items
    .map((item) => {
      const thumb = item.image_url
        ? `<img src="${escapeHtml(safeUrl(item.image_url))}" width="64" alt="" style="display:block;width:64px;height:auto;border:0;" />`
        : "";
      const variant = item.variant
        ? `<br /><span style="color:${DEFAULTS.muted};font-size:13px;">${escapeHtml(item.variant)}</span>`
        : "";
      return (
        `<tr>` +
        `<td style="padding:14px 14px 14px 0;border-bottom:1px solid ${DEFAULTS.line};width:64px;vertical-align:top;">${thumb}</td>` +
        `<td style="padding:14px 0;border-bottom:1px solid ${DEFAULTS.line};vertical-align:top;${FONT}font-size:13px;line-height:1.45;color:${ink};"><strong style="font-weight:600;letter-spacing:0.06em;">${escapeHtml(item.name.toUpperCase())}</strong>${variant}</td>` +
        `<td style="padding:14px 0;border-bottom:1px solid ${DEFAULTS.line};text-align:center;vertical-align:top;${FONT}font-size:14px;color:${ink};">${item.quantity}x</td>` +
        `<td style="padding:14px 0 14px 10px;border-bottom:1px solid ${DEFAULTS.line};text-align:right;vertical-align:top;${FONT}font-size:14px;font-weight:500;color:${ink};">${escapeHtml(item.price)}</td>` +
        `</tr>`
      );
    })
    .join("");
  const totalRow = total
    ? `<table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>` +
      `<td bgcolor="${DEFAULTS.soft}" style="background:${DEFAULTS.soft};padding:14px 16px;${FONT}font-size:13px;font-weight:600;letter-spacing:0.1em;color:${ink};">TOTAL</td>` +
      `<td bgcolor="${DEFAULTS.soft}" align="right" style="background:${DEFAULTS.soft};padding:14px 16px;text-align:right;${FONT}font-size:20px;font-weight:600;color:${ink};">${escapeHtml(total)}</td>` +
      `</tr></table>`
    : "";
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:22px 0 0;">${rows}</table>${totalRow}`;
}

function couponHtml(coupon: NonNullable<LayoutInput["coupon"]>, accent: string, ink: string): string {
  const note = coupon.note
    ? `<div style="font-size:12px;line-height:1.5;color:${DEFAULTS.muted};">${escapeHtml(coupon.note)}</div>`
    : "";
  return (
    `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:4px 0 8px;"><tr>` +
    `<td align="center" bgcolor="${DEFAULTS.tint}" style="background:${DEFAULTS.tint};border:1px dashed ${accent};padding:18px 14px;text-align:center;${FONT}">` +
    `<div style="font-size:11px;font-weight:600;letter-spacing:0.18em;color:${accent};">${escapeHtml(coupon.headline.toUpperCase())}</div>` +
    `<div style="margin:6px 0;font-size:24px;font-weight:600;letter-spacing:0.12em;color:${ink};">${escapeHtml(coupon.code)}</div>` +
    note +
    `</td></tr></table>`
  );
}

export function renderEmailLayout(input: LayoutInput, brand: EmailBrand = {}): RenderedEmail {
  const ink = safeColor(brand.ink, DEFAULTS.ink);
  const accent = safeColor(brand.accent, DEFAULTS.accent);
  const company = brand.company_name?.trim() || "";

  const strip = brand.strip_text
    ? `<tr><td bgcolor="${ink}" style="background:${ink};padding:9px 12px;text-align:center;${FONT}font-size:11px;font-weight:600;letter-spacing:0.18em;color:#ffffff;">${escapeHtml(brand.strip_text.toUpperCase())}</td></tr>`
    : "";

  const logo = brand.logo_url
    ? `<img src="${escapeHtml(safeUrl(brand.logo_url))}" width="84" alt="${escapeHtml(company)}" style="display:inline-block;width:84px;height:auto;border:0;" />`
    : company
      ? `<div style="${FONT}font-size:26px;font-weight:500;letter-spacing:0.18em;color:${ink};">${escapeHtml(company.toUpperCase())}</div>`
      : "";
  const logoRow = logo ? `<tr><td style="padding:30px 28px 6px;text-align:center;">${logo}</td></tr>` : "";

  const cta = input.cta
    ? `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:26px 0 14px;"><tr>` +
      `<td align="center" bgcolor="${accent}" style="background:${accent};padding:17px 20px;"><a href="${escapeHtml(safeUrl(input.cta.url))}" style="display:block;color:#ffffff;text-decoration:none;${FONT}font-size:14px;font-weight:600;letter-spacing:0.12em;text-align:center;">${escapeHtml(input.cta.label.toUpperCase())}</a></td>` +
      `</tr></table>`
    : "";

  const benefit = input.benefit
    ? `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 18px;"><tr>` +
      `<td bgcolor="${DEFAULTS.tint}" style="background:${DEFAULTS.tint};border:1px solid ${DEFAULTS.tintLine};padding:12px 14px;text-align:center;${FONT}font-size:13px;line-height:1.5;color:${accent};">${escapeHtml(input.benefit)}</td>` +
      `</tr></table>`
    : "";

  const fallbackLink = input.cta
    ? `<p style="margin:0;color:${DEFAULTS.muted};font-size:12px;line-height:1.6;${FONT}word-break:break-all;">Se o botão não abrir, copie e cole este endereço no navegador: ${escapeHtml(safeUrl(input.cta.url))}</p>`
    : "";

  const unsubscribe = input.unsubscribeUrl
    ? `<p style="margin:10px 0 0;font-size:12px;line-height:1.6;color:#b5b5b5;"><a href="${escapeHtml(safeUrl(input.unsubscribeUrl))}" style="color:${DEFAULTS.nude};text-decoration:underline;">Cancelar inscrição</a></p>`
    : "";
  const footerNote = brand.footer_note
    ? `<p style="margin:10px 0 0;font-size:11px;line-height:1.6;color:#b5b5b5;">${escapeHtml(brand.footer_note)}</p>`
    : "";

  const preheader = input.preheader
    ? `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(input.preheader)}</span>`
    : "";

  const html =
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap" rel="stylesheet" />` +
    `<title>${escapeHtml(input.heading)}</title></head>` +
    `<body style="margin:0;background:${DEFAULTS.soft};">${preheader}` +
    `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${DEFAULTS.soft};padding:28px 12px;"><tr><td align="center">` +
    `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:620px;background:#ffffff;border:1px solid ${DEFAULTS.line};">` +
    strip +
    logoRow +
    `<tr><td style="padding:18px 28px 30px;${FONT}color:${ink};">` +
    `<h1 style="margin:0 0 14px;${FONT}font-size:26px;font-weight:500;line-height:1.2;letter-spacing:0.02em;text-align:center;color:${ink};">${escapeHtml(input.heading)}</h1>` +
    input.paragraphs.map(paragraphHtml).join("") +
    (input.items && input.items.length > 0 ? itemsHtml(input.items, input.total, ink) : "") +
    (input.coupon ? couponHtml(input.coupon, accent, ink) : "") +
    cta +
    benefit +
    fallbackLink +
    `</td></tr>` +
    `<tr><td bgcolor="${ink}" style="background:${ink};padding:22px 28px;text-align:center;${FONT}">` +
    (company
      ? `<p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.18em;color:${DEFAULTS.nude};">${escapeHtml(company.toUpperCase())}</p>`
      : "") +
    unsubscribe +
    footerNote +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`;

  // Plain-text alternative (also what spam filters and screen readers see).
  const lines: string[] = [input.heading, ""];
  for (const p of input.paragraphs) lines.push(p, "");
  if (input.items) {
    for (const i of input.items) {
      lines.push(`- ${i.name}${i.variant ? ` (${i.variant})` : ""} x${i.quantity}: ${i.price}`);
    }
    if (input.total) lines.push(`Total: ${input.total}`);
    lines.push("");
  }
  if (input.coupon) {
    lines.push(`${input.coupon.headline}: ${input.coupon.code}`);
    if (input.coupon.note) lines.push(input.coupon.note);
    lines.push("");
  }
  if (input.cta) lines.push(`${input.cta.label}: ${safeUrl(input.cta.url)}`, "");
  if (input.benefit) lines.push(input.benefit, "");
  if (input.unsubscribeUrl) lines.push(`Cancelar inscrição: ${safeUrl(input.unsubscribeUrl)}`);
  if (brand.footer_note) lines.push(brand.footer_note);

  return { html, text: lines.join("\n").trim() };
}
