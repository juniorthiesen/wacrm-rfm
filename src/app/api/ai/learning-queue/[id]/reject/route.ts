import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getLearningCandidate,
  markLearning,
} from '@/lib/ai/learning-queries'

/**
 * POST /api/ai/learning-queue/[id]/reject
 *
 * Stamps the row as rejected and records reviewer + timestamp. We
 * keep the row (instead of deleting) so the audit log shows what was
 * passed up — useful when iterating on the extractor prompt.
 */
export async function POST(
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

  try {
    await markLearning(db, id, { status: 'rejected' })
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'reject_failed' },
      { status: 500 },
    )
  }
}
