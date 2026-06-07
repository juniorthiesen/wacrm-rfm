import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  createKnowledge,
  listKnowledge,
  updateKnowledgeEmbedding,
  type KnowledgeStatus,
} from '@/lib/ai/knowledge-queries'
import { generateEmbedding, toPgVector } from '@/lib/ai/embeddings'

/**
 * /api/ai/knowledge
 *
 * GET    ?status=active|archived → list entries.
 * POST   { title, content }      → create + best-effort embedding.
 *
 * Embedding strategy: try synchronously after insert. On failure we
 * still return 200 with the row so the user sees their entry; the
 * `has_embedding: false` flag tells the UI to surface a "retry" badge.
 * A later batch endpoint can re-embed rows that have no vector yet.
 */

export async function GET(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const rawStatus = url.searchParams.get('status')
  const status: KnowledgeStatus | undefined =
    rawStatus === 'active' || rawStatus === 'archived' ? rawStatus : undefined

  try {
    const entries = await listKnowledge(db, { status })
    return NextResponse.json({ entries }, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to list KB' },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { title?: string; content?: string }
  try {
    body = (await req.json()) as { title?: string; content?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.title?.trim() || !body.content?.trim()) {
    return NextResponse.json(
      { error: 'title and content are required' },
      { status: 400 },
    )
  }

  let entry
  try {
    entry = await createKnowledge(db, {
      title: body.title,
      content: body.content,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to create entry' },
      { status: 500 },
    )
  }

  // Best-effort embedding — surface failure as embedding_error but
  // keep the row.
  let embeddingError: string | null = null
  try {
    const { embedding } = await generateEmbedding(
      db,
      `${entry.title}\n\n${entry.content}`,
    )
    await updateKnowledgeEmbedding(db, entry.id, toPgVector(embedding))
    entry = { ...entry, has_embedding: true }
  } catch (e) {
    embeddingError = e instanceof Error ? e.message : 'embedding_failed'
  }

  return NextResponse.json(
    { entry, embedding_error: embeddingError },
    { status: 200 },
  )
}
