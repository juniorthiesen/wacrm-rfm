import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  hasVariableAtBounds,
  isNameConflictError,
  suggestNextName,
} from '@/lib/whatsapp/template-name'

/**
 * Submit a local Draft template to Meta for approval.
 *
 * Why this exists:
 *   The Template Manager UI only creates Draft rows locally. Without
 *   this endpoint, users had to copy-paste each component into Meta's
 *   Business Manager by hand — error-prone and slow for batch
 *   campaigns like the DLY Multiplique-se promo (7 templates).
 *
 *   This route takes a local Draft row, builds Meta's expected
 *   payload (components, example values, button definitions), POSTs
 *   to graph.facebook.com/{WABA_ID}/message_templates, and writes
 *   Meta's response (id, status, rejection_reason) back to the
 *   local row.
 *
 * Scope:
 *   - Submits ONE template per call. Multi-submit is the client's
 *     job — sequentially, with a delay if needed to avoid Meta
 *     rate limits.
 *   - Body, header (text or image), footer, and buttons are all
 *     supported. Image header expects header_content to be a HTTPS
 *     URL Meta can fetch.
 *   - Local row must be in Draft status. Re-submitting a Pending /
 *     Approved / Rejected row is rejected — use a fresh Draft.
 *   - On success: local row flips to Pending and `meta_template_id`
 *     is populated. The /api/whatsapp/templates/sync endpoint will
 *     later refresh status as Meta moves Pending → Approved/Rejected.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface TemplateButton {
  type: 'URL' | 'QUICK_REPLY' | 'PHONE_NUMBER'
  text: string
  /** Required when type='URL'. */
  url?: string
  /** Required when type='PHONE_NUMBER'. */
  phone_number?: string
  /** URL example values when the URL itself contains a {{1}} placeholder. */
  example?: string[]
}

interface TemplateRow {
  id: string
  user_id: string
  name: string
  category: 'Marketing' | 'Utility' | 'Authentication'
  language: string
  header_type: 'text' | 'image' | 'video' | 'document' | null
  header_content: string | null
  body_text: string
  body_example: { body_text?: string[][] } | null
  footer_text: string | null
  buttons: TemplateButton[] | null
  status: string
}

interface MetaComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS'
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'
  text?: string
  example?: Record<string, unknown>
  buttons?: TemplateButton[]
}

function buildComponents(template: TemplateRow): MetaComponent[] {
  const components: MetaComponent[] = []

  // HEADER
  if (template.header_type && template.header_content) {
    if (template.header_type === 'text') {
      components.push({
        type: 'HEADER',
        format: 'TEXT',
        text: template.header_content,
      })
    } else {
      // image / video / document — Meta wants an example with the
      // media handle or a public URL. We pass the URL through as the
      // header_handle example; Meta fetches and stores it.
      const format = template.header_type.toUpperCase() as
        | 'IMAGE'
        | 'VIDEO'
        | 'DOCUMENT'
      components.push({
        type: 'HEADER',
        format,
        example: { header_handle: [template.header_content] },
      })
    }
  }

  // BODY (always present — body_text is NOT NULL in schema)
  const body: MetaComponent = { type: 'BODY', text: template.body_text }
  if (template.body_example?.body_text) {
    body.example = { body_text: template.body_example.body_text }
  }
  components.push(body)

  // FOOTER
  if (template.footer_text) {
    components.push({ type: 'FOOTER', text: template.footer_text })
  }

  // BUTTONS
  if (Array.isArray(template.buttons) && template.buttons.length > 0) {
    components.push({ type: 'BUTTONS', buttons: template.buttons })
  }

  return components
}

interface MetaSubmitResponse {
  id?: string
  status?: 'APPROVED' | 'PENDING' | 'REJECTED' | string
  category?: string
  error?: {
    message?: string
    error_user_title?: string
    error_user_msg?: string
  }
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

    let body: { template_id?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!body.template_id) {
      return NextResponse.json(
        { error: 'template_id is required' },
        { status: 400 },
      )
    }

    // Fetch the local template (RLS already scopes to user_id, but
    // the explicit eq makes the intent clear).
    const { data: template, error: tplErr } = await supabase
      .from('message_templates')
      .select('*')
      .eq('id', body.template_id)
      .eq('user_id', user.id)
      .single()

    if (tplErr || !template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 },
      )
    }

    if (template.status !== 'Draft' && template.status !== 'Rejected') {
      return NextResponse.json(
        {
          error: `Template is in ${template.status} status. Only Draft or Rejected templates can be submitted.`,
        },
        { status: 409 },
      )
    }

    // Meta always rejects bodies that open or close with a variable —
    // fail fast with a clear message instead of burning the API call
    // and flipping the local row to Rejected.
    if (hasVariableAtBounds(template.body_text)) {
      return NextResponse.json(
        {
          error:
            'Template body cannot start or end with a variable ({{n}}). Edit the template and add text around it.',
        },
        { status: 400 },
      )
    }

    const { data: config, error: configErr } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('user_id', user.id)
      .single()
    if (configErr || !config?.waba_id) {
      return NextResponse.json(
        {
          error:
            'WhatsApp Business Account ID missing. Connect WhatsApp in Settings first.',
        },
        { status: 400 },
      )
    }

    const accessToken = decrypt(config.access_token)

    const payload = {
      name: template.name,
      language: template.language || 'pt_BR',
      category: template.category.toUpperCase(),
      components: buildComponents(template as TemplateRow),
    }

    const res = await fetch(
      `${META_API_BASE}/${config.waba_id}/message_templates`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    )

    const data = (await res.json().catch(() => ({}))) as MetaSubmitResponse

    if (!res.ok) {
      const reason =
        data.error?.error_user_msg ||
        data.error?.message ||
        `Meta API error: ${res.status}`

      // Name conflict: a same-name template is still being deleted on
      // Meta's side (or the name is locked — deleted Approved names
      // stay reserved for 30 days). Not a content rejection, so leave
      // the local status untouched and hand the UI what it needs to
      // offer "retry" or "rename to _vN and resubmit".
      if (isNameConflictError(data.error)) {
        const { data: rows } = await supabase
          .from('message_templates')
          .select('name')
          .eq('user_id', user.id)
        const suggested = suggestNextName(
          template.name,
          (rows ?? []).map((r: { name: string }) => r.name),
        )
        return NextResponse.json(
          { error: reason, reason: 'name_conflict', suggested_name: suggested },
          { status: 409 },
        )
      }

      await supabase
        .from('message_templates')
        .update({
          status: 'Rejected',
          rejection_reason: reason,
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', template.id)
      return NextResponse.json({ error: reason }, { status: 502 })
    }

    // Meta returns status='PENDING' for new submissions, occasionally
    // 'APPROVED' immediately for low-risk Utility templates. Mirror
    // whatever Meta sent, falling back to Pending.
    const localStatus =
      data.status === 'APPROVED'
        ? 'Approved'
        : data.status === 'REJECTED'
          ? 'Rejected'
          : 'Pending'

    const { error: updErr } = await supabase
      .from('message_templates')
      .update({
        status: localStatus,
        meta_template_id: data.id ?? null,
        rejection_reason: null,
        last_synced_at: new Date().toISOString(),
      })
      .eq('id', template.id)

    if (updErr) {
      console.error('[templates/submit] local update failed:', updErr.message)
    }

    return NextResponse.json({
      success: true,
      meta_template_id: data.id,
      status: localStatus,
      category: data.category,
    })
  } catch (error) {
    console.error('Error submitting template to Meta:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to submit',
      },
      { status: 500 },
    )
  }
}
