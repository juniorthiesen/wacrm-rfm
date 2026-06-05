import type { AiProvider, LLMProvider } from '../types'
import { OpenRouterProvider } from './openrouter'

/**
 * Provider registry.
 *
 * Today only `openrouter` is wired up — a single API key on OpenRouter
 * gives users access to OpenAI, Anthropic, Gemini, Llama, DeepSeek and
 * dozens more, so it covers the "flexible provider" requirement in
 * Phase 1 without us shipping four adapters.
 *
 * To add a direct adapter later: implement `LLMProvider` in
 * `./openai.ts` (or similar) and extend the switch below. Call sites
 * (ai/agent.ts, ai/embeddings.ts) never name a provider class — they
 * always go through `getProvider`.
 */
export function getProvider(
  provider: AiProvider,
  apiKey: string,
  options?: { siteUrl?: string; appName?: string },
): LLMProvider {
  switch (provider) {
    case 'openrouter':
      return new OpenRouterProvider(
        apiKey,
        options?.siteUrl,
        options?.appName,
      )
    case 'openai':
    case 'anthropic':
    case 'gemini':
      throw new Error(
        `Provider "${provider}" not implemented yet. Use OpenRouter to access models from this vendor.`,
      )
    default: {
      const _exhaustive: never = provider
      throw new Error(`Unknown provider: ${String(_exhaustive)}`)
    }
  }
}

export { OpenRouterProvider }
