import { NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/integrations/phone-normalization";
import { recalculateUserRFM } from "@/lib/rfm/engine";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
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

    if (config.webhook_secret) {
      const computedSignature = crypto
        .createHmac("sha256", config.webhook_secret)
        .update(rawBody)
        .digest("base64");

      if (signature !== computedSignature) {
        console.warn("[woocommerce-webhook] Signature verification failed");
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    }

    // 3. Parse payload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Extract customer phone and email
    const rawPhone = payload.billing?.phone || payload.shipping?.phone || null;
    const normalizedPhone = normalizePhone(rawPhone);
    const email = payload.billing?.email || null;

    if (!normalizedPhone && !email) {
      console.warn("[woocommerce-webhook] Order contains neither valid phone nor email");
    }

    // 4. Find or create WACRM contact
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let contact: any = null;
    const db = supabaseAdmin();

    if (normalizedPhone) {
      const { data } = await db
        .from("contacts")
        .select("*")
        .eq("user_id", userId)
        .eq("phone", normalizedPhone)
        .maybeSingle();
      contact = data;
    }

    if (!contact && email) {
      const { data } = await db
        .from("contacts")
        .select("*")
        .eq("user_id", userId)
        .eq("email", email)
        .limit(1);
      if (data && data.length > 0) {
        contact = data[0];
      }
    }

    if (!contact && (normalizedPhone || email)) {
      const firstName = payload.billing?.first_name || payload.shipping?.first_name || "";
      const lastName = payload.billing?.last_name || payload.shipping?.last_name || "";
      const fullName = `${firstName} ${lastName}`.trim() || "WooCommerce Customer";

      // contacts.phone is NOT NULL in the database schema.
      // If the customer didn't provide a phone, generate a placeholder value to avoid INSERT constraint failure.
      const phoneValue = normalizedPhone || `woo_${email?.replace(/[^a-zA-Z0-9]/g, "") || Math.floor(Math.random() * 1000000)}`;

      const { data, error: insertError } = await db
        .from("contacts")
        .insert({
          user_id: userId,
          phone: phoneValue,
          name: fullName,
          email: email,
        })
        .select()
        .single();

      if (insertError) {
        console.error("[woocommerce-webhook] Failed to create contact:", insertError);
      } else {
        contact = data;

        // Assign WooCommerce tag to the new contact
        if (contact) {
          let tagId = null;
          const { data: existingTag } = await db
            .from("tags")
            .select("id")
            .eq("user_id", userId)
            .eq("name", "WooCommerce")
            .maybeSingle();

          if (existingTag) {
            tagId = existingTag.id;
          } else {
            const { data: newTag } = await db
              .from("tags")
              .insert({ user_id: userId, name: "WooCommerce", color: "#96588a" })
              .select()
              .single();
            tagId = newTag?.id;
          }

          if (tagId) {
            await db
              .from("contact_tags")
              .insert({ contact_id: contact.id, tag_id: tagId });
          }
        }
      }
    }

    // 5. Upsert Order
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

    // Look up the previous order row (if any) BEFORE the upsert, so we
    // can detect a status transition. Without this we'd fire the same
    // trigger every time WC re-sends a webhook for the same order (it
    // re-sends on every minor edit), spamming the customer.
    const { data: previousOrder } = await db
      .from("orders")
      .select("status")
      .eq("user_id", userId)
      .eq("platform", "woocommerce")
      .eq("external_order_id", externalOrderId)
      .maybeSingle();

    const previousStatus = previousOrder?.status ?? null;
    const statusChanged = previousStatus !== status;

    const { error: orderError } = await db
      .from("orders")
      .upsert({
        user_id: userId,
        contact_id: contact?.id || null,
        external_order_id: externalOrderId,
        order_number: orderNumber,
        platform: "woocommerce",
        status: status,
        total_amount: totalAmount,
        currency: currency,
        customer_email: email,
        customer_phone: normalizedPhone,
        ordered_at: orderedAt,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "user_id,platform,external_order_id"
      });

    if (orderError) {
      console.error("[woocommerce-webhook] Failed to upsert order:", orderError);
      return NextResponse.json({ error: "Failed to save order" }, { status: 500 });
    }

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
          `${firstName} ${lastName}`.trim() ||
          contact?.name ||
          "Cliente";

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
            contactId: contact?.id ?? null,
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
