/**
 * Shared types for the AI Agent feature.
 *
 * Provider-neutral on purpose — OpenRouter is the only backend right
 * now, but the same shapes are designed to fit OpenAI/Anthropic/Gemini
 * adapters added later without changes to call sites.
 */

export type AiProvider = 'openrouter' | 'openai' | 'anthropic' | 'gemini'

export const AI_PROVIDERS: readonly AiProvider[] = [
  'openrouter',
  'openai',
  'anthropic',
  'gemini',
] as const

export interface AiAgent {
  id: string
  user_id: string
  name: string
  provider: AiProvider
  model: string
  system_prompt: string
  /** 0..2 inclusive. */
  temperature: number
  is_active: boolean
  /**
   * Phase 5 — when true AND `is_active`, the webhook calls
   * maybeAutoReply for inbound messages not consumed by a Flow.
   */
  auto_reply_enabled: boolean
  /** Cosine similarity floor (0..1) for auto-reply to send. */
  auto_reply_threshold: number
  /** Hard ceiling on sent auto-replies per UTC day. */
  auto_reply_daily_cap: number
  created_at: string
  updated_at: string
}

/**
 * Shape returned to the UI for the "do you have a key?" check.
 * The encrypted value never leaves the server.
 */
export interface AiProviderKeyStatus {
  provider: AiProvider
  has_key: boolean
  updated_at: string | null
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiChatRequest {
  model: string
  messages: AiChatMessage[]
  temperature?: number
  /** Optional cap on output tokens. */
  max_tokens?: number
}

export interface AiChatResponse {
  text: string
  usage: {
    /** Prompt tokens (input). null when provider doesn't report. */
    tokens_in: number | null
    /** Completion tokens (output). null when provider doesn't report. */
    tokens_out: number | null
  }
  /** Model id the provider actually ran (some routers fall back). */
  model: string
}

export interface AiEmbedRequest {
  model: string
  input: string
}

export interface AiEmbedResponse {
  embedding: number[]
  model: string
}

/**
 * Lowest-common-denominator provider interface. Each backend (OpenRouter,
 * OpenAI direct, Anthropic, Gemini) implements this and is keyed by the
 * `AiProvider` discriminant in the registry.
 */
export interface LLMProvider {
  readonly id: AiProvider
  chat(req: AiChatRequest): Promise<AiChatResponse>
  embed(req: AiEmbedRequest): Promise<AiEmbedResponse>
  /**
   * Cheap auth-probe used by the "Test connection" button in the UI.
   * Should hit a no-cost or very-cheap endpoint and surface the
   * provider's own error string verbatim so users can diagnose
   * (rate limit vs. revoked key vs. wrong format).
   */
  verifyKey(): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * Default model picked when a workspace creates its first agent.
 * 4o-mini via OpenRouter is the cheapest "good enough" baseline at the
 * time of writing and is universally available — change in the agent
 * UI as needed.
 */
export const DEFAULT_MODEL = 'openai/gpt-4o-mini'

/**
 * Embedding model used to vectorise KB entries. 1536 dims to match
 * the column in migration 018. Available on OpenRouter and OpenAI
 * direct under the same id.
 */
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536
