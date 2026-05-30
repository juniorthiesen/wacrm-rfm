import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { sendTemplateMessage } from "@/lib/whatsapp/meta-api"
import { decrypt } from "@/lib/whatsapp/encryption"
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from "@/lib/whatsapp/phone-utils"
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit"

// Fire-and-forget template send used by the automation builder's
// "Send test" button. Unlike /api/whatsapp/send this does NOT need a
// conversation_id and does NOT persist anything to the messages table —
// it's a one-shot dry-run so operators can see how a template renders
// before wiring it into an automation.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json()
    const {
      to,
      template_name,
      language,
      params,
    }: {
      to?: string
      template_name?: string
      language?: string
      params?: string[]
    } = body

    if (!to || !template_name) {
      return NextResponse.json(
        { error: "to and template_name are required" },
        { status: 400 },
      )
    }

    const sanitized = sanitizePhoneForMeta(to)
    if (!isValidE164(sanitized)) {
      return NextResponse.json(
        { error: "Invalid phone number format" },
        { status: 400 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from("whatsapp_config")
      .select("phone_number_id, access_token")
      .eq("user_id", user.id)
      .single()
    if (configError || !config) {
      return NextResponse.json(
        { error: "WhatsApp not configured" },
        { status: 400 },
      )
    }
    const accessToken = decrypt(config.access_token)

    // Retry with phone variants — same logic as /send, since test
    // numbers (operator's own cell, sandbox numbers) frequently hit
    // the "recipient not allowed" branch.
    let waMessageId = ""
    let lastError: unknown = null
    for (const variant of phoneVariants(sanitized)) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: variant,
          templateName: template_name,
          language: language || "en_US",
          params: (params ?? []).map((p) => String(p ?? "")),
        })
        waMessageId = result.messageId
        lastError = null
        break
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!isRecipientNotAllowedError(message)) throw err
        lastError = err
      }
    }
    if (lastError) throw lastError

    return NextResponse.json({
      success: true,
      whatsapp_message_id: waMessageId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[whatsapp/templates/test-send]", message)
    return NextResponse.json(
      { error: `Failed to send test: ${message}` },
      { status: 502 },
    )
  }
}
