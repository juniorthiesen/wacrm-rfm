import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { AgentNotConfiguredError, runAgent } from '@/lib/ai/agent'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

/**
 * POST /api/ai/suggest
 *
 * Body: { query: string, contact_id?: string }
 *
 * Returns:
 *   200 { text, matches, run_id, model, tokens_in, tokens_out, latency_ms }
 *   400 invalid body
 *   401 unauthenticated
 *   409 agent not configured (no_agent | inactive | no_key) — UI uses
 *       this to deep-link to /settings?tab=ai-agent.
 *   429 rate-limited
 *   500 LLM failure (message bubbled up; user can retry)
 *
 * Rate limit: per-user fixed window. LLM calls are expensive enough
 * that even a small burst burns real money; 20/min is plenty for
 * interactive use.
 */

const RL_LIMIT = 20
const RL_WINDOW_MS = 60_000

export async function POST(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rl = checkRateLimit(`ai-suggest:${user.id}`, {
    limit: RL_LIMIT,
    windowMs: RL_WINDOW_MS,
  })
  if (!rl.success) {
    return rateLimitResponse(rl)
  }

  let body: { query?: string; contact_id?: string | null }
  try {
    body = (await req.json()) as {
      query?: string
      contact_id?: string | null
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const query = (body.query ?? '').trim()
  if (!query) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 })
  }

  try {
    const result = await runAgent(db, {
      query,
      contact_id: body.contact_id ?? null,
    })
    return NextResponse.json(result, { status: 200 })
  } catch (e) {
    if (e instanceof AgentNotConfiguredError) {
      return NextResponse.json(
        { error: 'agent_not_configured', reason: e.reason },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to run agent' },
      { status: 500 },
    )
  }
}
