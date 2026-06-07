import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { engineSendText } from '@/lib/automations/meta-send'
import { getProvider } from './providers'
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  type AiAgent,
  type AiChatMessage,
} from './types'
import { buildSystemPrompt } from './agent'
import { toPgVector, type KnowledgeMatch } from './embeddings'

/**
 * Auto-reply pipeline — Phase 5.
 *
 * Runs in webhook context, so we never call `db.auth.getUser()` (no
 * cookies). Caller passes `userId` explicitly.
 *
 * Flow:
 *   1. Bail unless an agent exists, is active, and has auto-reply on.
 *   2. KB cosine search via `match_ai_knowledge_admin` (service-role
 *      RPC that takes user_id as argument).
 *   3. Bail if best similarity < `auto_reply_threshold`.
 *   4. Bail if today's sent count >= `auto_reply_daily_cap`.
 *   5. Call provider.chat with the same system prompt the copilot
 *      uses (so behaviour is consistent between manual + auto).
 *   6. Send via `engineSendText` (the automation engine's Meta
 *      helper — already deals with phone variants and the bot
 *      sender_type row insert).
 *   7. Log the decision in ai_auto_reply_log (success or any
 *      skipped/error branch — so operators can answer "why didn't
 *      it reply?" without crawling ai_agent_runs).
 *
 * Fire-and-forget from the webhook's perspective: throws are caught
 * by the caller, never propagate to the 200 OK response to Meta.
 */

export interface MaybeAutoReplyArgs {
  /** Admin (service-role) Supabase client — same one the webhook uses. */
  db: SupabaseClient
  userId: string
  contactId: string
  conversationId: string
  messageText: string
}

type Outcome =
  | 'sent'
  | 'skipped_disabled'
  | 'skipped_low_confidence'
  | 'skipped_cap'
  | 'skipped_no_kb'
  | 'skipped_empty_output'
  | 'error'

export interface MaybeAutoReplyResult {
  outcome: Outcome
  /** Filled when outcome === 'sent'. */
  whatsapp_message_id?: string
  best_similarity?: number
  error?: string
}

async function loadAgentForUser(
  db: SupabaseClient,
  userId: string,
): Promise<AiAgent | null> {
  const { data } = await db
    .from('ai_agents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data as AiAgent | null) ?? null
}

async function loadProviderKey(
  db: SupabaseClient,
  userId: string,
  provider: string,
): Promise<string | null> {
  const { data } = await db
    .from('ai_provider_keys')
    .select('encrypted_key')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle()
  if (!data) return null
  try {
    return decrypt((data as { encrypted_key: string }).encrypted_key)
  } catch {
    return null
  }
}

/**
 * Count today's sent auto-replies for this agent. UTC day boundary —
 * same as the rest of the analytics pipeline.
 */
async function sentTodayCount(
  db: SupabaseClient,
  agentId: string,
): Promise<number> {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  const { count } = await db
    .from('ai_auto_reply_log')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('outcome', 'sent')
    .gte('created_at', start.toISOString())
  return count ?? 0
}

async function searchKnowledgeAdmin(
  db: SupabaseClient,
  userId: string,
  query: string,
  apiKey: string,
  provider: string,
): Promise<KnowledgeMatch[]> {
  const client = getProvider(provider as AiAgent['provider'], apiKey, {
    appName: 'wacrm',
  })
  const { embedding } = await client.embed({
    model: DEFAULT_EMBEDDING_MODEL,
    input: query,
  })
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `provider returned ${embedding.length}-dim embedding (expected ${EMBEDDING_DIMENSIONS})`,
    )
  }
  const { data, error } = await db.rpc('match_ai_knowledge_admin', {
    caller_user_id: userId,
    query_embedding: toPgVector(embedding),
    match_count: 5,
    // Permissive threshold here — the confidence gate below uses
    // `auto_reply_threshold` from the agent config to decide whether
    // to actually send.
    match_threshold: 0.2,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as KnowledgeMatch[]
}

async function logDecision(
  db: SupabaseClient,
  fields: {
    userId: string
    agentId: string | null
    contactId: string
    conversationId: string
    inboundText: string
    bestSimilarity: number | null
    outcome: Outcome
    runId?: string | null
    sentMessageId?: string | null
    errorMessage?: string | null
  },
): Promise<void> {
  await db.from('ai_auto_reply_log').insert({
    user_id: fields.userId,
    agent_id: fields.agentId,
    contact_id: fields.contactId,
    conversation_id: fields.conversationId,
    inbound_text: fields.inboundText,
    best_similarity: fields.bestSimilarity,
    outcome: fields.outcome,
    run_id: fields.runId ?? null,
    sent_message_id: fields.sentMessageId ?? null,
    error_message: fields.errorMessage ?? null,
  })
}

export async function maybeAutoReply(
  args: MaybeAutoReplyArgs,
): Promise<MaybeAutoReplyResult> {
  const { db, userId, contactId, conversationId, messageText } = args
  const query = messageText.trim()
  if (!query) return { outcome: 'skipped_disabled' }

  const agent = await loadAgentForUser(db, userId)
  if (!agent || !agent.is_active || !agent.auto_reply_enabled) {
    return { outcome: 'skipped_disabled' }
  }

  const apiKey = await loadProviderKey(db, userId, agent.provider)
  if (!apiKey) {
    await logDecision(db, {
      userId,
      agentId: agent.id,
      contactId,
      conversationId,
      inboundText: query,
      bestSimilarity: null,
      outcome: 'error',
      errorMessage: 'no_api_key',
    })
    return { outcome: 'error', error: 'no_api_key' }
  }

  // Daily cap check before any LLM cost.
  const sentToday = await sentTodayCount(db, agent.id)
  if (sentToday >= agent.auto_reply_daily_cap) {
    await logDecision(db, {
      userId,
      agentId: agent.id,
      contactId,
      conversationId,
      inboundText: query,
      bestSimilarity: null,
      outcome: 'skipped_cap',
    })
    return { outcome: 'skipped_cap' }
  }

  // KB search.
  let matches: KnowledgeMatch[] = []
  try {
    matches = await searchKnowledgeAdmin(
      db,
      userId,
      query,
      apiKey,
      agent.provider,
    )
  } catch (e) {
    await logDecision(db, {
      userId,
      agentId: agent.id,
      contactId,
      conversationId,
      inboundText: query,
      bestSimilarity: null,
      outcome: 'error',
      errorMessage: e instanceof Error ? e.message : 'kb_search_failed',
    })
    return { outcome: 'error', error: 'kb_search_failed' }
  }

  const best = matches[0]?.similarity ?? 0
  if (matches.length === 0) {
    await logDecision(db, {
      userId,
      agentId: agent.id,
      contactId,
      conversationId,
      inboundText: query,
      bestSimilarity: 0,
      outcome: 'skipped_no_kb',
    })
    return { outcome: 'skipped_no_kb', best_similarity: 0 }
  }
  if (best < Number(agent.auto_reply_threshold)) {
    await logDecision(db, {
      userId,
      agentId: agent.id,
      contactId,
      conversationId,
      inboundText: query,
      bestSimilarity: best,
      outcome: 'skipped_low_confidence',
    })
    return { outcome: 'skipped_low_confidence', best_similarity: best }
  }

  // LLM chat.
  const messages: AiChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(agent.system_prompt, matches) },
    { role: 'user', content: query },
  ]
  const client = getProvider(agent.provider, apiKey, { appName: 'wacrm' })
  const startedAt = Date.now()
  let chat
  let runError: string | null = null
  try {
    chat = await client.chat({
      model: agent.model,
      messages,
      temperature: Number(agent.temperature),
    })
  } catch (e) {
    runError = e instanceof Error ? e.message : 'unknown_error'
  }
  const latency_ms = Date.now() - startedAt

  // Log the LLM run (same table runAgent uses, so cost dashboards
  // include auto-replies).
  const { data: runRow } = await db
    .from('ai_agent_runs')
    .insert({
      user_id: userId,
      agent_id: agent.id,
      contact_id: contactId,
      provider: agent.provider,
      model: chat?.model ?? agent.model,
      input: `[auto-reply] ${query}`,
      output: runError ? null : chat?.text,
      tokens_in: chat?.usage.tokens_in ?? null,
      tokens_out: chat?.usage.tokens_out ?? null,
      latency_ms,
      status: runError ? 'error' : 'success',
      error_message: runError,
    })
    .select('id')
    .single()

  const runId = (runRow as { id: string } | null)?.id ?? null
  const text = chat?.text?.trim() ?? ''

  if (runError) {
    await logDecision(db, {
      userId,
      agentId: agent.id,
      contactId,
      conversationId,
      inboundText: query,
      bestSimilarity: best,
      outcome: 'error',
      runId,
      errorMessage: runError,
    })
    return { outcome: 'error', error: runError, best_similarity: best }
  }
  if (!text) {
    await logDecision(db, {
      userId,
      agentId: agent.id,
      contactId,
      conversationId,
      inboundText: query,
      bestSimilarity: best,
      outcome: 'skipped_empty_output',
      runId,
    })
    return { outcome: 'skipped_empty_output', best_similarity: best }
  }

  // Send via Meta. engineSendText also persists the outbound message
  // with sender_type='bot' so the inbox UI shows it correctly.
  try {
    const sent = await engineSendText({
      userId,
      conversationId,
      contactId,
      text,
    })
    await logDecision(db, {
      userId,
      agentId: agent.id,
      contactId,
      conversationId,
      inboundText: query,
      bestSimilarity: best,
      outcome: 'sent',
      runId,
      sentMessageId: sent.whatsapp_message_id,
    })
    return {
      outcome: 'sent',
      whatsapp_message_id: sent.whatsapp_message_id,
      best_similarity: best,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'send_failed'
    await logDecision(db, {
      userId,
      agentId: agent.id,
      contactId,
      conversationId,
      inboundText: query,
      bestSimilarity: best,
      outcome: 'error',
      runId,
      errorMessage: msg,
    })
    return { outcome: 'error', error: msg, best_similarity: best }
  }
}
