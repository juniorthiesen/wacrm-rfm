import { NextResponse } from "next/server"
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { normalizePhone } from "@/lib/integrations/phone-normalization"
import { runAutomationsForTrigger } from "@/lib/automations/engine"

/**
 * Magic-login / quick-access webhook.
 *
 * Listens for the SmartCheckout (Loja5) password-recovery hook. The
 * payload is a plain JSON POST written from a WordPress / WC theme:
 *
 *   {
 *     "url": "https://shop.com/wc-api/smart-checkout/login/?uid=3&magic_login=ABC",
 *     "user": {
 *       "id": 3, "username": "junior thiesen",
 *       "email": "x@y", "phone": "41997063283", "first_name": "Junior"
 *     }
 *   }
 *
 * No HMAC signature is sent (the WC native webhook secret isn't shared
 * with theme-side hooks). To make the endpoint impersonation-resistant
 * we require a `?user_id=<UUID>&token=<secret>` pair where `token`
 * matches the `webhook_secret` saved in integration_configs for the
 * same user — the same secret the operator uses for the main
 * /woocommerce/webhook, just delivered in the query string instead of
 * a header.
 *
 * On success the route looks up (or creates) the contact by phone and
 * fires the `customer_magic_login_requested` automation trigger with
 * `magic_login.{url, suffix, uid, token}` and `customer.{name, ...}`
 * in the context — letting the operator wire a "Send Template" step
 * with a dynamic URL button suffix mapped to `{{magic_login.suffix}}`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface MagicLoginPayload {
  url?: string
  user?: {
    id?: number | string
    username?: string
    email?: string
    phone?: string
    first_name?: string
    last_name?: string
  }
}

/**
 * Split the full magic URL into a base + a suffix usable as a Meta
 * dynamic-URL button parameter. The split keeps everything up to and
 * including the LAST `/` before the query string in the base, so
 *
 *   https://shop.com/wc-api/smart-checkout/login/?uid=3&token=abc
 *
 * becomes
 *
 *   base   = https://shop.com/wc-api/smart-checkout/login/
 *   suffix = ?uid=3&token=abc
 *
 * which lines up with how Meta requires the base URL to be configured
 * in Business Manager. Returns null if the URL is malformed or has no
 * query string at all.
 */
function splitMagicUrl(
  raw: string,
): { base: string; suffix: string } | null {
  try {
    const u = new URL(raw)
    const base = `${u.origin}${u.pathname}`
    const suffix = u.search || ""
    if (!suffix) return null
    return { base, suffix }
  } catch {
    return null
  }
}

/**
 * Timing-safe shared-secret comparison. Falls back to false on any
 * length mismatch so an attacker can't time the response.
 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get("user_id")
    const token = searchParams.get("token")

    if (!userId) {
      return NextResponse.json(
        { error: "Missing user_id" },
        { status: 400 },
      )
    }
    if (!token) {
      return NextResponse.json(
        { error: "Missing token" },
        { status: 401 },
      )
    }

    const db = supabaseAdmin()

    const { data: config, error: configError } = await db
      .from("integration_configs")
      .select("*")
      .eq("user_id", userId)
      .eq("platform", "woocommerce")
      .maybeSingle()

    if (configError || !config) {
      return NextResponse.json(
        { error: "Configuration not found" },
        { status: 404 },
      )
    }
    if (config.status !== "active") {
      return NextResponse.json(
        { error: "Integration inactive" },
        { status: 400 },
      )
    }
    if (!config.webhook_secret || !safeEqual(config.webhook_secret, token)) {
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401 },
      )
    }

    let payload: MagicLoginPayload
    try {
      payload = (await request.json()) as MagicLoginPayload
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
    }

    const rawUrl = payload.url ?? ""
    const phone = normalizePhone(payload.user?.phone ?? null)
    if (!phone) {
      return NextResponse.json(
        { error: "Customer phone missing or invalid" },
        { status: 400 },
      )
    }
    if (!rawUrl) {
      return NextResponse.json(
        { error: "Magic-login URL missing" },
        { status: 400 },
      )
    }

    // Find or create the contact — same shape as the order webhook so
    // both surfaces produce one canonical contact row.
    let contactId: string | null = null
    {
      const { data: existing } = await db
        .from("contacts")
        .select("id")
        .eq("user_id", userId)
        .eq("phone", phone)
        .maybeSingle()
      if (existing?.id) {
        contactId = existing.id as string
      } else {
        const firstName = payload.user?.first_name ?? ""
        const lastName = payload.user?.last_name ?? ""
        const fullName =
          `${firstName} ${lastName}`.trim() ||
          payload.user?.username ||
          "Magic Login Customer"
        const { data: created, error: insertErr } = await db
          .from("contacts")
          .insert({
            user_id: userId,
            phone,
            name: fullName,
            email: payload.user?.email ?? null,
          })
          .select("id")
          .single()
        if (insertErr) {
          console.error("[magic-login] contact create failed:", insertErr)
        } else {
          contactId = (created?.id as string) ?? null
        }
      }
    }

    // Parse the URL into base + suffix; expose both plus the query
    // params individually for templates that don't use the dynamic-URL
    // button shape (e.g. a plain text body referring to the full link).
    const split = splitMagicUrl(rawUrl)
    const parsedUrl = split ? new URL(rawUrl) : null
    const uid = parsedUrl?.searchParams.get("uid") ?? ""
    const tokenParam =
      parsedUrl?.searchParams.get("magic_login") ?? ""

    const firstName = payload.user?.first_name ?? ""
    const lastName = payload.user?.last_name ?? ""
    const customerName =
      `${firstName} ${lastName}`.trim() ||
      payload.user?.username ||
      "Cliente"

    try {
      await runAutomationsForTrigger({
        userId,
        triggerType: "customer_magic_login_requested",
        contactId,
        context: {
          magic_login: {
            url: rawUrl,
            suffix: split?.suffix ?? "",
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
      })
    } catch (err) {
      console.error("[magic-login] automation dispatch failed:", err)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[magic-login] unexpected error:", err)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    )
  }
}
