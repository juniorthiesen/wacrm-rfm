import type { SupabaseClient } from '@supabase/supabase-js'
import { getProvider } from './providers'
import { loadAgent, loadProviderKeyDecrypted } from './queries'
import type { AiChatMessage } from './types'

/**
 * Learning extractor.
 *
 * Given a (customer question, human reply) pair, asks the LLM whether
 * the reply contains a reusable fact about the business — something
 * that would help answer similar questions in the future. If yes,
 * proposes a knowledge-base entry; if no, returns null and we don't
 * enqueue.
 *
 * Why a separate small model run instead of "always queue":
 *   The vast majority of human replies are conversational
 *   ("ok, cool", "thanks!", "let me check"). Filtering them out at
 *   extract-time keeps the approval queue useful — operators won't
 *   triage hundreds of empty candidates.
 *
 * Why approval-required despite the filter:
 *   The LLM still hallucinates. A misextracted fact in the KB is
 *   worse than no KB at all, because the agent will cite it
 *   confidently next time. Human sign-off stays in the loop.
 */

export interface ExtractInput {
  customerQuestion: string
  humanReply: string
  contactId?: string | null
}

export interface ExtractResult {
  /** null when no reusable fact was found. */
  candidate: { title: string; content: string } | null
  /** Logged run id for audit. */
  run_id: string | null
}

const EXTRACTION_SYSTEM = [
  'You analyse pairs of (customer question, agent reply) from a CRM and decide',
  'whether the agent reply contains a REUSABLE fact about the business that should',
  'be added to a knowledge base for future answers.',
  '',
  'Rules:',
  '- Only extract facts that would help answer SIMILAR future questions.',
  '- IGNORE: greetings, status updates ("checking now"), one-off promises,',
  '  personal/private data, anything specific to a single customer.',
  '- KEEP: business hours, policies, prices, procedures, addresses,',
  '  product specs, FAQ-shaped facts.',
  '- Title must be a concise topic (3–8 words).',
  '- Content must be self-contained — readable without the original conversation.',
  '- Always reply in the same language as the agent reply.',
  '',
  'Respond with STRICT JSON, no markdown fence, no commentary:',
  '  { "extract": true,  "title": "…", "content": "…" }',
  '  { "extract": false, "reason": "…" }',
].join('\n')

/**
 * Best-effort JSON extraction. Some models wrap output in ```json fences
 * despite instructions; we strip those before parsing.
 */
function parseExtraction(
  raw: string,
): { title: string; content: string } | null {
  let cleaned = raw.trim()
  // Strip ```json … ``` fences if present.
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fenceMatch) cleaned = fenceMatch[1].trim()

  let obj: unknown
  try {
    obj = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const r = obj as Record<string, unknown>
  if (r.extract !== true) return null
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  const content = typeof r.content === 'string' ? r.content.trim() : ''
  if (!title || !content) return null
  return { title, content }
}

export async function extractKnowledgeCandidate(
  db: SupabaseClient,
  input: ExtractInput,
): Promise<ExtractResult> {
  const question = input.customerQuestion.trim()
  const answer = input.humanReply.trim()
  if (!question || !answer) {
    return { candidate: null, run_id: null }
  }

  const agent = await loadAgent(db)
  if (!agent) throw new Error('No AI agent configured')
  const apiKey = await loadProviderKeyDecrypted(db, agent.provider)
  if (!apiKey) throw new Error('No API key configured')

  const client = getProvider(agent.provider, apiKey, { appName: 'wacrm' })

  const messages: AiChatMessage[] = [
    { role: 'system', content: EXTRACTION_SYSTEM },
    {
      role: 'user',
      content: [
        '<customer_question>',
        question,
        '</customer_question>',
        '',
        '<agent_reply>',
        answer,
        '</agent_reply>',
      ].join('\n'),
    },
  ]

  const startedAt = Date.now()
  let chat
  let runError: string | null = null
  try {
    chat = await client.chat({
      // Low temperature — the extractor should be deterministic.
      // We re-use the agent's model so cost is predictable.
      model: agent.model,
      messages,
      temperature: 0.1,
    })
  } catch (e) {
    runError = e instanceof Error ? e.message : 'unknown_error'
  }
  const latency_ms = Date.now() - startedAt

  const text = chat?.text ?? ''
  const candidate = runError ? null : parseExtraction(text)

  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Log as a separate row — same table as suggest runs, just a
  // different "kind" via prefixed input. (No dedicated `kind` column
  // because we don't want migration 020 just for this; the prefix
  // lets us filter cheaply later.)
  const { data: runRow } = await db
    .from('ai_agent_runs')
    .insert({
      user_id: user.id,
      agent_id: agent.id,
      contact_id: input.contactId ?? null,
      provider: agent.provider,
      model: chat?.model ?? agent.model,
      input: `[learning-extract]\nQ: ${question}\nA: ${answer}`,
      output: runError ? null : text,
      tokens_in: chat?.usage.tokens_in ?? null,
      tokens_out: chat?.usage.tokens_out ?? null,
      latency_ms,
      status: runError ? 'error' : 'success',
      error_message: runError,
    })
    .select('id')
    .single()

  if (runError) throw new Error(runError)
  return {
    candidate,
    run_id: (runRow as { id: string } | null)?.id ?? null,
  }
}

export const __testing = { parseExtraction }
