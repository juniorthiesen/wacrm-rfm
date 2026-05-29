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
// upserts for the same order. Statuses outside this map (e.g. "on-hold",
// custom plugin statuses) intentionally don't fire any trigger.
//
// WC's standard lifecycle: pending → processing → completed
//   - pending     → awaiting payment ("Pedido Recebido")
//   - processing  → payment confirmed ("Pagamento Aprovado")
//   - completed   → order fulfilled / shipped ("Pedido Enviado")
//   - cancelled / refunded / failed → side branches
function statusToTrigger(status: string): AutomationTriggerType | null {
  switch (status) {
    case "pending":
      return "order_received";
    case "processing":
      return "order_paid";
    case "completed":
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
      console.warn("[woocommerce-webhook] Missing x-wc-webhook-signature header");
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

        // Tracking codes can live in several plugin-specific places on
        // the order — try the common ones, fall back to empty string so
        // template interpolation never renders 'undefined'.
        const trackingCode =
          payload.shipment_tracking?.[0]?.tracking_number ||
          payload.meta_data?.find(
            (m: { key?: string; value?: unknown }) =>
              m.key === "_tracking_number" || m.key === "tracking_number"
          )?.value ||
          "";

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
                tracking_code: String(trackingCode),
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
