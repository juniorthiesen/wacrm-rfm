import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

/**
 * Sanity-check the saved WooCommerce credentials by hitting the
 * "system_status" endpoint, which exists on every WC install since 3.0
 * and requires read auth — a lightweight liveness probe.
 *
 *   GET https://{store}/wp-json/wc/v3/system_status?_fields=settings
 *     Authorization: Basic base64(consumer_key:consumer_secret)
 *
 * Returns:
 *   200 — { ok: true, version, currency }
 *   4xx — { ok: false, status, error }
 */
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: config, error: configError } = await supabase
    .from("integration_configs")
    .select("*")
    .eq("user_id", user.id)
    .eq("platform", "woocommerce")
    .maybeSingle()

  if (configError) {
    return NextResponse.json({ error: configError.message }, { status: 500 })
  }
  if (!config) {
    return NextResponse.json(
      { ok: false, error: "No WooCommerce config saved yet." },
      { status: 400 },
    )
  }
  const creds = (config.credentials ?? {}) as {
    consumer_key?: string
    consumer_secret?: string
  }
  if (!creds.consumer_key || !creds.consumer_secret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Consumer key / secret missing. Add them in Settings → WooCommerce.",
      },
      { status: 400 },
    )
  }
  if (!config.store_url) {
    return NextResponse.json(
      { ok: false, error: "Store URL not set." },
      { status: 400 },
    )
  }

  const authHeader =
    "Basic " +
    Buffer.from(`${creds.consumer_key}:${creds.consumer_secret}`).toString(
      "base64",
    )
  const url = `${config.store_url.replace(/\/+$/, "")}/wp-json/wc/v3/system_status?_fields=environment`

  try {
    const res = await fetch(url, {
      headers: { Authorization: authHeader, Accept: "application/json" },
      // Don't let a slow shop block the user — WP can be very slow on
      // shared hosting and we just want a yes/no.
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const j = await res.json()
        if (j?.message) detail = `${detail} — ${j.message}`
      } catch {
        // body wasn't JSON
      }
      return NextResponse.json(
        { ok: false, status: res.status, error: detail },
        { status: 200 },
      )
    }
    const data = (await res.json()) as {
      environment?: { version?: string; default_timezone?: string }
    }
    return NextResponse.json({
      ok: true,
      version: data.environment?.version ?? null,
      timezone: data.environment?.default_timezone ?? null,
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Connection failed (timeout or network error).",
      },
      { status: 200 },
    )
  }
}
