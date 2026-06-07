import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  countPendingLearning,
  listLearning,
  type LearningStatus,
} from '@/lib/ai/learning-queries'

/**
 * GET /api/ai/learning-queue
 *
 *   ?status=pending|approved|rejected   (default pending)
 *   ?count_only=1                       returns { pending: number }
 *
 * The count variant is what the sidebar badge polls — cheap query
 * since it uses `head: true`.
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
  if (url.searchParams.get('count_only') === '1') {
    try {
      const pending = await countPendingLearning(db)
      return NextResponse.json({ pending }, { status: 200 })
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'count_failed' },
        { status: 500 },
      )
    }
  }

  const raw = url.searchParams.get('status')
  const status: LearningStatus =
    raw === 'approved' || raw === 'rejected' ? raw : 'pending'

  try {
    const items = await listLearning(db, status)
    return NextResponse.json({ items }, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'list_failed' },
      { status: 500 },
    )
  }
}
