import type { SupabaseClient } from '@supabase/supabase-js'
import { getProvider } from './providers'
import { loadAgent, loadProviderKeyDecrypted } from './queries'
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  type AiProvider,
} from './types'

/**
 * Embeddings + similarity search.
 *
 * Server-only: every function here either decrypts the provider key
 * or calls an LLM, both of which require the Node `crypto` runtime
 * and a service-aware Supabase client. Never import from a client
 * component.
 *
 * Embedding model is fixed to OpenRouter's `openai/text-embedding-3-small`
 * (1536 dims) because the `embedding` column in migration 018 is
 * declared with that dimension. Swapping models means a new migration
 * — handle that with a versioned column (`embedding_v2`) rather than
 * silently changing dims.
 */

export interface KnowledgeMatch {
  id: string
  title: string
  content: string
  source: string
  similarity: number
}

/**
 * Format a JS number array as a Postgres pgvector literal.
 *
 * `[0.1, -0.2, 0.33]` → "[0.1,-0.2,0.33]"
 *
 * pgvector accepts this textual form on INSERT/UPDATE; the Supabase
 * JS client passes the string straight through. Doing the formatting
 * ourselves keeps numerical precision under our control (toString()
 * preserves enough digits) and avoids any locale-dependent rendering.
 */
export function toPgVector(values: number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding has ${values.length} dims, expected ${EMBEDDING_DIMENSIONS}`,
    )
  }
  return `[${values.join(',')}]`
}

/**
 * Resolve the active provider + key for the current user. Returns the
 * provider id and decrypted API key — callers feed those into
 * `getProvider`.
 */
async function resolveProvider(
  db: SupabaseClient,
): Promise<{ provider: AiProvider; apiKey: string }> {
  const agent = await loadAgent(db)
  const provider: AiProvider = agent?.provider ?? 'openrouter'
  const apiKey = await loadProviderKeyDecrypted(db, provider)
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${provider}". Open Settings → Agente IA.`,
    )
  }
  return { provider, apiKey }
}

/**
 * Generate an embedding for a single text. Wraps the provider call
 * and validates dimensions match the DB column.
 */
export async function generateEmbedding(
  db: SupabaseClient,
  text: string,
): Promise<{ embedding: number[]; model: string }> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Cannot embed empty text')

  const { provider, apiKey } = await resolveProvider(db)
  const client = getProvider(provider, apiKey, { appName: 'wacrm' })
  const { embedding, model } = await client.embed({
    model: DEFAULT_EMBEDDING_MODEL,
    input: trimmed,
  })

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Provider returned ${embedding.length}-dim embedding, expected ${EMBEDDING_DIMENSIONS}. ` +
        `Check the embedding model in lib/ai/types.ts.`,
    )
  }
  return { embedding, model }
}

/**
 * Compute an embedding for the given text and run a cosine-similarity
 * search against the current user's KB via the `match_ai_knowledge`
 * RPC. Returns the top `limit` matches above `threshold`.
 *
 * `threshold` is cosine similarity in [-1, 1] — higher means stricter.
 * 0.3 is a permissive default; 0.6+ starts to feel "obvious match".
 */
export async function searchKnowledge(
  db: SupabaseClient,
  query: string,
  options: { limit?: number; threshold?: number } = {},
): Promise<KnowledgeMatch[]> {
  const { embedding } = await generateEmbedding(db, query)
  const { data, error } = await db.rpc('match_ai_knowledge', {
    query_embedding: toPgVector(embedding),
    match_count: options.limit ?? 5,
    match_threshold: options.threshold ?? 0.0,
  })
  if (error) {
    throw new Error(`Knowledge search failed: ${error.message}`)
  }
  return (data ?? []) as KnowledgeMatch[]
}
