import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { extractKnowledgeCandidate } from '@/lib/ai/learning'
import { createLearningCandidate } from '@/lib/ai/learning-queries'
import { loadAgent } from '@/lib/ai/queries'
import { generateEmbedding, toPgVector } from '@/lib/ai/embeddings'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

/**
 * POST /api/ai/learning-queue/mine-batch
 *
 * Batch counterpart to /extract: instead of one operator-picked pair,
 * pulls the next BATCH_SIZE (customer question, human reply) pairs
 * from the whole conversation history (via the find_reply_pairs RPC,
 * migration 050) and runs the same extractor on each. Meant to be
 * called repeatedly by the client, feeding back `next_since` each
 * time, until it comes back null.
 *
 * Body: { since?: string | null }  — ISO timestamp cursor, omit/null
 * for the very first call (starts from the beginning of history).
 *
 * A candidate is only enqueued if it both (a) looks like a reusable
 * fact per the existing extractor, and (b) isn't already covered by an
 * approved KB entry or by another candidate already queued in this
 * same run — dedup is required here because the same recurring
 * question can appear hundreds of times across a long history, and the
 * approval queue UI has no bulk/duplicate handling of its own.
 */

// Fluid compute is enabled on this project (see src/app/api/broadcasts/drip/route.ts)
// — Hobby allows up to 300s. 280s leaves headroom for ~50 sequential
// extract+embed+match round-trips per call.
export const maxDuration = 280

const BATCH_SIZE = 50
const DUPLICATE_THRESHOLD = 0.9
const RL_LIMIT = 20
const RL_WINDOW_MS = 60_000

interface ReplyPair {
  contact_id: string | null
  customer_text: string
  agent_text: string
  agent_message_id: string
  agent_created_at: string
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export async function POST(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rl = checkRateLimit(`ai-learning-mine:${user.id}`, {
    limit: RL_LIMIT,
    windowMs: RL_WINDOW_MS,
  })
  if (!rl.success) return rateLimitResponse(rl)

  let body: { since?: string | null } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    // No body on the first call is fine — since defaults to the start
    // of history.
  }

  const agent = await loadAgent(db)
  if (!agent) {
    return NextResponse.json({ error: 'agent_not_configured' }, { status: 409 })
  }

  const { data: pairs, error: pairsError } = await db.rpc('find_reply_pairs', {
    p_user_id: user.id,
    p_since: body.since ?? null,
    p_limit: BATCH_SIZE,
  })
  if (pairsError) {
    return NextResponse.json({ error: pairsError.message }, { status: 500 })
  }

  let processed = 0
  let queued = 0
  let skippedNoFact = 0
  let skippedDuplicate = 0
  let lastSeen: string | null = null
  const seenEmbeddings: number[][] = []

  for (const pair of (pairs ?? []) as ReplyPair[]) {
    processed++
    lastSeen = pair.agent_created_at

    let candidate
    try {
      const result = await extractKnowledgeCandidate(db, {
        customerQuestion: pair.customer_text,
        humanReply: pair.agent_text,
        contactId: pair.contact_id,
      })
      candidate = result.candidate
    } catch (e) {
      // One bad pair (transient LLM error, etc.) shouldn't kill the
      // whole batch. If it matters it'll surface again on a future run
      // since `since` only advances past pairs we actually iterated.
      console.error(
        '[mine-batch] extraction failed:',
        e instanceof Error ? e.message : e,
      )
      continue
    }

    if (!candidate) {
      skippedNoFact++
      continue
    }

    let embedding: number[]
    try {
      const result = await generateEmbedding(
        db,
        `${candidate.title}\n${candidate.content}`,
      )
      embedding = result.embedding
    } catch (e) {
      console.error(
        '[mine-batch] embedding failed:',
        e instanceof Error ? e.message : e,
      )
      continue
    }

    // Dedup against already-approved KB entries.
    const { data: matches } = await db.rpc('match_ai_knowledge', {
      query_embedding: toPgVector(embedding),
      match_count: 1,
      match_threshold: 0,
    })
    const topMatch = ((matches ?? []) as { similarity: number }[])[0]
    if (topMatch && topMatch.similarity >= DUPLICATE_THRESHOLD) {
      skippedDuplicate++
      continue
    }

    // Dedup against candidates already queued earlier in this same
    // run — the same recurring question can appear hundreds of times
    // in a long history, and ai_learning_queue doesn't store
    // embeddings to check against on a future run anyway.
    const dupInRun = seenEmbeddings.some(
      (e) => cosineSimilarity(e, embedding) >= DUPLICATE_THRESHOLD,
    )
    if (dupInRun) {
      skippedDuplicate++
      continue
    }

    await createLearningCandidate(db, {
      agent_id: agent.id,
      contact_id: pair.contact_id,
      source_excerpt: `Q: ${pair.customer_text}\nA: ${pair.agent_text}`,
      suggested_title: candidate.title,
      suggested_content: candidate.content,
    })
    seenEmbeddings.push(embedding)
    queued++
  }

  const exhausted = (pairs?.length ?? 0) < BATCH_SIZE

  return NextResponse.json({
    processed,
    queued,
    skipped_no_fact: skippedNoFact,
    skipped_duplicate: skippedDuplicate,
    next_since: exhausted ? null : lastSeen,
  })
}
