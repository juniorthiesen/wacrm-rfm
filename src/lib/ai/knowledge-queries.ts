import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Knowledge-base CRUD.
 *
 * The `embedding` column is never written from this layer — embedding
 * generation happens in the API route via `lib/ai/embeddings.ts`,
 * which runs server-side and needs the decrypted provider key. Keeping
 * the embedding off these queries lets us reuse them for "purely
 * structural" ops (rename, archive, list) without paying for a model
 * call.
 */

export type KnowledgeSource = 'manual' | 'learned' | 'document' | 'url'
export type KnowledgeStatus = 'active' | 'archived'

export interface KnowledgeEntry {
  id: string
  user_id: string
  agent_id: string | null
  title: string
  content: string
  source: KnowledgeSource
  status: KnowledgeStatus
  /**
   * Whether an embedding exists. We don't return the vector itself
   * to the UI — it's heavy and useless on the client.
   */
  has_embedding: boolean
  created_at: string
  updated_at: string
}

/** Internal row shape — includes the raw embedding column. */
interface KnowledgeRow {
  id: string
  user_id: string
  agent_id: string | null
  title: string
  content: string
  source: KnowledgeSource
  status: KnowledgeStatus
  embedding: unknown | null
  created_at: string
  updated_at: string
}

function rowToEntry(r: KnowledgeRow): KnowledgeEntry {
  return {
    id: r.id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    title: r.title,
    content: r.content,
    source: r.source,
    status: r.status,
    has_embedding: r.embedding !== null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

const SELECT_COLUMNS =
  'id, user_id, agent_id, title, content, source, status, embedding, created_at, updated_at'

export async function listKnowledge(
  db: SupabaseClient,
  options: { status?: KnowledgeStatus; limit?: number } = {},
): Promise<KnowledgeEntry[]> {
  let q = db
    .from('ai_knowledge_entries')
    .select(SELECT_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(options.limit ?? 200)
  if (options.status) q = q.eq('status', options.status)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data as KnowledgeRow[] | null)?.map(rowToEntry) ?? []
}

export async function getKnowledge(
  db: SupabaseClient,
  id: string,
): Promise<KnowledgeEntry | null> {
  const { data, error } = await db
    .from('ai_knowledge_entries')
    .select(SELECT_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? rowToEntry(data as KnowledgeRow) : null
}

export interface CreateKnowledgeInput {
  title: string
  content: string
  source?: KnowledgeSource
  agent_id?: string | null
}

/**
 * Insert a KB entry **without** an embedding. The route handler then
 * generates the embedding and patches it via `updateKnowledgeEmbedding`.
 * This split exists so the UI can show "added" immediately even if the
 * embedding call is slow (or temporarily failing).
 */
export async function createKnowledge(
  db: SupabaseClient,
  input: CreateKnowledgeInput,
): Promise<KnowledgeEntry> {
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const title = input.title.trim()
  const content = input.content.trim()
  if (!title) throw new Error('title is required')
  if (!content) throw new Error('content is required')

  const { data, error } = await db
    .from('ai_knowledge_entries')
    .insert({
      user_id: user.id,
      agent_id: input.agent_id ?? null,
      title,
      content,
      source: input.source ?? 'manual',
    })
    .select(SELECT_COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  return rowToEntry(data as KnowledgeRow)
}

export interface UpdateKnowledgeInput {
  title?: string
  content?: string
  status?: KnowledgeStatus
}

export async function updateKnowledge(
  db: SupabaseClient,
  id: string,
  input: UpdateKnowledgeInput,
): Promise<KnowledgeEntry> {
  const patch: Record<string, unknown> = {}
  if (input.title !== undefined) {
    const t = input.title.trim()
    if (!t) throw new Error('title cannot be empty')
    patch.title = t
  }
  if (input.content !== undefined) {
    const c = input.content.trim()
    if (!c) throw new Error('content cannot be empty')
    patch.content = c
    // Mutating content invalidates the existing embedding — the route
    // handler will recompute and patch via updateKnowledgeEmbedding.
    patch.embedding = null
  }
  if (input.status !== undefined) patch.status = input.status

  const { data, error } = await db
    .from('ai_knowledge_entries')
    .update(patch)
    .eq('id', id)
    .select(SELECT_COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  return rowToEntry(data as KnowledgeRow)
}

/**
 * Persist the embedding for an existing row. `pgVectorLiteral` is the
 * `[a,b,c]` string from `toPgVector`. Kept narrow on purpose — this
 * is the only call site that writes the vector column.
 */
export async function updateKnowledgeEmbedding(
  db: SupabaseClient,
  id: string,
  pgVectorLiteral: string,
): Promise<void> {
  const { error } = await db
    .from('ai_knowledge_entries')
    .update({ embedding: pgVectorLiteral })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteKnowledge(
  db: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await db
    .from('ai_knowledge_entries')
    .delete()
    .eq('id', id)
  if (error) throw new Error(error.message)
}
