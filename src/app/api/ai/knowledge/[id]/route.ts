import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  deleteKnowledge,
  getKnowledge,
  updateKnowledge,
  updateKnowledgeEmbedding,
  type KnowledgeStatus,
} from '@/lib/ai/knowledge-queries'
import { generateEmbedding, toPgVector } from '@/lib/ai/embeddings'

/**
 * /api/ai/knowledge/[id]
 *
 * GET    → single entry.
 * PATCH  { title?, content?, status? } → partial update. If content
 *          changed, the row's embedding is reset to NULL by
 *          `updateKnowledge`, and we recompute synchronously.
 * DELETE → hard delete. UI uses archive (PATCH status) instead for
 *          accidental clicks; DELETE is for "really remove".
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const entry = await getKnowledge(db, id)
    if (!entry) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ entry }, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to load entry' },
      { status: 500 },
    )
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { title?: string; content?: string; status?: string }
  try {
    body = (await request.json()) as {
      title?: string
      content?: string
      status?: string
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  let status: KnowledgeStatus | undefined
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'archived') {
      return NextResponse.json(
        { error: 'status must be "active" or "archived"' },
        { status: 400 },
      )
    }
    status = body.status
  }

  const contentChanged = typeof body.content === 'string'

  let entry
  try {
    entry = await updateKnowledge(db, id, {
      title: body.title,
      content: body.content,
      status,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to update entry' },
      { status: 500 },
    )
  }

  let embeddingError: string | null = null
  if (contentChanged && entry.status === 'active') {
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
  }

  return NextResponse.json(
    { entry, embedding_error: embeddingError },
    { status: 200 },
  )
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await deleteKnowledge(db, id)
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to delete entry' },
      { status: 500 },
    )
  }
}
