import { NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { recalculateUserRFM } from "@/lib/rfm/engine";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { ingestOrder } from "@/lib/commerce/order-ingestion";
import { extractBirthdayRaw } from "@/lib/commerce/birthday";
import { normalizePhone } from "@/lib/integrations/phone-normalization";
import type { AutomationTriggerType } from "@/types";

// Map the WooCommerce order status to our automation trigger type.
// We only fire on **status transitions** (i.e. status changed from
// previous value), so users don't get spammed when WC sends repeated
// upserts for the same order.
//
// Standard WC lifecycle: pending → processing → completed
// Brazilian e-commerce often customises the slugs:
//   - "separacao"  — picking / order being prepared (between paid and
//                    shipped). Common on Loja5 and similar themes.
//   - "enviado"    — Portuguese for "shipped" → order_shipped.
//   - "completed"  — order finished/delivered → order_completed, a
//                    DISTINCT event from "enviado". They used to share
//                    order_shipped, which double-fired the "shipped"
//                    message when an order moved enviado → completed.
//                    Kept separate so completed can drive post-sale
//                    (e.g. a review request) without re-sending "shipped".
//   - "on-hold"    — WC standard, used by PIX/boleto gateways while
//                    waiting for the bank confirmation. Behaviourally
//                    identical to "pending" for our purposes (the
//                    customer needs the PIX code now).
//
// Statuses NOT in this map intentionally don't fire any trigger.
function statusToTrigger(status: string): AutomationTriggerType | null {
  switch (status) {
    case "pending":
    case "on-hold":
      return "order_received";
    case "processing":
      return "order_paid";
    case "separacao":
      return "order_in_separation";
    case "enviado":
      return "order_shipped";
    case "completed":
      return "order_completed";
    case "cancelled":
      return "order_cancelled";
    case "refunded":
      return "order_refunded";
    case "failed":
      return "order_failed";
    default:
      return null;
  }
}

// Common meta_data keys used by Brazilian PIX gateways. Each plugin
// stores the copy-paste payload under a different key, so we probe
// them in priority order and return the first non-empty value.
//
// Sources observed in the wild:
//   - pix_copiar_colar              — generic / theme-installed
//   - _dados_cielo_api_pix_qrcode   — Cielo official plugin
//   - _pix_copy_and_paste           — Loja5 theme
//   - woo_pix_code                  — Pix for WooCommerce free plugin
//   - efi_pix_copy_and_paste        — Efí (formerly Gerencianet)
const PIX_META_KEYS = [
  "pix_copiar_colar",
  "_dados_cielo_api_pix_qrcode",
  "_pix_copy_and_paste",
  "woo_pix_code",
  "efi_pix_copy_and_paste",
] as const;

// Tracking code keys vary by carrier plugin. Order matters — the more
// specific keys are checked first so a generic `_tracking_code` won't
// mask a Correios-specific value.
const TRACKING_META_KEYS = [
  "_tracking_code",
  "tracking_code",
  "correios_tracking",
  "_tracking_number",
  "tracking_number",
] as const;

interface WooMetaItem {
  key?: string;
  value?: unknown;
}

interface MagicLoginPayload {
  url?: string;
  user?: {
    id?: number | string;
    username?: string;
    email?: string;
    phone?: string;
    first_name?: string;
    last_name?: string;
  };
}

/**
 * Funnelkit / BuildwooFunnels Cart Abandonment Recovery posts either
 * multipart/form-data or application/x-www-form-urlencoded — both
 * parsed identically by request.formData(). Field names vary slightly
 * between plugin versions (`phone` vs `phone_number`), so we probe
 * each candidate. Empty strings are returned verbatim so the caller
 * can detect a phoneless cart (common in early-funnel abandonment
 * where the customer hasn't typed a phone yet) and skip cleanly.
 */
interface CartAbandonedFields {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  order_status: string;
  checkout_url: string;
  coupon_code: string;
  product_names: string;
  cart_total: string;
}

function readField(form: FormData, ...candidates: string[]): string {
  for (const key of candidates) {
    const v = form.get(key);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function parseCartAbandonedForm(form: FormData): CartAbandonedFields {
  return {
    first_name: readField(form, "first_name"),
    last_name: readField(form, "last_name"),
    email: readField(form, "email"),
    phone: readField(form, "phone", "phone_number"),
    order_status: readField(form, "order_status"),
    checkout_url: readField(form, "checkout_url"),
    coupon_code: readField(form, "coupon_code"),
    product_names: readField(form, "product_names"),
    cart_total: readField(form, "cart_total"),
  };
}

/**
 * Handle the SmartCheckout / Loja5 magic-login event. Splits the magic
 * URL into a base + query suffix (Meta's dynamic-URL button shape),
 * upserts the contact by phone, and fires
 * `customer_magic_login_requested` with magic_login.{url, suffix, uid,
 * token} + customer.{...} in the context.
 *
 * Returns a `{ status, body }` envelope so the route handler can wrap
 * it in NextResponse without each branch having to know about it.
 */
async function handleMagicLogin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  userId: string,
  payload: MagicLoginPayload,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const rawUrl = payload.url ?? "";
  const phone = normalizePhone(payload.user?.phone ?? null);
  if (!phone) {
    return { status: 400, body: { error: "Customer phone missing or invalid" } };
  }
  if (!rawUrl) {
    return { status: 400, body: { error: "Magic-login URL missing" } };
  }

  // Parse the URL into base + suffix; expose the query params individually
  // for templates that don't use the dynamic-URL button shape.
  let parsedUrl: URL | null = null;
  let suffix = "";
  try {
    parsedUrl = new URL(rawUrl);
    suffix = parsedUrl.search || "";
  } catch {
    parsedUrl = null;
  }
  const uid = parsedUrl?.searchParams.get("uid") ?? "";
  const tokenParam = parsedUrl?.searchParams.get("magic_login") ?? "";

  // Find or create the contact — same shape as the order ingest path.
  let contactId: string | null = null;
  const { data: existing } = await db
    .from("contacts")
    .select("id")
    .eq("user_id", userId)
    .eq("phone", phone)
    .maybeSingle();
  if (existing?.id) {
    contactId = existing.id as string;
  } else {
    const firstName = payload.user?.first_name ?? "";
    const lastName = payload.user?.last_name ?? "";
    const fullName =
      `${firstName} ${lastName}`.trim() ||
      payload.user?.username ||
      "Magic Login Customer";
    const { data: created, error: insertErr } = await db
      .from("contacts")
      .insert({
        user_id: userId,
        phone,
        name: fullName,
        email: payload.user?.email ?? null,
      })
      .select("id")
      .single();
    if (insertErr) {
      console.error("[woocommerce-webhook] magic-login contact create failed:", insertErr);
    } else {
      contactId = (created?.id as string) ?? null;
    }
  }

  const firstName = payload.user?.first_name ?? "";
  const lastName = payload.user?.last_name ?? "";
  const customerName =
    `${firstName} ${lastName}`.trim() ||
    payload.user?.username ||
    "Cliente";

  try {
    await runAutomationsForTrigger({
      userId,
      triggerType: "customer_magic_login_requested",
      contactId,
      context: {
        magic_login: {
          url: rawUrl,
          suffix,
          uid,
          token: tokenParam,
        },
        customer: {
          name: customerName,
          first_name: firstName,
          last_name: lastName,
          phone,
          email: payload.user?.email ?? undefined,
        },
      },
    });
  } catch (err) {
    console.error("[woocommerce-webhook] magic-login dispatch failed:", err);
  }

  return { status: 200, body: { success: true, event: "magic_login" } };
}

/**
 * Split a checkout URL into base + suffix, mirroring the magic-login
 * shape so the same template machinery (Meta dynamic-URL button) just
 * works.
 */
function splitUrlForButton(raw: string): { base: string; suffix: string } {
  try {
    const u = new URL(raw);
    return {
      base: `${u.origin}${u.pathname}`,
      suffix: u.search || "",
    };
  } catch {
    return { base: "", suffix: "" };
  }
}

/**
 * Handle a Funnelkit / BuildwooFunnels cart-abandoned event. Phone is
 * optional in early-funnel abandonment — when missing, we ack the
 * webhook (so the plugin doesn't retry) but skip the automation since
 * WhatsApp delivery isn't possible without it.
 */
async function handleCartAbandoned(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  userId: string,
  fields: CartAbandonedFields,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const phone = normalizePhone(fields.phone);
  if (!phone) {
    console.info(
      "[woocommerce-webhook] cart_abandoned skipped — no phone in payload",
    );
    return {
      status: 200,
      body: { success: true, event: "cart_abandoned", skipped: "no-phone" },
    };
  }
  if (!fields.checkout_url) {
    return {
      status: 400,
      body: { error: "Cart abandoned payload missing checkout_url" },
    };
  }

  // Find or create the contact — same shape as the order ingest path.
  let contactId: string | null = null;
  const { data: existing } = await db
    .from("contacts")
    .select("id")
    .eq("user_id", userId)
    .eq("phone", phone)
    .maybeSingle();
  if (existing?.id) {
    contactId = existing.id as string;
  } else {
    const fullName =
      `${fields.first_name} ${fields.last_name}`.trim() ||
      fields.email ||
      "Cliente";
    const { data: created, error: insertErr } = await db
      .from("contacts")
      .insert({
        user_id: userId,
        phone,
        name: fullName,
        email: fields.email || null,
      })
      .select("id")
      .single();
    if (insertErr) {
      console.error(
        "[woocommerce-webhook] cart_abandoned contact create failed:",
        insertErr,
      );
    } else {
      contactId = (created?.id as string) ?? null;
    }
  }

  const split = splitUrlForButton(fields.checkout_url);
  const customerName =
    `${fields.first_name} ${fields.last_name}`.trim() ||
    fields.email ||
    "Cliente";

  try {
    await runAutomationsForTrigger({
      userId,
      triggerType: "cart_abandoned",
      contactId,
      context: {
        cart: {
          checkout_url: fields.checkout_url,
          checkout_url_suffix: split.suffix,
          coupon_code: fields.coupon_code,
          total: fields.cart_total,
          product_names: fields.product_names,
        },
        customer: {
          name: customerName,
          first_name: fields.first_name,
          last_name: fields.last_name,
          phone,
          email: fields.email || undefined,
        },
      },
    });
  } catch (err) {
    console.error("[woocommerce-webhook] cart_abandoned dispatch failed:", err);
  }

  return { status: 200, body: { success: true, event: "cart_abandoned" } };
}

/**
 * Walk an array of WooCommerce meta_data entries and return the first
 * non-empty value whose key matches one of `candidateKeys`. WC meta
 * values can be strings, numbers, arrays, or serialised objects; we
 * coerce to string and skip blanks.
 */
function findMetaValue(
  metaData: WooMetaItem[] | undefined,
  candidateKeys: readonly string[]
): string | null {
  if (!Array.isArray(metaData)) return null;
  const lookup = new Set(candidateKeys);
  for (const entry of metaData) {
    if (!entry?.key || !lookup.has(entry.key)) continue;
    const v = entry.value;
    if (v == null) continue;
    const s = typeof v === "string" ? v : String(v);
    if (s.trim().length > 0) return s;
  }
  return null;
}

interface WooLineItem {
  name?: string;
  quantity?: number;
}

/**
 * Render the order's items as a multi-line bullet list suitable for
 * dropping into a template variable. Truncated at 10 items + "...
 * e mais N item(s)" to keep us under the typical 1024-char variable
 * limit Meta enforces.
 */
function buildItemsList(items: WooLineItem[] | undefined): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  const MAX = 10;
  const visible = items.slice(0, MAX);
  const lines = visible.map((it) => {
    const name = (it.name ?? "Item").trim();
    const qty = it.quantity ?? 1;
    return `▪️ ${name} (Qtd: ${qty})`;
  });
  if (items.length > MAX) {
    lines.push(`... e mais ${items.length - MAX} item(s)`);
  }
  return lines.join("\n");
}

// Lazy-initialized admin client to bypass RLS policies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("user_id");

    if (!userId) {
      console.error("[woocommerce-webhook] Missing user_id query parameter");
      return NextResponse.json({ error: "Missing user_id" }, { status: 400 });
    }

    // 0. Rate-limit per-store. Generous enough for a Black Friday
    // burst, capped so a misbehaving WC instance can't flood our Meta
    // send budget. WC retries on 429 with backoff so we never lose
    // events to throttling.
    const limit = checkRateLimit(`wc-webhook:${userId}`, RATE_LIMITS.webhook);
    if (!limit.success) return rateLimitResponse(limit);

    // 1. Fetch integration config to get webhook_secret
    const { data: config, error: configError } = await supabaseAdmin()
      .from("integration_configs")
      .select("*")
      .eq("user_id", userId)
      .eq("platform", "woocommerce")
      .maybeSingle();

    if (configError || !config) {
      console.error("[woocommerce-webhook] Configuration not found for user:", userId, configError);
      return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
    }

    if (config.status !== "active") {
      console.warn("[woocommerce-webhook] Integration is inactive for user:", userId);
      return NextResponse.json({ error: "Integration inactive" }, { status: 400 });
    }

    // Refuse to operate without a configured secret. Earlier behavior
    // silently skipped HMAC verification when webhook_secret was null,
    // meaning anyone who guessed a valid user_id could fire fake
    // webhooks and burn the operator's Meta send quota. PUT /config
    // also blocks `status='active'` without a secret as defense in
    // depth — this is the runtime guard.
    if (!config.webhook_secret) {
      console.error(
        "[woocommerce-webhook] No webhook_secret configured for user:",
        userId,
      );
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 401 },
      );
    }

    // 2a. Form-data branch — third-party WC plugins (Funnelkit /
    // BuildwooFunnels Cart Abandonment Recovery) deliver as either
    // multipart/form-data or application/x-www-form-urlencoded. They
    // can't sign with HMAC, so this branch requires `?token=` auth.
    // Detected by Content-Type so we don't consume the request body
    // twice (request.text() would block request.formData()).
    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    const isFormSubmission =
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded");

    if (isFormSubmission) {
      const tokenQ = searchParams.get("token");
      if (!tokenQ) {
        return NextResponse.json(
          { error: "Missing token (form-data webhooks require ?token=)" },
          { status: 401 },
        );
      }
      const tBuf = Buffer.from(tokenQ);
      const sBuf = Buffer.from(config.webhook_secret);
      const ok = tBuf.length === sBuf.length && crypto.timingSafeEqual(tBuf, sBuf);
      if (!ok) {
        console.warn("[woocommerce-webhook] Token query auth failed (form)");
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
      }

      const form = await request.formData();
      const fields = parseCartAbandonedForm(form);

      if (fields.order_status === "abandoned") {
        const r = await handleCartAbandoned(supabaseAdmin(), userId, fields);
        return NextResponse.json(r.body, { status: r.status });
      }

      // Unknown form event — ack so the plugin doesn't retry, but log so
      // an operator can add a new handler. Includes the field names so
      // we don't need a body dump to identify the source.
      console.warn(
        "[woocommerce-webhook] Unknown form-data event",
        Array.from(form.keys()),
      );
      return NextResponse.json(
        { success: true, event: "unknown", fields: Array.from(form.keys()) },
        { status: 200 },
      );
    }

    // 2. Read raw body and authenticate the request. Two paths:
    //
    //    a) HMAC via `x-wc-webhook-signature` header — used by WC's
    //       native webhook UI (Settings → Advanced → Webhooks).
    //    b) Shared secret via `?token=` query string — used by
    //       theme-side `wp_remote_post` hooks (SmartCheckout / Loja5
    //       magic login, custom theme events) that can't easily sign
    //       with HMAC. Same `webhook_secret` value, just transported
    //       differently. Both paths compare in constant time.
    //
    //    Either header OR query token is enough. Real WC deliveries
    //    always send the header, so the token fallback only matters
    //    for the custom-theme path.
    const rawBody = await request.text();
    const signature = request.headers.get("x-wc-webhook-signature");
    const tokenQuery = searchParams.get("token");

    if (signature) {
      const computedSignature = crypto
        .createHmac("sha256", config.webhook_secret)
        .update(rawBody)
        .digest("base64");
      // Use timingSafeEqual to avoid leaking the secret via response-
      // time analysis. Length mismatch falls through to the !== check.
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(computedSignature);
      const ok =
        sigBuf.length === expBuf.length &&
        crypto.timingSafeEqual(sigBuf, expBuf);
      if (!ok) {
        console.warn("[woocommerce-webhook] HMAC signature verification failed");
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } else if (tokenQuery) {
      const t = Buffer.from(tokenQuery);
      const s = Buffer.from(config.webhook_secret);
      const ok = t.length === s.length && crypto.timingSafeEqual(t, s);
      if (!ok) {
        console.warn("[woocommerce-webhook] Token query auth failed");
        return NextResponse.json({ error: "Invalid token" }, { status: 401 });
      }
    } else {
      // WC pings the delivery URL twice on webhook save WITHOUT a
      // signature or token (it's testing reachability, not behavior).
      // Both requests respond 401 — that's the contract — but demote
      // to debug so the Vercel dashboard doesn't show two angry-
      // looking warnings every time the operator edits the webhook.
      console.debug("[woocommerce-webhook] No signature/token (likely a WP save-time ping)");
      return NextResponse.json(
        { error: "Missing signature or token" },
        { status: 401 },
      );
    }

    // 3. Parse payload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const db = supabaseAdmin();

    // 4. Detect payload shape and dispatch. WC's native webhook always
    // sends an order object with `id` + `status` at the top level.
    // Custom theme hooks (e.g. SmartCheckout / Loja5 magic-login) post
    // their own payload — currently `{ url, user }`. Routing by shape
    // lets the operator use ONE delivery URL for every WC-side hook
    // instead of one per event type.
    if (
      typeof payload.url === "string" &&
      payload.user &&
      typeof payload.user === "object" &&
      payload.id == null
    ) {
      const r = await handleMagicLogin(db, userId, payload);
      return NextResponse.json(r.body, { status: r.status });
    }

    // 5. Normalize the WC payload and ingest the order. `ingestOrder`
    // handles contact match (phone → email → create), platform tag, and
    // status-transition detection. Same code path is reused by the
    // REST-API sync engine.
    const externalOrderId = payload.id?.toString();
    if (!externalOrderId) {
      return NextResponse.json({ error: "Missing order ID in payload" }, { status: 400 });
    }

    const orderNumber = payload.number?.toString() || externalOrderId;
    const status = payload.status || "pending";
    const totalAmount = parseFloat(payload.total || "0");
    const currency = payload.currency || "BRL";
    const orderedAt = payload.date_created_gmt
      ? new Date(payload.date_created_gmt + "Z").toISOString()
      : new Date().toISOString();
    const rawPhone = payload.billing?.phone || payload.shipping?.phone || null;
    const email = payload.billing?.email || null;

    let ingestResult;
    try {
      ingestResult = await ingestOrder(db, userId, {
        external_order_id: externalOrderId,
        order_number: orderNumber,
        status,
        total_amount: totalAmount,
        currency,
        ordered_at: orderedAt,
        customer: {
          first_name:
            payload.billing?.first_name || payload.shipping?.first_name || null,
          last_name:
            payload.billing?.last_name || payload.shipping?.last_name || null,
          phone_raw: rawPhone,
          email,
          birthday: extractBirthdayRaw(payload.billing, payload.meta_data),
        },
        line_items_raw: payload.line_items,
        platform: "woocommerce",
      });
    } catch (err) {
      console.error("[woocommerce-webhook] Failed to ingest order:", err);
      return NextResponse.json({ error: "Failed to save order" }, { status: 500 });
    }

    const { contactId, statusChanged } = ingestResult;
    const normalizedPhone = normalizePhone(rawPhone);

    // 6. Trigger RFM Engine recalculation in the background
    void recalculateUserRFM(db, userId);

    // 7. Fire the matching automation trigger ONLY on a real status
    // transition (not on every upsert WooCommerce sends). The automation
    // engine looks up active automations whose trigger_type matches and
    // runs their steps — typically a `send_template` to dispatch the
    // approved Utility HSM to the customer.
    //
    // Awaited (not fire-and-forget) for the same reason as the WhatsApp
    // webhook: Vercel serverless freezes the Lambda the moment we return,
    // and a detached promise would never finish.
    if (statusChanged) {
      const triggerType = statusToTrigger(status);
      if (triggerType) {
        const firstName =
          payload.billing?.first_name || payload.shipping?.first_name || "";
        const lastName =
          payload.billing?.last_name || payload.shipping?.last_name || "";
        const customerName =
          `${firstName} ${lastName}`.trim() || "Cliente";

        // Tracking, PIX, and items list — each from a different part of
        // the WC payload. Empty string fallbacks ensure template
        // interpolation never renders 'undefined' to the customer.
        const trackingCode =
          (payload.shipment_tracking?.[0]?.tracking_number as string | undefined) ||
          findMetaValue(payload.meta_data as WooMetaItem[], TRACKING_META_KEYS) ||
          "";

        const pixCode =
          findMetaValue(payload.meta_data as WooMetaItem[], PIX_META_KEYS) || "";

        // "pending"/"on-hold" isn't exclusive to PIX — boleto and even
        // card payments transit through it momentarily — but the only
        // automation wired to `order_received` today sends the PIX
        // Copia-e-Cola template (see migration
        // 023_seed_woo_order_notifications.sql). Without a PIX code
        // there's nothing to interpolate into that template's required
        // {{3}} variable, so skip the dispatch rather than send a
        // message with a blank PIX section.
        if (triggerType === "order_received" && !pixCode) {
          console.info(
            "[woocommerce-webhook] order_received skipped — no PIX code in payload (status=%s, order=%s)",
            status,
            externalOrderId,
          );
          return NextResponse.json({ success: true, order_id: externalOrderId });
        }

        const itemsList = buildItemsList(payload.line_items as WooLineItem[]);

        try {
          await runAutomationsForTrigger({
            userId,
            triggerType,
            contactId: contactId ?? null,
            context: {
              order: {
                number: orderNumber,
                total: totalAmount,
                currency,
                status,
                tracking_code: trackingCode,
                pix_code: pixCode,
                items_list: itemsList,
                platform: "woocommerce",
              },
              customer: {
                name: customerName,
                first_name: firstName,
                last_name: lastName,
                phone: normalizedPhone ?? undefined,
                email: email ?? undefined,
              },
            },
          });
        } catch (err) {
          // runAutomationsForTrigger contracts to never throw, but
          // defense in depth — never let an automation failure
          // surface as a 5xx to WooCommerce (which would retry).
          console.error(
            "[woocommerce-webhook] Automation dispatch failed:",
            err
          );
        }
      }
    }

    return NextResponse.json({ success: true, order_id: externalOrderId });
  } catch (error) {
    console.error("[woocommerce-webhook] Error processing webhook request:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
