import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * CRUD over ai_learning_queue — server + browser safe (no encryption).
 *
 * Approval flow lives in the route handler so that promoting a row to
 * ai_knowledge_entries can also compute its embedding (server-only).
 */

export type LearningStatus = 'pending' | 'approved' | 'rejected'

export interface LearningCandidate {
  id: string
  user_id: string
  agent_id: string | null
  contact_id: string | null
  source_excerpt: string | null
  suggested_title: string
  suggested_content: string
  status: LearningStatus
  reviewed_by: string | null
  reviewed_at: string | null
  knowledge_entry_id: string | null
  created_at: string
}

export async function listLearning(
  db: SupabaseClient,
  status: LearningStatus = 'pending',
): Promise<LearningCandidate[]> {
  const { data, error } = await db
    .from('ai_learning_queue')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)
  return (data ?? []) as LearningCandidate[]
}

/**
 * Count pending candidates — used by the sidebar badge.
 * `head: true` returns no rows and a `count` only.
 */
export async function countPendingLearning(
  db: SupabaseClient,
): Promise<number> {
  const { count, error } = await db
    .from('ai_learning_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
  if (error) throw new Error(error.message)
  return count ?? 0
}

export interface CreateLearningInput {
  agent_id: string | null
  contact_id?: string | null
  source_excerpt?: string | null
  suggested_title: string
  suggested_content: string
}

export async function createLearningCandidate(
  db: SupabaseClient,
  input: CreateLearningInput,
): Promise<LearningCandidate> {
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const title = input.suggested_title.trim()
  const content = input.suggested_content.trim()
  if (!title || !content) throw new Error('title and content are required')

  const { data, error } = await db
    .from('ai_learning_queue')
    .insert({
      user_id: user.id,
      agent_id: input.agent_id,
      contact_id: input.contact_id ?? null,
      source_excerpt: input.source_excerpt ?? null,
      suggested_title: title,
      suggested_content: content,
      status: 'pending',
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data as LearningCandidate
}

export async function getLearningCandidate(
  db: SupabaseClient,
  id: string,
): Promise<LearningCandidate | null> {
  const { data, error } = await db
    .from('ai_learning_queue')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as LearningCandidate | null) ?? null
}

export async function markLearning(
  db: SupabaseClient,
  id: string,
  patch: {
    status: LearningStatus
    knowledge_entry_id?: string | null
    suggested_title?: string
    suggested_content?: string
  },
): Promise<LearningCandidate> {
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const fields: Record<string, unknown> = {
    status: patch.status,
    reviewed_by: user.id,
    reviewed_at: new Date().toISOString(),
  }
  if (patch.knowledge_entry_id !== undefined) {
    fields.knowledge_entry_id = patch.knowledge_entry_id
  }
  if (patch.suggested_title !== undefined) {
    fields.suggested_title = patch.suggested_title.trim()
  }
  if (patch.suggested_content !== undefined) {
    fields.suggested_content = patch.suggested_content.trim()
  }

  const { data, error } = await db
    .from('ai_learning_queue')
    .update(fields)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data as LearningCandidate
}
