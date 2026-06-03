import { NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { recalculateUserRFM } from "@/lib/rfm/engine";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { ingestOrder } from "@/lib/commerce/order-ingestion";
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
//   - "enviado"    — Portuguese for "shipped"; alternative to "completed".
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
    case "completed":
    case "enviado":
      return "order_shipped";
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

    // 2. Read raw body and verify HMAC signature
    const rawBody = await request.text();
    const signature = request.headers.get("x-wc-webhook-signature");

    if (!signature) {
      // WC pings the delivery URL twice on webhook save WITHOUT a
      // signature (it's testing reachability, not behavior). Both
      // requests respond 401 — that's the contract — but the warning
      // pollutes the Vercel dashboard with two angry-looking entries
      // every time the operator edits the webhook in WP. Demote to
      // debug; real deliveries always include the header so a
      // missing one continues to be benign.
      console.debug("[woocommerce-webhook] Missing x-wc-webhook-signature header (likely a WP save-time ping)");
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }

    const computedSignature = crypto
      .createHmac("sha256", config.webhook_secret)
      .update(rawBody)
      .digest("base64");

    if (signature !== computedSignature) {
      console.warn("[woocommerce-webhook] Signature verification failed");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // 3. Parse payload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // 4. Normalize the WC payload and ingest the order. `ingestOrder`
    // handles contact match (phone → email → create), platform tag, and
    // status-transition detection. Same code path is reused by the
    // REST-API sync engine.
    const db = supabaseAdmin();

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
