import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendTemplateMessage, sendTextMessage } from '@/lib/whatsapp/meta-api'
import { resolveTemplateHeader } from '@/lib/whatsapp/template-header'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
  phonesMatch,
} from '@/lib/whatsapp/phone-utils'
import { isWindowOpen } from '@/lib/whatsapp/conversation-window'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
  /** 'template' = paid template send; 'free_form' = free in-window text. */
  channel?: 'template' | 'free_form'
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string
  params?: string[]
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${user.id}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      // Smart-send extensions (see docs/whatsapp-cost-strategy.md).
      // When `smart_send` is true and a recipient has an open Meta
      // 24h window, we send `free_form_text` instead of the template
      // — free instead of paid. The template is the fallback for
      // every recipient outside the window. Backward-compatible:
      // callers that don't pass these fields get the legacy
      // template-only behavior.
      smart_send,
      free_form_text,
    }: {
      recipients?: NewRecipient[]
      phone_numbers?: string[]
      template_name?: string
      template_language?: string
      template_params?: string[]
      smart_send?: boolean
      free_form_text?: string
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    // Look up the template's header once (every recipient gets the
    // same template). Without forwarding the media header back to Meta
    // a templates_promo with an image header would 132012 on every
    // send. Header is identical across recipients so this stays
    // outside the for-loop.
    const templateHeader = await resolveTemplateHeader(
      supabase,
      user.id,
      template_name,
      template_language,
    )

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    if (smart_send && !free_form_text) {
      return NextResponse.json(
        {
          error:
            'smart_send=true requires free_form_text — the body sent to contacts with an open 24h window.',
        },
        { status: 400 },
      )
    }

    // Pre-fetch contacts for this user when smart_send is on so we
    // can resolve each phone → conversation_window_until in one
    // round-trip. Done outside the loop to keep the broadcast O(N)
    // regardless of recipient count.
    let smartContactsByPhone: Map<
      string,
      { conversation_window_until: string | null }
    > | null = null
    if (smart_send) {
      const { data: contactRows, error: contactsErr } = await supabase
        .from('contacts')
        .select('phone, conversation_window_until')
        .eq('user_id', user.id)
        .not('conversation_window_until', 'is', null)
      if (contactsErr) {
        console.error(
          '[broadcast] failed to load contact windows:',
          contactsErr.message,
        )
      }
      smartContactsByPhone = new Map()
      for (const row of contactRows ?? []) {
        smartContactsByPhone.set(row.phone, row)
      }
    }

    function lookupWindowContact(rawPhone: string) {
      if (!smartContactsByPhone) return null
      // Try exact match first; fall back to phonesMatch for trunk-0
      // / country-code variants.
      const direct = smartContactsByPhone.get(rawPhone)
      if (direct) return direct
      for (const [phone, row] of smartContactsByPhone) {
        if (phonesMatch(phone, rawPhone)) return row
      }
      return null
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0
    let freeFormCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      // Smart-send: route this specific recipient to free-form when
      // their window is still open. Falls back to the template path
      // if no contact row, no window, or the window expired.
      let useFreeForm = false
      if (smart_send && free_form_text) {
        const contactRow = lookupWindowContact(sanitized)
        if (isWindowOpen(contactRow)) {
          useFreeForm = true
        }
      }

      // Retry with phone variants on "not in allowed list" so numbers
      // that differ only in a trunk-prefix 0 still reach recipients.
      const variants = phoneVariants(sanitized)
      let sentMessageId: string | null = null
      let lastError: string | null = null

      for (const variant of variants) {
        try {
          if (useFreeForm) {
            const result = await sendTextMessage({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: variant,
              text: free_form_text!,
            })
            sentMessageId = result.messageId
          } else {
            const result = await sendTemplateMessage({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: variant,
              templateName: template_name,
              language: template_language || 'en_US',
              params: recipient.params ?? [],
              header: templateHeader,
            })
            sentMessageId = result.messageId
          }
          lastError = null
          break
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error'
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage
            break
          }
          lastError = errorMessage
          // retry with next variant
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
          channel: useFreeForm ? 'free_form' : 'template',
        })
        sentCount++
        if (useFreeForm) freeFormCount++
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      // When smart_send is on, this tells the UI how many recipients
      // were served for free (free_form) vs paid (template). Stays at
      // 0 when smart_send is off.
      free_form_sent: freeFormCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    )
  }
}
