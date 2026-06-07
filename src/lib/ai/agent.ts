import type { SupabaseClient } from '@supabase/supabase-js'
import { getProvider } from './providers'
import { searchKnowledge, type KnowledgeMatch } from './embeddings'
import { loadAgent, loadProviderKeyDecrypted } from './queries'
import type { AiAgent, AiChatMessage } from './types'

/**
 * Agent runner — copiloto pipeline.
 *
 * Phase 1 behaviour:
 *   1. Load the active AI agent for the current user.
 *   2. Search the KB for matches against the user's message.
 *   3. Build a chat with system_prompt + KB context + the message.
 *   4. Call the provider's chat endpoint.
 *   5. Log the run for audit/cost.
 *   6. Return the suggested text + the matches used (so the inbox UI
 *      can show "based on these KB entries").
 *
 * No tool-calling, no streaming, no auto-send — that's Phase 3.
 * Everything here runs server-side (decrypts the API key, talks to
 * the LLM). Never import from a client component.
 */

const KB_LIMIT = 5
/**
 * Permissive threshold — we'd rather show the model a marginally
 * relevant snippet than miss something. The model is instructed to
 * skip irrelevant snippets in `buildSystemPrompt`.
 */
const KB_THRESHOLD = 0.2

export interface RunAgentInput {
  /** The user-facing message the agent should respond to. */
  query: string
  /** Optional — used only for the run log, so we can attribute later. */
  contact_id?: string | null
}

export interface RunAgentResult {
  text: string
  matches: KnowledgeMatch[]
  /** Row id in ai_agent_runs — UI can link to it for debugging. */
  run_id: string
  /** The model the provider actually picked (some routers fall back). */
  model: string
  /** Tokens reported by the provider, when available. */
  tokens_in: number | null
  tokens_out: number | null
  /** Latency wall-clock for the LLM call. */
  latency_ms: number
}

export class AgentNotConfiguredError extends Error {
  constructor(public reason: 'no_agent' | 'inactive' | 'no_key') {
    super(`Agent not configured: ${reason}`)
    this.name = 'AgentNotConfiguredError'
  }
}

/**
 * Compose the system prompt: the user's own instructions, then a
 * fixed "how to use the knowledge base" guardrail, then the matched
 * entries inline. Putting the KB inside the system message (rather
 * than as a separate user turn) keeps the conversation history clean
 * and makes the snippets feel like background knowledge to the model
 * rather than a previous turn it has to acknowledge.
 *
 * Returned as a single string. Exported so the test suite can lock
 * the format without having to mock the LLM.
 */
export function buildSystemPrompt(
  agentInstructions: string,
  matches: KnowledgeMatch[],
): string {
  const guardrail = [
    '',
    '---',
    'You have access to a knowledge base authored by the operator.',
    'Always prefer information from the knowledge base over your own assumptions.',
    'If the knowledge base does not contain the answer, say you do not know and offer to forward to a human agent.',
    'Reply in the same language the customer used. Be concise.',
  ].join('\n')

  if (matches.length === 0) {
    return [
      agentInstructions.trim(),
      guardrail,
      '',
      'KNOWLEDGE BASE: (empty for this question)',
    ].join('\n')
  }

  const kb = matches
    .map(
      (m, i) =>
        `[${i + 1}] ${m.title}\n${m.content}\n(similarity: ${m.similarity.toFixed(3)})`,
    )
    .join('\n\n')

  return [
    agentInstructions.trim(),
    guardrail,
    '',
    'KNOWLEDGE BASE (top matches for the customer\'s message):',
    kb,
  ].join('\n')
}

/**
 * Main entry point. Used by /api/ai/suggest today; could be reused by
 * the auto-reply path in Phase 3 without changes.
 */
export async function runAgent(
  db: SupabaseClient,
  input: RunAgentInput,
): Promise<RunAgentResult> {
  const query = input.query.trim()
  if (!query) throw new Error('query is empty')

  const agent: AiAgent | null = await loadAgent(db)
  if (!agent) throw new AgentNotConfiguredError('no_agent')
  if (!agent.is_active) throw new AgentNotConfiguredError('inactive')

  const apiKey = await loadProviderKeyDecrypted(db, agent.provider)
  if (!apiKey) throw new AgentNotConfiguredError('no_key')

  // KB search. Wrapped in try/catch so a transient embedding failure
  // doesn't block the suggestion — we just run without KB context.
  let matches: KnowledgeMatch[] = []
  try {
    matches = await searchKnowledge(db, query, {
      limit: KB_LIMIT,
      threshold: KB_THRESHOLD,
    })
  } catch {
    matches = []
  }

  const messages: AiChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(agent.system_prompt, matches),
    },
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

  const text = chat?.text ?? ''
  const tokens_in = chat?.usage.tokens_in ?? null
  const tokens_out = chat?.usage.tokens_out ?? null
  const modelUsed = chat?.model ?? agent.model

  // Log the run. We log on both success and failure paths — failures
  // are the most useful rows for debugging.
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: runRow, error: runErr } = await db
    .from('ai_agent_runs')
    .insert({
      user_id: user.id,
      agent_id: agent.id,
      contact_id: input.contact_id ?? null,
      provider: agent.provider,
      model: modelUsed,
      input: query,
      output: runError ? null : text,
      tokens_in,
      tokens_out,
      latency_ms,
      status: runError ? 'error' : 'success',
      error_message: runError,
    })
    .select('id')
    .single()

  if (runError) {
    // Surface the LLM failure after we've logged it.
    throw new Error(runError)
  }
  if (runErr) throw new Error(runErr.message)

  return {
    text,
    matches,
    run_id: (runRow as { id: string }).id,
    model: modelUsed,
    tokens_in,
    tokens_out,
    latency_ms,
  }
}
