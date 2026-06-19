import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { AgentNotConfiguredError, runAgent } from '@/lib/ai/agent'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

async function buildCustomerContext(
  db: SupabaseClient,
  userId: string,
  contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null

  const [contactRes, ordersRes] = await Promise.all([
    db
      .from('contacts')
      .select('name, phone, email, company, tags:contact_tags(tag:tags(name))')
      .eq('id', contactId)
      .eq('user_id', userId)
      .maybeSingle(),
    db
      .from('orders')
      .select('order_number, status, total_amount, currency, ordered_at, line_items')
      .eq('contact_id', contactId)
      .eq('user_id', userId)
      .order('ordered_at', { ascending: false })
      .limit(5),
  ])

  if (!contactRes.data) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = contactRes.data as unknown as {
    name: string | null
    phone: string | null
    email: string | null
    company: string | null
    tags: { tag: { name: string } | null }[]
  }

  const tagNames = c.tags?.map((t) => t.tag?.name).filter(Boolean) ?? []

  const lines: string[] = [
    `Nome: ${c.name ?? 'desconhecido'}`,
    c.phone ? `Telefone: ${c.phone}` : null,
    c.email ? `E-mail: ${c.email}` : null,
    c.company ? `Empresa: ${c.company}` : null,
    tagNames.length > 0 ? `Tags: ${tagNames.join(', ')}` : null,
  ].filter((l): l is string => l !== null)

  const orders = (ordersRes.data ?? []) as {
    order_number: string | null
    status: string
    total_amount: number
    currency: string
    ordered_at: string
    line_items: { name: string; quantity: number }[]
  }[]

  if (orders.length > 0) {
    lines.push('', `Últimos ${orders.length} pedido(s):`)
    for (const o of orders) {
      const items =
        Array.isArray(o.line_items) && o.line_items.length > 0
          ? o.line_items.map((i) => `${i.quantity}x ${i.name}`).join(', ')
          : 'itens não disponíveis'
      const date = o.ordered_at ? o.ordered_at.slice(0, 10) : '?'
      lines.push(
        `  • Pedido ${o.order_number ?? '?'} | ${date} | ${o.status} | ${o.currency} ${Number(o.total_amount).toFixed(2)} | ${items}`,
      )
    }
  } else {
    lines.push('', 'Pedidos: nenhum pedido encontrado.')
  }

  return lines.join('\n')
}

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

  const customerContext = await buildCustomerContext(db, user.id, body.contact_id ?? null)

  try {
    const result = await runAgent(db, {
      query,
      contact_id: body.contact_id ?? null,
      customerContext,
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
