import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/providers'
import { loadProviderKeyDecrypted } from '@/lib/ai/queries'
import { AI_PROVIDERS, type AiProvider } from '@/lib/ai/types'

/**
 * POST /api/ai/test-connection
 *
 * Body: { provider: AiProvider, apiKey?: string }
 *
 * Two modes:
 *   - With `apiKey` in the body → test the supplied key without
 *     persisting. Used by the settings panel right after the user
 *     pastes a key, before they click Save.
 *   - Without `apiKey` → load the stored encrypted key for the
 *     current user and test it. Used to re-validate a saved key.
 *
 * Returns { ok: true } or { ok: false, error: string }. The error
 * string comes verbatim from the provider so the user can see
 * "Invalid API key" vs "Rate limited" vs "Network".
 */
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

  const provider = body.provider as AiProvider | undefined
  if (!provider || !AI_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: 'Unknown provider' },
      { status: 400 },
    )
  }

  let apiKey = (body.apiKey ?? '').trim()
  if (!apiKey) {
    const stored = await loadProviderKeyDecrypted(db, provider)
    if (!stored) {
      return NextResponse.json(
        { ok: false, error: 'No API key configured' },
        { status: 200 },
      )
    }
    apiKey = stored
  }

  try {
    const client = getProvider(provider, apiKey, { appName: 'wacrm' })
    const result = await client.verifyKey()
    return NextResponse.json(result, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : 'Unknown error',
      },
      { status: 200 },
    )
  }
}
