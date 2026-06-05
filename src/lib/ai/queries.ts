import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import type {
  AiAgent,
  AiProvider,
  AiProviderKeyStatus,
} from './types'
import { DEFAULT_MODEL } from './types'

/**
 * AI Agent CRUD and provider-key helpers.
 *
 * All queries are scoped by RLS — pass a Supabase client created with
 * the cookie-bound session (i.e. lib/supabase/server `createClient`)
 * and you'll only see the current user's rows.
 *
 * Provider keys: writes encrypt with the GCM helper in
 * lib/whatsapp/encryption (shared ENCRYPTION_KEY). Reads decrypt only
 * server-side via `loadProviderKeyDecrypted`; the browser-facing
 * status helper returns only { has_key: bool, updated_at }.
 */

// ─── Agent ───────────────────────────────────────────────────────────────────

export async function loadAgent(db: SupabaseClient): Promise<AiAgent | null> {
  const { data } = await db
    .from('ai_agents')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data as AiAgent | null) ?? null
}

export interface UpsertAgentInput {
  name: string
  provider: AiProvider
  model: string
  system_prompt: string
  temperature: number
  is_active: boolean
  /** Phase 5 auto-reply toggle. */
  auto_reply_enabled?: boolean
  /** 0..1 cosine similarity floor. */
  auto_reply_threshold?: number
  /** Max sent auto-replies per UTC day. */
  auto_reply_daily_cap?: number
}

export async function upsertAgent(
  db: SupabaseClient,
  input: UpsertAgentInput,
): Promise<AiAgent> {
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const existing = await loadAgent(db)

  // Optional auto-reply fields — undefined ⇒ keep DB default / current value.
  const optional: Record<string, unknown> = {}
  if (input.auto_reply_enabled !== undefined)
    optional.auto_reply_enabled = input.auto_reply_enabled
  if (input.auto_reply_threshold !== undefined)
    optional.auto_reply_threshold = input.auto_reply_threshold
  if (input.auto_reply_daily_cap !== undefined)
    optional.auto_reply_daily_cap = input.auto_reply_daily_cap

  if (existing) {
    const { data, error } = await db
      .from('ai_agents')
      .update({
        name: input.name,
        provider: input.provider,
        model: input.model || DEFAULT_MODEL,
        system_prompt: input.system_prompt,
        temperature: input.temperature,
        is_active: input.is_active,
        ...optional,
      })
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)
    return data as AiAgent
  }

  const { data, error } = await db
    .from('ai_agents')
    .insert({
      user_id: user.id,
      name: input.name,
      provider: input.provider,
      model: input.model || DEFAULT_MODEL,
      system_prompt: input.system_prompt,
      temperature: input.temperature,
      is_active: input.is_active,
      ...optional,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data as AiAgent
}

// ─── Provider keys ───────────────────────────────────────────────────────────

/**
 * Browser-safe key status — does NOT return the key itself, only
 * whether one is stored and when it was last touched.
 */
export async function loadProviderKeyStatus(
  db: SupabaseClient,
  provider: AiProvider,
): Promise<AiProviderKeyStatus> {
  const { data } = await db
    .from('ai_provider_keys')
    .select('provider, updated_at')
    .eq('provider', provider)
    .maybeSingle()
  return {
    provider,
    has_key: !!data,
    updated_at:
      (data as { updated_at?: string } | null)?.updated_at ?? null,
  }
}

/**
 * Server-only — never call from a route that returns to the browser
 * with the result. Used by the agent runner and the test-connection
 * endpoint.
 */
export async function loadProviderKeyDecrypted(
  db: SupabaseClient,
  provider: AiProvider,
): Promise<string | null> {
  const { data } = await db
    .from('ai_provider_keys')
    .select('encrypted_key')
    .eq('provider', provider)
    .maybeSingle()
  if (!data) return null
  try {
    return decrypt((data as { encrypted_key: string }).encrypted_key)
  } catch {
    // Treat a decrypt failure (key rotated, corrupted row) as "no key"
    // so the UI prompts the user to paste again instead of crashing.
    return null
  }
}

export async function saveProviderKey(
  db: SupabaseClient,
  provider: AiProvider,
  apiKey: string,
): Promise<void> {
  const trimmed = apiKey.trim()
  if (!trimmed) throw new Error('API key is empty')

  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const encrypted = encrypt(trimmed)
  const { error } = await db
    .from('ai_provider_keys')
    .upsert(
      {
        user_id: user.id,
        provider,
        encrypted_key: encrypted,
      },
      { onConflict: 'user_id,provider' },
    )
  if (error) throw new Error(error.message)
}

export async function deleteProviderKey(
  db: SupabaseClient,
  provider: AiProvider,
): Promise<void> {
  const { error } = await db
    .from('ai_provider_keys')
    .delete()
    .eq('provider', provider)
  if (error) throw new Error(error.message)
}
