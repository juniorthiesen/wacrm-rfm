import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  userId: string
  /** Existing conversation to attach to, or null to find-or-create it
   *  AFTER a successful send (so a failed send leaves no empty thread). */
  conversationId: string | null
  contactId: string
  text: string
}

interface SendTemplateArgs {
  userId: string
  conversationId: string | null
  contactId: string
  templateName: string
  language?: string
  params?: string[]
  /** Dynamic suffix for the template's first URL button (sub_type=url,
   *  index=0). See sendTemplateMessage in lib/whatsapp/meta-api. */
  buttonUrlParam?: string
}

/**
 * Meta rejects template variables that contain a newline, tab, or 4+
 * consecutive spaces with "(#100) Invalid parameter". Multi-line values
 * like a bulleted order.items_list ("▪️ A\n▪️ B") trip this on every
 * send. Collapse the offending whitespace so the value goes through as
 * a single inline string.
 */
function sanitizeTemplateParam(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' · ')
    .replace(/ {4,}/g, '   ')
    .trim()
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact lookup by user_id. The engine uses the
  // service-role client (bypassing RLS), and the public
  // /api/automations/engine endpoint accepts contact_id from the
  // request body — without this filter, an authenticated user could
  // fire their own automations against another tenant's contact UUID
  // and send via their own WhatsApp config to that contact's phone.
  // Practical risk is low (UUIDs are unguessable) but the check is
  // cheap defense-in-depth.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('user_id', input.userId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this user')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('user_id', input.userId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // Resolve the template's language from the local message_templates table.
  // The step config may have the builder default ('en_US') even when the
  // template was approved in pt_BR — using the wrong code causes Meta
  // error #132001 ("Template name does not exist in the translation").
  // The DB record is the source of truth for which language Meta approved.
  let resolvedLanguage = input.kind === 'template' ? (input.language ?? undefined) : undefined
  if (input.kind === 'template') {
    const { data: tplRow } = await db
      .from('message_templates')
      .select('language')
      .eq('user_id', input.userId)
      .eq('name', input.templateName)
      .limit(1)
      .maybeSingle()
    if (tplRow?.language) resolvedLanguage = tplRow.language as string
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: resolvedLanguage,
        // Sanitize so multi-line values (e.g. items_list) don't trip
        // Meta's "(#100) Invalid parameter" on template variables.
        params: input.params?.map(sanitizeTemplateParam),
        // URL button suffixes can have whitespace too (e.g. interpolated
        // from {{vars.X}}) — sanitize for the same Meta restriction.
        buttonUrlParam: input.buttonUrlParam
          ? sanitizeTemplateParam(input.buttonUrlParam)
          : undefined,
      })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message.
  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Resolve the conversation only now that the send succeeded. Creating
  // it up front meant a failed send (e.g. the items_list #100 error)
  // left an empty "Nenhuma mensagem ainda" thread in the inbox. If the
  // caller already had a conversation id we use it; otherwise find-or-
  // create here, after the message is guaranteed to exist.
  let conversationId = input.conversationId
  if (!conversationId) {
    const { data: existingConv } = await db
      .from('conversations')
      .select('id')
      .eq('user_id', input.userId)
      .eq('contact_id', input.contactId)
      .limit(1)
      .maybeSingle()
    if (existingConv?.id) {
      conversationId = existingConv.id as string
    } else {
      const { data: created, error: convErr } = await db
        .from('conversations')
        .insert({ user_id: input.userId, contact_id: input.contactId })
        .select('id')
        .single()
      if (convErr || !created?.id) {
        throw new Error(
          `sent to Meta but conversation create failed: ${convErr?.message ?? 'no row'}`,
        )
      }
      conversationId = created.id as string
    }
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  const template_name = input.kind === 'template' ? input.templateName : null
  // For templates, render the body with the params we just sent and
  // store it as content_text — otherwise the inbox bubble shows only an
  // empty "Template" badge with no text. Best-effort: a send still
  // records even if the body can't be resolved.
  let content_text: string | null = input.kind === 'text' ? input.text : null
  if (input.kind === 'template') {
    content_text = await renderTemplateBody(
      db,
      input.userId,
      input.templateName,
      resolvedLanguage,
      input.params ?? [],
    )
  }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template' ? `[template:${input.templateName}]` : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  return { whatsapp_message_id: waMessageId }
}

/**
 * Resolve a template's local body and fill its positional {{n}}
 * placeholders with the params that were sent to Meta. Returns null if
 * the template body can't be found — the caller falls back to a
 * text-less template record rather than failing the send.
 *
 * Filtered by language when known; the same name can exist in several
 * languages. `.limit(1)` (not single) avoids throwing if more than one
 * row matches.
 */
async function renderTemplateBody(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  userId: string,
  name: string,
  language: string | undefined,
  params: string[],
): Promise<string | null> {
  let query = db
    .from('message_templates')
    .select('body_text')
    .eq('user_id', userId)
    .eq('name', name)
  if (language) query = query.eq('language', language)
  const { data } = await query.limit(1)
  const body = data?.[0]?.body_text as string | undefined
  if (!body) return null
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_match: string, n: string) => {
    return params[Number(n) - 1] ?? ''
  })
}
