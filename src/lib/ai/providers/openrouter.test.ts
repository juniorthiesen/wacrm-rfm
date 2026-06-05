import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider } from './openrouter'

/**
 * fetch is global in Node 20+ / Next 16. We stub it with vi.fn so the
 * tests are hermetic — no network, no real API key needed.
 */
function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(impl as unknown as typeof fetch)
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('OpenRouterProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('chat', () => {
    it('extracts text and usage from a normal response', async () => {
      const spy = stubFetch(() =>
        jsonResponse({
          choices: [{ message: { content: 'Olá!' } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
          model: 'openai/gpt-4o-mini',
        }),
      )

      const p = new OpenRouterProvider('sk-test')
      const res = await p.chat({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'oi' }],
        temperature: 0.5,
      })

      expect(res.text).toBe('Olá!')
      expect(res.usage).toEqual({ tokens_in: 12, tokens_out: 3 })
      expect(res.model).toBe('openai/gpt-4o-mini')

      const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain('/chat/completions')
      const headers = init.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer sk-test')
      const body = JSON.parse(init.body as string)
      expect(body.temperature).toBe(0.5)
    })

    it('throws with provider error message on non-2xx', async () => {
      stubFetch(() =>
        jsonResponse(
          { error: { message: 'Invalid API key', code: 401 } },
          401,
        ),
      )

      const p = new OpenRouterProvider('sk-bad')
      await expect(
        p.chat({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: 'x' }],
        }),
      ).rejects.toThrow('Invalid API key')
    })

    it('returns empty string when content is missing — does not crash', async () => {
      stubFetch(() => jsonResponse({ choices: [{ message: {} }] }))

      const p = new OpenRouterProvider('sk-test')
      const res = await p.chat({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'x' }],
      })
      expect(res.text).toBe('')
      expect(res.usage.tokens_in).toBeNull()
    })

    it('forwards HTTP-Referer + X-Title when siteUrl is provided', async () => {
      const spy = stubFetch(() =>
        jsonResponse({ choices: [{ message: { content: '' } }] }),
      )

      const p = new OpenRouterProvider('sk-test', 'https://crm.example', 'wacrm-test')
      await p.chat({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      })

      const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
      const headers = init.headers as Record<string, string>
      expect(headers['HTTP-Referer']).toBe('https://crm.example')
      expect(headers['X-Title']).toBe('wacrm-test')
    })
  })

  describe('embed', () => {
    it('returns the embedding array', async () => {
      stubFetch(() =>
        jsonResponse({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          model: 'openai/text-embedding-3-small',
        }),
      )

      const p = new OpenRouterProvider('sk-test')
      const res = await p.embed({
        model: 'openai/text-embedding-3-small',
        input: 'horário de funcionamento',
      })

      expect(res.embedding).toEqual([0.1, 0.2, 0.3])
    })

    it('throws if no embedding came back', async () => {
      stubFetch(() => jsonResponse({ data: [] }))
      const p = new OpenRouterProvider('sk-test')
      await expect(
        p.embed({ model: 'm', input: 'x' }),
      ).rejects.toThrow('no embedding')
    })
  })

  describe('verifyKey', () => {
    it('returns ok:true on 200', async () => {
      stubFetch(() => jsonResponse({ data: { label: 'wacrm' } }))
      const p = new OpenRouterProvider('sk-test')
      await expect(p.verifyKey()).resolves.toEqual({ ok: true })
    })

    it('returns ok:false with provider error message on 401', async () => {
      stubFetch(() =>
        jsonResponse({ error: { message: 'No auth credentials found' } }, 401),
      )
      const p = new OpenRouterProvider('sk-bad')
      const res = await p.verifyKey()
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('No auth credentials')
    })

    it('does not throw on network error — returns structured failure', async () => {
      stubFetch(() => {
        throw new Error('ECONNREFUSED')
      })
      const p = new OpenRouterProvider('sk-test')
      const res = await p.verifyKey()
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('ECONNREFUSED')
    })
  })
})
