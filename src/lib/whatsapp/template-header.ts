/**
 * Resolve the header arg for sendTemplateMessage from the user's
 * message_templates row.
 *
 * Looking up the template by (user_id, name, language) and forwarding
 * its stored `header_type` + `header_content` covers the 90% case:
 * media headers approved at submission time go out with the same URL
 * Meta hashed (stored in header_content via the sync route's
 * header_handle fallback). Without this every promo template with an
 * image header returns Meta #132012 at send time.
 *
 * Returns `undefined` when:
 *   - the template row doesn't exist in our catalog yet
 *   - the template has no header
 *   - the header is a static text header (no variable, no value needed)
 *
 * Multiple callers (manual send, broadcast, automation engine) need
 * this lookup so it lives in `lib/whatsapp` next to the Meta sender
 * — same shape as the rest of the API helpers there.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface TemplateHeader {
  type: 'image' | 'video' | 'document' | 'text'
  content: string
}

export async function resolveTemplateHeader(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  userId: string,
  templateName: string,
  language?: string | null,
): Promise<TemplateHeader | undefined> {
  let query = db
    .from('message_templates')
    .select('header_type, header_content')
    .eq('user_id', userId)
    .eq('name', templateName)
  if (language) query = query.eq('language', language)

  // limit(1) instead of single() so a same-name-different-language
  // duplicate doesn't throw — the caller is sending in a specific
  // language and the language filter above already narrows it.
  const { data } = await query.limit(1)
  const row = data?.[0] as
    | { header_type: string | null; header_content: string | null }
    | undefined
  if (!row || !row.header_type || !row.header_content) return undefined

  const t = row.header_type as TemplateHeader['type']
  if (t !== 'image' && t !== 'video' && t !== 'document' && t !== 'text') {
    return undefined
  }
  return { type: t, content: row.header_content }
}

export interface TemplateButton {
  type: string
  text: string
  url?: string
  phone_number?: string
}

/**
 * Resolve a template's `buttons` JSONB so callers can snapshot it onto
 * the `messages.template_buttons` column at send time — the inbox bubble
 * then shows the offered buttons without needing to join message_templates
 * (and stays accurate even if the template is edited/deleted later).
 */
export async function resolveTemplateButtons(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  userId: string,
  templateName: string,
  language?: string | null,
): Promise<TemplateButton[] | undefined> {
  let query = db
    .from('message_templates')
    .select('buttons')
    .eq('user_id', userId)
    .eq('name', templateName)
  if (language) query = query.eq('language', language)

  const { data } = await query.limit(1)
  const row = data?.[0] as { buttons: TemplateButton[] | null } | undefined
  if (!row?.buttons || !Array.isArray(row.buttons) || row.buttons.length === 0) {
    return undefined
  }
  return row.buttons
}
