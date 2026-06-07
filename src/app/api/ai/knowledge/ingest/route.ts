import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { chunkText, fetchTextFromUrl } from '@/lib/ai/ingestion'
import {
  createKnowledge,
  updateKnowledgeEmbedding,
  type KnowledgeSource,
} from '@/lib/ai/knowledge-queries'
import { generateEmbedding, toPgVector } from '@/lib/ai/embeddings'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

/**
 * POST /api/ai/knowledge/ingest
 *
 * Body (one of):
 *   { mode: 'text', source_name: string, text: string }
 *   { mode: 'url',  url: string, source_name?: string }
 *
 * Splits the input into KB-sized chunks, inserts a row per chunk,
 * and generates embeddings best-effort. Returns:
 *   { created: number, with_embedding: number, errors: string[] }
 *
 * Cap on chunks per call (defends against a pathologically large
 * upload): 200. Anything bigger should be a follow-up call.
 *
 * Rate limit: 5/min/user. Ingestion is expensive (one embedding per
 * chunk) and operators rarely do this more than once or twice in a
 * row.
 */

const MAX_CHUNKS = 200
const RL_LIMIT = 5
const RL_WINDOW_MS = 60_000

export async function POST(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rl = checkRateLimit(`ai-ingest:${user.id}`, {
    limit: RL_LIMIT,
    windowMs: RL_WINDOW_MS,
  })
  if (!rl.success) return rateLimitResponse(rl)

  let body: {
    mode?: string
    text?: string
    url?: string
    source_name?: string
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  let rawText = ''
  let sourceLabel = (body.source_name ?? '').trim()
  let source: KnowledgeSource = 'document'

  if (body.mode === 'text') {
    rawText = (body.text ?? '').trim()
    if (!rawText) {
      return NextResponse.json(
        { error: 'text is required' },
        { status: 400 },
      )
    }
    if (!sourceLabel) sourceLabel = 'Ingestão de texto'
    source = 'document'
  } else if (body.mode === 'url') {
    const url = (body.url ?? '').trim()
    if (!url) {
      return NextResponse.json(
        { error: 'url is required' },
        { status: 400 },
      )
    }
    try {
      const fetched = await fetchTextFromUrl(url)
      rawText = fetched.text
      if (!sourceLabel) {
        try {
          sourceLabel = new URL(fetched.final_url).hostname
        } catch {
          sourceLabel = 'Página externa'
        }
      }
      source = 'url'
    } catch (e) {
      return NextResponse.json(
        {
          error: 'fetch_failed',
          message: e instanceof Error ? e.message : 'unknown',
        },
        { status: 502 },
      )
    }
  } else {
    return NextResponse.json(
      { error: 'mode must be "text" or "url"' },
      { status: 400 },
    )
  }

  const chunks = chunkText(rawText, { sourceName: sourceLabel })
  if (chunks.length === 0) {
    return NextResponse.json(
      { error: 'no_usable_chunks', message: 'Content was empty after cleanup.' },
      { status: 422 },
    )
  }
  if (chunks.length > MAX_CHUNKS) {
    return NextResponse.json(
      {
        error: 'too_many_chunks',
        message: `Input produced ${chunks.length} chunks (max ${MAX_CHUNKS}). Split the document and try again.`,
      },
      { status: 413 },
    )
  }

  let created = 0
  let with_embedding = 0
  const errors: string[] = []

  for (const chunk of chunks) {
    try {
      const entry = await createKnowledge(db, {
        title: chunk.title,
        content: chunk.content,
        source,
      })
      created += 1

      try {
        const { embedding } = await generateEmbedding(
          db,
          `${entry.title}\n\n${entry.content}`,
        )
        await updateKnowledgeEmbedding(db, entry.id, toPgVector(embedding))
        with_embedding += 1
      } catch (e) {
        errors.push(
          `${chunk.title}: embed_failed (${
            e instanceof Error ? e.message : 'unknown'
          })`,
        )
      }
    } catch (e) {
      errors.push(
        `${chunk.title}: insert_failed (${
          e instanceof Error ? e.message : 'unknown'
        })`,
      )
    }
  }

  return NextResponse.json(
    {
      created,
      with_embedding,
      total_chunks: chunks.length,
      errors,
    },
    { status: 200 },
  )
}
