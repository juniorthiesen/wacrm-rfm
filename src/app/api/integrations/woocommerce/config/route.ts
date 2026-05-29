import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import crypto from "crypto"

/**
 * CRUD for the user's WooCommerce integration row in `integration_configs`.
 *
 *   GET  /api/integrations/woocommerce/config
 *     Returns the current row (without leaking webhook_secret on the wire
 *     more than the auth'd user already has — RLS scopes by user_id).
 *
 *   PUT  /api/integrations/woocommerce/config
 *     Upserts the row. Body shape:
 *       {
 *         store_url: string,
 *         consumer_key?: string,
 *         consumer_secret?: string,
 *         webhook_secret?: string,    // omit to keep current
 *         regenerate_secret?: boolean, // true to mint a fresh one
 *         status: 'active' | 'inactive'
 *       }
 *
 *   DELETE /api/integrations/woocommerce/config
 *     Removes the row entirely.
 *
 * Why not store credentials encrypted yet:
 *   The repo already has AES-256-GCM helpers for WhatsApp tokens
 *   (lib/whatsapp/encryption.ts). When this integration starts being
 *   used to talk to the WC REST API in earnest, swap to encrypted
 *   columns the same way `whatsapp_config.access_token` does. For now
 *   the credentials live in the JSONB column behind RLS, which mirrors
 *   how WaCRM has shipped other integrations to date.
 */

interface ConfigPutBody {
  store_url?: string
  consumer_key?: string
  consumer_secret?: string
  webhook_secret?: string
  regenerate_secret?: boolean
  status?: "active" | "inactive"
}

interface Credentials {
  consumer_key?: string
  consumer_secret?: string
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data, error } = await supabase
    .from("integration_configs")
    .select("*")
    .eq("user_id", user.id)
    .eq("platform", "woocommerce")
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ config: data ?? null })
}

export async function PUT(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: ConfigPutBody
  try {
    body = (await request.json()) as ConfigPutBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (!body.store_url) {
    return NextResponse.json(
      { error: "store_url is required" },
      { status: 400 },
    )
  }
  // Strip trailing slashes so the eventual REST URL composer doesn't
  // produce `https://shop.com//wp-json/...`.
  const storeUrl = body.store_url.replace(/\/+$/, "")

  // Look up any current row so we can preserve unchanged credentials
  // (a partial PUT shouldn't blow away the consumer_key/secret if the
  // user only edited the status).
  const { data: existing } = await supabase
    .from("integration_configs")
    .select("*")
    .eq("user_id", user.id)
    .eq("platform", "woocommerce")
    .maybeSingle()

  const existingCreds = (existing?.credentials as Credentials | null) ?? {}
  const credentials: Credentials = {
    consumer_key: body.consumer_key ?? existingCreds.consumer_key,
    consumer_secret: body.consumer_secret ?? existingCreds.consumer_secret,
  }

  const webhookSecret = body.regenerate_secret
    ? crypto.randomBytes(32).toString("hex")
    : body.webhook_secret ?? existing?.webhook_secret ?? null

  const status = body.status ?? existing?.status ?? "inactive"

  const row = {
    user_id: user.id,
    platform: "woocommerce" as const,
    status,
    store_url: storeUrl,
    credentials,
    webhook_secret: webhookSecret,
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from("integration_configs")
    .upsert(row, { onConflict: "user_id,platform" })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ config: data })
}

export async function DELETE() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { error } = await supabase
    .from("integration_configs")
    .delete()
    .eq("user_id", user.id)
    .eq("platform", "woocommerce")

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
