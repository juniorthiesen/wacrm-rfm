import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getLearningCandidate,
  markLearning,
} from '@/lib/ai/learning-queries'
import {
  createKnowledge,
  updateKnowledgeEmbedding,
} from '@/lib/ai/knowledge-queries'
import { generateEmbedding, toPgVector } from '@/lib/ai/embeddings'

/**
 * POST /api/ai/learning-queue/[id]/approve
 *
 * Body: { title?, content? } — operator may edit the suggestion
 *                              before approving.
 *
 * 1. Loads the pending candidate.
 * 2. Creates an ai_knowledge_entries row with source='learned'.
 * 3. Generates an embedding best-effort.
 * 4. Marks the queue row approved + links knowledge_entry_id.
 *
 * Errors during embedding don't roll back — the KB entry still gets
 * created. The UI badge "no embedding" on the KB page lets the
 * operator retry later.
 */
export async function POST(
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

  let body: { title?: string; content?: string }
  try {
    body = (await request.json().catch(() => ({}))) as {
      title?: string
      content?: string
    }
  } catch {
    body = {}
  }

  const candidate = await getLearningCandidate(db, id)
  if (!candidate) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (candidate.status !== 'pending') {
    return NextResponse.json(
      { error: `already_${candidate.status}` },
      { status: 409 },
    )
  }

  const title = (body.title ?? candidate.suggested_title).trim()
  const content = (body.content ?? candidate.suggested_content).trim()
  if (!title || !content) {
    return NextResponse.json(
      { error: 'title and content cannot be empty' },
      { status: 400 },
    )
  }

  let entry
  try {
    entry = await createKnowledge(db, {
      agent_id: candidate.agent_id,
      title,
      content,
      source: 'learned',
    })
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : 'create_kb_failed',
      },
      { status: 500 },
    )
  }

  let embedding_error: string | null = null
  try {
    const { embedding } = await generateEmbedding(
      db,
      `${entry.title}\n\n${entry.content}`,
    )
    await updateKnowledgeEmbedding(db, entry.id, toPgVector(embedding))
  } catch (e) {
    embedding_error = e instanceof Error ? e.message : 'embedding_failed'
  }

  // Mark queue row regardless — operator already accepted the content.
  await markLearning(db, id, {
    status: 'approved',
    knowledge_entry_id: entry.id,
    // Persist any edits the operator made, so the audit trail reflects
    // what was actually approved.
    suggested_title: title,
    suggested_content: content,
  })

  return NextResponse.json(
    { ok: true, knowledge_entry_id: entry.id, embedding_error },
    { status: 200 },
  )
}
