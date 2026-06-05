import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadAgent, upsertAgent } from '@/lib/ai/queries'
import { AI_PROVIDERS, type AiProvider } from '@/lib/ai/types'

/**
 * /api/ai/agent
 *
 * GET    → returns the single AI agent for the current user, or null.
 * POST   → upserts (insert on first call, update thereafter).
 *
 * Phase 1 enforces "one agent per user" at the route layer — the table
 * doesn't have a UNIQUE constraint on user_id so we can lift this
 * cleanly later when we introduce per-channel agents.
 */

export async function GET() {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const agent = await loadAgent(db)
  return NextResponse.json({ agent }, { status: 200 })
}

interface PostBody {
  name?: string
  provider?: string
  model?: string
  system_prompt?: string
  temperature?: number
  is_active?: boolean
  auto_reply_enabled?: boolean
  auto_reply_threshold?: number
  auto_reply_daily_cap?: number
}

export async function POST(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const provider = (body.provider ?? 'openrouter') as AiProvider
  if (!AI_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: 'Unknown provider' },
      { status: 400 },
    )
  }

  const temperature = Number(body.temperature ?? 0.3)
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    return NextResponse.json(
      { error: 'temperature must be between 0 and 2' },
      { status: 400 },
    )
  }

  // Range-validate auto-reply fields when supplied.
  let auto_reply_threshold: number | undefined
  if (body.auto_reply_threshold !== undefined) {
    const v = Number(body.auto_reply_threshold)
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      return NextResponse.json(
        { error: 'auto_reply_threshold must be between 0 and 1' },
        { status: 400 },
      )
    }
    auto_reply_threshold = v
  }
  let auto_reply_daily_cap: number | undefined
  if (body.auto_reply_daily_cap !== undefined) {
    const v = Math.floor(Number(body.auto_reply_daily_cap))
    if (!Number.isFinite(v) || v < 0 || v > 1000) {
      return NextResponse.json(
        { error: 'auto_reply_daily_cap must be between 0 and 1000' },
        { status: 400 },
      )
    }
    auto_reply_daily_cap = v
  }

  try {
    const agent = await upsertAgent(db, {
      name: (body.name ?? 'Agente IA').trim() || 'Agente IA',
      provider,
      model: (body.model ?? '').trim(),
      system_prompt: body.system_prompt ?? '',
      temperature,
      is_active: !!body.is_active,
      auto_reply_enabled:
        body.auto_reply_enabled === undefined
          ? undefined
          : !!body.auto_reply_enabled,
      auto_reply_threshold,
      auto_reply_daily_cap,
    })
    return NextResponse.json({ agent }, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to save agent' },
      { status: 500 },
    )
  }
}
