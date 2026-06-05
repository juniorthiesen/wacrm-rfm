import type {
  AiChatRequest,
  AiChatResponse,
  AiEmbedRequest,
  AiEmbedResponse,
  LLMProvider,
} from '../types'

/**
 * OpenRouter adapter.
 *
 * OpenRouter speaks an OpenAI-compatible JSON API at /api/v1, plus
 * /api/v1/auth/key as a cheap "is this key valid" probe. We use that
 * for the Test Connection button so we don't burn tokens on a chat
 * call just to validate credentials.
 *
 * Headers:
 *   `HTTP-Referer` and `X-Title` are recommended by OpenRouter for
 *   attribution in their dashboard. They're optional — sending the
 *   site URL helps with rate-limit prioritisation on their side.
 */

const BASE_URL = 'https://openrouter.ai/api/v1'

interface OpenRouterChatChoice {
  message?: { content?: string | null }
}

interface OpenRouterChatResponse {
  choices?: OpenRouterChatChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
  model?: string
  error?: { message?: string; code?: number | string }
}

interface OpenRouterEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>
  model?: string
  error?: { message?: string }
}

export class OpenRouterProvider implements LLMProvider {
  readonly id = 'openrouter' as const

  constructor(
    private readonly apiKey: string,
    /** Public site URL — sent as `HTTP-Referer` for attribution. */
    private readonly siteUrl?: string,
    /** App name — sent as `X-Title` for attribution. */
    private readonly appName: string = 'wacrm',
  ) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': this.appName,
    }
    if (this.siteUrl) h['HTTP-Referer'] = this.siteUrl
    return h
  }

  async chat(req: AiChatRequest): Promise<AiChatResponse> {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
      }),
    })

    const data = (await resp.json().catch(() => ({}))) as OpenRouterChatResponse

    if (!resp.ok || data.error) {
      const msg = data.error?.message ?? `OpenRouter HTTP ${resp.status}`
      throw new Error(msg)
    }

    const text = data.choices?.[0]?.message?.content?.trim() ?? ''

    return {
      text,
      usage: {
        tokens_in: data.usage?.prompt_tokens ?? null,
        tokens_out: data.usage?.completion_tokens ?? null,
      },
      model: data.model ?? req.model,
    }
  }

  async embed(req: AiEmbedRequest): Promise<AiEmbedResponse> {
    const resp = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: req.model, input: req.input }),
    })

    const data = (await resp.json().catch(
      () => ({}),
    )) as OpenRouterEmbeddingResponse

    if (!resp.ok || data.error) {
      const msg = data.error?.message ?? `OpenRouter HTTP ${resp.status}`
      throw new Error(msg)
    }

    const embedding = data.data?.[0]?.embedding
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('OpenRouter returned no embedding')
    }

    return {
      embedding,
      model: data.model ?? req.model,
    }
  }

  async verifyKey(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const resp = await fetch(`${BASE_URL}/auth/key`, {
        method: 'GET',
        headers: this.headers(),
      })
      if (resp.ok) return { ok: true }
      const data = (await resp.json().catch(() => ({}))) as {
        error?: { message?: string }
      }
      return {
        ok: false,
        error: data.error?.message ?? `HTTP ${resp.status}`,
      }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'unknown error',
      }
    }
  }
}
