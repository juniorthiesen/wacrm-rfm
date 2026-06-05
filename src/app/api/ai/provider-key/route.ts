import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  deleteProviderKey,
  loadProviderKeyStatus,
  saveProviderKey,
} from '@/lib/ai/queries'
import { AI_PROVIDERS, type AiProvider } from '@/lib/ai/types'

/**
 * /api/ai/provider-key
 *
 * GET    ?provider=openrouter → { provider, has_key, updated_at }
 *                               Never returns the key itself.
 * POST   { provider, apiKey } → encrypts and stores.
 * DELETE ?provider=openrouter → removes the row.
 *
 * Encryption happens server-side via the GCM helper that already
 * protects WhatsApp tokens. The browser never sees the encrypted
 * value either — only the boolean "has_key" status.
 */

function parseProvider(raw: string | null): AiProvider | null {
  if (!raw) return null
  return (AI_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as AiProvider)
    : null
}

export async function GET(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const provider = parseProvider(url.searchParams.get('provider'))
  if (!provider) {
    return NextResponse.json(
      { error: 'Unknown or missing provider' },
      { status: 400 },
    )
  }

  const status = await loadProviderKeyStatus(db, provider)
  return NextResponse.json(status, { status: 200 })
}

export async function POST(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { provider?: string; apiKey?: string }
  try {
    body = (await req.json()) as { provider?: string; apiKey?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const provider = parseProvider(body.provider ?? null)
  if (!provider) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })
  }
  const apiKey = (body.apiKey ?? '').trim()
  if (!apiKey) {
    return NextResponse.json({ error: 'apiKey is required' }, { status: 400 })
  }

  try {
    await saveProviderKey(db, provider, apiKey)
    const status = await loadProviderKeyStatus(db, provider)
    return NextResponse.json(status, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to save key' },
      { status: 500 },
    )
  }
}

export async function DELETE(req: Request) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const provider = parseProvider(url.searchParams.get('provider'))
  if (!provider) {
    return NextResponse.json(
      { error: 'Unknown or missing provider' },
      { status: 400 },
    )
  }

  try {
    await deleteProviderKey(db, provider)
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to delete key' },
      { status: 500 },
    )
  }
}
