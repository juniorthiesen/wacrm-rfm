import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateMessage, uploadMedia } from '@/lib/whatsapp/meta-api'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

/**
 * Broadcast drip: drains snapshotted campaigns (broadcasts in status
 * 'sending') in small batches, respecting each campaign's daily_limit
 * (Meta's 24h business-initiated cap). Because the audience is frozen
 * in broadcast_recipients, the nightly RFM recalc can't disturb it.
 *
 * Run frequently (Vercel Cron hourly, or an external pinger). Each call
 * sends at most MAX_PER_RUN per campaign so it never approaches the
 * function timeout; the daily cap is enforced by counting sends in the
 * trailing 24h. Auth: 'Authorization: Bearer <CRON_SECRET>' (Vercel
 * Cron) or 'x-cron-secret'.
 */
export const maxDuration = 60

// Keep a run well under the 60s timeout: ~80 Meta calls at <=400ms each,
// plus a one-off media-header upload per campaign. (Was 150, which could
// tip past 60s when Meta latency rose, killing the function mid-batch.)
const MAX_PER_RUN = 80

interface ContactRow {
  id: string
  phone: string | null
  name: string | null
}

// Shape returned by the claim_broadcast_recipients RPC (migration 041).
interface ContactRef {
  id: string
  contact_id: string
}

function firstNameOf(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? ''
}

// Meta rejects template params with newlines/tabs/4+ spaces (#100).
function sanitizeParam(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' · ')
    .replace(/ {4,}/g, '   ')
    .trim()
}

/**
 * Resolve the campaign's template_variables ({"1":"{{customer.first_name}}",
 * …}) into a positional param array for one contact.
 */
function resolveParams(
  vars: Record<string, string> | null,
  contact: ContactRow,
): string[] {
  if (!vars) return []
  return Object.keys(vars)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => {
      const v = String(vars[k] ?? '')
        .replace(/\{\{\s*customer\.first_name\s*\}\}/g, firstNameOf(contact.name))
        .replace(/\{\{\s*customer\.name\s*\}\}/g, contact.name ?? '')
        .replace(/\{\{\s*customer\.phone\s*\}\}/g, contact.phone ?? '')
      return sanitizeParam(v)
    })
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? process.env.AUTOMATION_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const authed =
    request.headers.get('authorization') === `Bearer ${secret}` ||
    request.headers.get('x-cron-secret') === secret
  if (!authed) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: campaigns, error } = await admin
    .from('broadcasts')
    .select('id, user_id, template_name, template_language, template_variables, daily_limit')
    .eq('status', 'sending')
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const summary: Array<{ broadcast_id: string; sent: number; failed: number; done: boolean }> = []

  for (const c of campaigns ?? []) {
    let sent = 0
    let failed = 0

    // Enforce the rolling-24h daily cap.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count: sentToday } = await admin
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', c.id)
      .eq('status', 'sent')
      .gte('sent_at', since)

    const remaining = (c.daily_limit ?? 2000) - (sentToday ?? 0)
    if (remaining <= 0) {
      summary.push({ broadcast_id: c.id, sent: 0, failed: 0, done: false })
      continue
    }

    const batchSize = Math.min(MAX_PER_RUN, remaining)
    // Claim the batch atomically (FOR UPDATE SKIP LOCKED) so a concurrent
    // drip run can never grab the same recipients and double-send. See
    // migration 041.
    const { data: pending } = await admin.rpc('claim_broadcast_recipients', {
      p_broadcast_id: c.id,
      p_limit: batchSize,
    })

    if (!pending || pending.length === 0) {
      // Nothing claimable this run. Only close the campaign when the queue
      // is TRULY empty — a concurrent run may be holding the last batch, so
      // we must not mark it 'sent' just because our claim came back empty.
      const { count: remainingPending } = await admin
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', c.id)
        .eq('status', 'pending')
      if ((remainingPending ?? 0) === 0) {
        await admin.from('broadcasts').update({ status: 'sent' }).eq('id', c.id)
        summary.push({ broadcast_id: c.id, sent: 0, failed: 0, done: true })
      } else {
        summary.push({ broadcast_id: c.id, sent: 0, failed: 0, done: false })
      }
      continue
    }

    // One round-trip for the WhatsApp config and the batch's contacts.
    const { data: config } = await admin
      .from('whatsapp_config')
      .select('access_token, phone_number_id')
      .eq('user_id', c.user_id)
      .single()
    if (!config?.access_token) {
      summary.push({ broadcast_id: c.id, sent: 0, failed: pending.length, done: false })
      continue
    }
    const accessToken = decrypt(config.access_token)

    // Resolve a media header to a durable media_id ONCE per campaign run.
    // Templates with an image/video/document header require a header
    // component on every send (else Meta #132012). The stored
    // header_content is a short-lived WhatsApp CDN URL, so we re-upload it
    // to get a media_id that doesn't expire for sending.
    let headerParam:
      | { type: 'image' | 'video' | 'document'; mediaId: string }
      | undefined
    const { data: tpl } = await admin
      .from('message_templates')
      .select('header_type, header_content')
      .eq('user_id', c.user_id)
      .eq('name', c.template_name)
      .eq('language', c.template_language)
      .maybeSingle()
    if (
      tpl?.header_type &&
      ['image', 'video', 'document'].includes(tpl.header_type) &&
      tpl.header_content
    ) {
      try {
        const imgRes = await fetch(tpl.header_content as string, {
          signal: AbortSignal.timeout(15_000),
        })
        if (!imgRes.ok) throw new Error(`header fetch ${imgRes.status}`)
        const buf = Buffer.from(await imgRes.arrayBuffer())
        const mime = imgRes.headers.get('content-type') || 'image/jpeg'
        const mediaId = await uploadMedia({
          phoneNumberId: config.phone_number_id,
          accessToken,
          fileBuffer: buf,
          mimeType: mime,
          fileName: 'header',
        })
        headerParam = {
          type: tpl.header_type as 'image' | 'video' | 'document',
          mediaId,
        }
      } catch (err) {
        console.error('[broadcast-drip] header media resolve failed:', err)
        // Fall through without a header — the per-recipient send will then
        // fail with #132012 and be marked failed, surfacing the problem
        // instead of silently sending a broken message.
      }
    }

    const { data: contacts } = await admin
      .from('contacts')
      .select('id, phone, name')
      .in('id', (pending as ContactRef[]).map((p) => p.contact_id))
    const byId = new Map<string, ContactRow>(
      ((contacts ?? []) as ContactRow[]).map((ct) => [ct.id, ct]),
    )
    const vars = (c.template_variables as Record<string, string> | null) ?? null

    for (const row of pending) {
      const contact = byId.get(row.contact_id as string)
      const sanitized = contact?.phone ? sanitizePhoneForMeta(contact.phone) : ''
      if (!contact || !isValidE164(sanitized)) {
        await admin
          .from('broadcast_recipients')
          .update({ status: 'failed', error_message: 'invalid or missing phone' })
          .eq('id', row.id)
        failed++
        continue
      }

      const params = resolveParams(vars, contact)
      let messageId: string | null = null
      let lastError = 'send failed'
      for (const variant of phoneVariants(sanitized)) {
        try {
          const r = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: c.template_name,
            language: c.template_language || 'pt_BR',
            params,
            header: headerParam,
          })
          messageId = r.messageId
          break
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          if (!isRecipientNotAllowedError(lastError)) break
        }
      }

      if (messageId) {
        await admin
          .from('broadcast_recipients')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: messageId,
          })
          .eq('id', row.id)
        sent++
      } else {
        await admin
          .from('broadcast_recipients')
          .update({ status: 'failed', error_message: lastError })
          .eq('id', row.id)
        failed++
      }
    }

    // Bump the campaign's sent_count and close it out if nothing is left.
    if (sent > 0) {
      const { count: total } = await admin
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', c.id)
        .eq('status', 'sent')
      await admin.from('broadcasts').update({ sent_count: total ?? 0 }).eq('id', c.id)
    }
    const { count: stillPending } = await admin
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', c.id)
      .eq('status', 'pending')
    const done = (stillPending ?? 0) === 0
    if (done) {
      await admin.from('broadcasts').update({ status: 'sent' }).eq('id', c.id)
    }

    summary.push({ broadcast_id: c.id, sent, failed, done })
  }

  return NextResponse.json({ campaigns: summary.length, summary })
}
