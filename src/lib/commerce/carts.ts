import { normalizePhone } from "@/lib/integrations/phone-normalization";

/**
 * Pure helpers for the abandoned-cart webhook of the WooCommerce checkout
 * plugin (WC Smart Checkout, "Rishi" module). No I/O here: parsing and
 * formatting only, so the rules are unit-testable. The persistence and the
 * automation dispatch live in cart-ingestion.ts.
 *
 * What the plugin sends (modules/abandoned-carts/src/Webhook/Sender.php):
 * every 10 minutes, a JSON ARRAY with the carts whose status changed since the
 * last successful sync. No signature/header is possible, so the endpoint is
 * authenticated by a secret in the URL query (same as the other Woo hooks).
 *   { id, email, phone, first_name, last_name, cart_contents: [{ name, price,
 *     quantity, product_url, image_url, ... }], cart_total, currency,
 *     cart_url   ← recovery link: restores the cart and pre-fills the checkout,
 *     cart_token, checkout_url, cart_status: abandoned|recovered|converted|dismissed,
 *     reached_checkout, store_url, time }
 */

export type CartStatus = "abandoned" | "recovered" | "converted" | "dismissed";

export interface CartItem {
  name: string;
  quantity: number;
  price: number;
  product_url: string | null;
  image_url: string | null;
}

export interface NormalizedCart {
  externalId: string;
  email: string | null;
  /** Digits only, already normalized by normalizePhone. */
  phone: string | null;
  firstName: string;
  lastName: string;
  status: CartStatus;
  /** Recovery link (restores the cart). Always http(s). */
  cartUrl: string | null;
  items: CartItem[];
  total: number;
  currency: string;
  reachedCheckout: boolean;
}

export interface ParsedCarts {
  carts: NormalizedCart[];
  /** Entries dropped for being malformed (no id, no way to reach the person, bad URL). */
  rejected: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CARTS_PER_REQUEST = 200;
const MAX_ITEMS_PER_CART = 50;
const STATUSES: readonly CartStatus[] = ["abandoned", "recovered", "converted", "dismissed"];

function str(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function httpUrl(value: unknown): string | null {
  const raw = str(value, 2000);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Accepts the plugin's array (or `{ carts: [...] }` / a single object, which
 * is handy for manual tests) and returns normalized carts.
 *
 * `allowedHost` (the store URL configured in the integration): a recovery link
 * pointing anywhere else is dropped, so a leaked webhook secret cannot be used
 * to put arbitrary links into e-mails sent from the shop's domain.
 */
export function parseCartPayload(body: unknown, allowedHost?: string | null): ParsedCarts {
  const list: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { carts?: unknown }).carts)
      ? (body as { carts: unknown[] }).carts
      : body && typeof body === "object"
        ? [body]
        : [];

  const wantedHost = allowedHost ? hostOf(allowedHost.includes("://") ? allowedHost : `https://${allowedHost}`) : "";
  const carts: NormalizedCart[] = [];
  let rejected = 0;

  for (const entry of list.slice(0, MAX_CARTS_PER_REQUEST)) {
    if (!entry || typeof entry !== "object") {
      rejected++;
      continue;
    }
    const raw = entry as Record<string, unknown>;

    const externalId = typeof raw.id === "number" ? String(raw.id) : str(raw.id, 64);
    const emailRaw = str(raw.email, 254).toLowerCase();
    const email = EMAIL_RE.test(emailRaw) ? emailRaw : null;
    const phone = normalizePhone(str(raw.phone, 32) || null);
    if (!externalId || (!email && !phone)) {
      rejected++;
      continue;
    }

    const statusRaw = str(raw.cart_status, 20).toLowerCase() as CartStatus;
    const status: CartStatus = STATUSES.includes(statusRaw) ? statusRaw : "abandoned";

    const cartUrl = httpUrl(raw.cart_url);
    if (cartUrl && wantedHost && hostOf(cartUrl) !== wantedHost) {
      rejected++;
      continue;
    }

    const contents = Array.isArray(raw.cart_contents) ? raw.cart_contents : [];
    const items: CartItem[] = contents.slice(0, MAX_ITEMS_PER_CART).flatMap((c) => {
      if (!c || typeof c !== "object") return [];
      const it = c as Record<string, unknown>;
      const name = str(it.name, 160);
      if (!name) return [];
      return [
        {
          name,
          quantity: Math.max(1, Math.round(num(it.quantity)) || 1),
          price: num(it.price),
          product_url: httpUrl(it.product_url),
          image_url: httpUrl(it.image_url),
        },
      ];
    });

    carts.push({
      externalId,
      email,
      phone,
      firstName: str(raw.first_name ?? raw.name, 80),
      lastName: str(raw.last_name ?? raw.surname, 80),
      status,
      cartUrl,
      items,
      total: num(raw.cart_total),
      currency: str(raw.currency, 3).toUpperCase() || "BRL",
      reachedCheckout: raw.reached_checkout === true || raw.reached_checkout === 1 || raw.reached_checkout === "1",
    });
  }

  rejected += Math.max(0, list.length - MAX_CARTS_PER_REQUEST);
  return { carts, rejected };
}

/** "R$ 1.234,50" — fixed pt-BR format, independent of the server's ICU data. */
export function formatBRL(value: number): string {
  const cents = Math.round(value * 100);
  const reais = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${reais},${String(cents % 100).padStart(2, "0")}`;
}

/** Bullet list for an e-mail body: "▪️ Calcinha (Qtd: 2)". Capped like the order list. */
export function buildCartItemsList(items: CartItem[]): string {
  const MAX = 10;
  const lines = items.slice(0, MAX).map((i) => `▪️ ${i.name} (Qtd: ${i.quantity})`);
  if (items.length > MAX) lines.push(`... e mais ${items.length - MAX} item(s)`);
  return lines.join("\n");
}

/** Query-string part of a URL ("?a=b"), for Meta dynamic-URL buttons. */
export function urlSuffix(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).search;
  } catch {
    return "";
  }
}
