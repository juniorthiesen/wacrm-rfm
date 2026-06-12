import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Find-or-create the conversation for a contact, so the UI can open an
 * inbox thread straight from the Contacts page.
 *
 *   POST /api/conversations  { contact_id: string }
 *     → { conversation_id: string, created: boolean }
 *
 * Why a server route instead of a client-side insert:
 *   a plain "select then insert" from two quick clicks can race into
 *   two conversation rows for the same contact. Doing it here keeps it
 *   to one round-trip and one place to harden later (there is no DB
 *   unique constraint on conversations.contact_id — multiple threads
 *   per contact is a deliberate allowance elsewhere — so we settle for
 *   reusing the most recent existing row).
 *
 * RLS still applies (anon client): the contact lookup and the insert
 * are both scoped to auth.uid(), so a user can only open conversations
 * for their own contacts.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { contact_id?: string }
  try {
    body = (await request.json()) as { contact_id?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.contact_id) {
    return NextResponse.json(
      { error: 'contact_id is required' },
      { status: 400 },
    )
  }

  // Confirm the contact belongs to this user before creating anything.
  // RLS would block a foreign insert anyway, but this returns a clean
  // 404 instead of a confusing constraint error.
  const { data: contact, error: contactErr } = await supabase
    .from('contacts')
    .select('id')
    .eq('id', body.contact_id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (contactErr) {
    return NextResponse.json({ error: contactErr.message }, { status: 500 })
  }
  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  // Reuse the latest existing thread if there is one.
  const { data: existing, error: lookupErr } = await supabase
    .from('conversations')
    .select('id')
    .eq('user_id', user.id)
    .eq('contact_id', body.contact_id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  }
  if (existing?.id) {
    return NextResponse.json({ conversation_id: existing.id, created: false })
  }

  const { data: created, error: createErr } = await supabase
    .from('conversations')
    .insert({ user_id: user.id, contact_id: body.contact_id })
    .select('id')
    .single()
  if (createErr || !created?.id) {
    return NextResponse.json(
      { error: createErr?.message ?? 'Failed to create conversation' },
      { status: 500 },
    )
  }

  return NextResponse.json({ conversation_id: created.id, created: true })
}
