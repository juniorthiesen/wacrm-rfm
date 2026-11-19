import { NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { ingestCartWebhook } from "@/lib/commerce/cart-webhook";

/**
 * Abandoned-cart webhook of the WooCommerce checkout plugin (WC Smart Checkout,
 * "Rishi" module). Configure the plugin's webhook URL as:
 *
 *   https://<wacrm>/api/integrations/woocommerce/carts?user_id=<uuid>&token=<webhook_secret>
 *
 * The plugin POSTs a JSON array every 10 minutes with the carts whose status
 * changed, and treats any non-2xx as "not delivered" (it resends the batch on
 * the next run). It cannot sign requests, so the shared secret travels in the
 * query string, exactly like the other Woo hooks of this app (the secret is the
 * integration's `webhook_secret`).
 *
 * Everything below is idempotent, so answering 500 on a partial failure is safe:
 * the retry will not start a sequence twice (see cart-ingestion.ts).
 */

export const maxDuration = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null;
function supabaseAdmin() {
  if (!_admin) {
    _admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  }
  return _admin;
}

function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("user_id");
    const token = searchParams.get("token");

    if (!userId) return NextResponse.json({ error: "Missing user_id" }, { status: 400 });
    if (!token) return NextResponse.json({ error: "Missing token" }, { status: 401 });

    const limit = checkRateLimit(`wc-carts:${userId}`, RATE_LIMITS.webhook);
    if (!limit.success) return rateLimitResponse(limit);

    const db = supabaseAdmin();
    const { data: config, error: configError } = await db
      .from("integration_configs")
      .select("status, webhook_secret, store_url")
      .eq("user_id", userId)
      .eq("platform", "woocommerce")
      .maybeSingle();

    if (configError || !config) return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
    if (config.status !== "active") return NextResponse.json({ error: "Integration inactive" }, { status: 400 });
    if (!config.webhook_secret) return NextResponse.json({ error: "Webhook secret not configured" }, { status: 401 });
    if (!secretsMatch(token, config.webhook_secret)) {
      console.warn("[woocommerce-carts] token mismatch");
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const result = await ingestCartWebhook(db, userId, config.store_url, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[woocommerce-carts] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
