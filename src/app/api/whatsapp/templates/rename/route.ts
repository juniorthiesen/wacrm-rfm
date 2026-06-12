import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { TEMPLATE_NAME_RE } from '@/lib/whatsapp/template-name'

/**
 * Rename a Draft/Rejected template AND every automation step that
 * references it, atomically.
 *
 * Why not two plain UPDATEs from the client:
 *   the name lives in message_templates.name and in
 *   automation_steps.step_config->>'template_name'. Separate updates
 *   can fail halfway and leave automations pointing at a name Meta
 *   doesn't know — which only surfaces at the next order, as Meta
 *   error #132001. The rename_message_template() Postgres function
 *   (migration 024) wraps both updates in one transaction; this
 *   route is a thin authenticated wrapper around it.
 *
 * Used by the Template Manager's name-conflict dialog ("rename to
 * _vN and resubmit") when Meta refuses a submission because the old
 * name is still being deleted or is locked for 30 days.
 */
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

    let body: { template_id?: string; new_name?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const templateId = body.template_id
    const newName = body.new_name?.trim()
    if (!templateId || !newName) {
      return NextResponse.json(
        { error: 'template_id and new_name are required' },
        { status: 400 },
      )
    }
    if (!TEMPLATE_NAME_RE.test(newName)) {
      return NextResponse.json(
        {
          error:
            'Template names must be lowercase letters, digits and underscores.',
        },
        { status: 400 },
      )
    }

    const { data, error } = await supabase.rpc('rename_message_template', {
      p_template_id: templateId,
      p_new_name: newName,
    })

    if (error) {
      // Map the function's RAISEd business errors onto HTTP statuses.
      // 23505 = unique violation on (user_id, name, language): the
      // target name already exists locally.
      const status = error.message.includes('template_not_found')
        ? 404
        : error.message.includes('invalid_name')
          ? 400
          : error.code === '23505' ||
              error.message.includes('template_not_renameable') ||
              error.message.includes('same_name')
            ? 409
            : 500
      return NextResponse.json({ error: error.message }, { status })
    }

    const row = Array.isArray(data) ? data[0] : data
    return NextResponse.json({
      success: true,
      old_name: row?.old_name,
      new_name: row?.new_name ?? newName,
      automations_updated: row?.automations_updated ?? 0,
    })
  } catch (error) {
    console.error('Error renaming template:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to rename' },
      { status: 500 },
    )
  }
}
