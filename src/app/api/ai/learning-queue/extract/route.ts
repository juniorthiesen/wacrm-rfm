import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { extractKnowledgeCandidate } from '@/lib/ai/learning'
import { createLearningCandidate } from '@/lib/ai/learning-queries'
import { loadAgent } from '@/lib/ai/queries'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

/**
 * POST /api/ai/learning-queue/extract
 *
 * Body: { customer_question, human_reply, contact_id?, source_excerpt? }
 *
 * Returns:
 *   200 { enqueued: true, candidate }   — a row was created
 *   200 { enqueued: false, reason }     — extractor said "no fact"
 *   400 invalid body
 *   401 unauthenticated
 *   409 agent not configured
 *   429 rate limited
 *   500 extraction failed
 */

const RL_LIMIT = 10
const RL_WINDOW_MS = 60_000

export async function POST(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rl = checkRateLimit(`ai-learning-extract:${user.id}`, {
    limit: RL_LIMIT,
    windowMs: RL_WINDOW_MS,
  })
  if (!rl.success) return rateLimitResponse(rl)

  let body: {
    customer_question?: string
    human_reply?: string
    contact_id?: string | null
    source_excerpt?: string | null
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const q = (body.customer_question ?? '').trim()
  const a = (body.human_reply ?? '').trim()
  if (!q || !a) {
    return NextResponse.json(
      { error: 'customer_question and human_reply are required' },
      { status: 400 },
    )
  }

  const agent = await loadAgent(db)
  if (!agent) {
    return NextResponse.json(
      { error: 'agent_not_configured', reason: 'no_agent' },
      { status: 409 },
    )
  }

  try {
    const { candidate } = await extractKnowledgeCandidate(db, {
      customerQuestion: q,
      humanReply: a,
      contactId: body.contact_id ?? null,
    })

    if (!candidate) {
      return NextResponse.json(
        { enqueued: false, reason: 'no_reusable_fact' },
        { status: 200 },
      )
    }

    const row = await createLearningCandidate(db, {
      agent_id: agent.id,
      contact_id: body.contact_id ?? null,
      source_excerpt:
        body.source_excerpt ?? `Q: ${q}\nA: ${a}`,
      suggested_title: candidate.title,
      suggested_content: candidate.content,
    })

    return NextResponse.json(
      { enqueued: true, candidate: row },
      { status: 200 },
    )
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'extract_failed' },
      { status: 500 },
    )
  }
}
