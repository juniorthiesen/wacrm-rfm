import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './agent'
import type { KnowledgeMatch } from './embeddings'

function fakeMatch(title: string, content: string, similarity = 0.8): KnowledgeMatch {
  return {
    id: 'fake-' + title,
    title,
    content,
    source: 'manual',
    similarity,
  }
}

describe('buildSystemPrompt', () => {
  it('inlines knowledge matches inside the system message', () => {
    const out = buildSystemPrompt('You are a helpful agent.', [
      fakeMatch('Horário', 'Atendemos 9h–18h.', 0.91),
      fakeMatch('Endereço', 'Rua A, 123', 0.55),
    ])
    expect(out).toContain('You are a helpful agent.')
    expect(out).toContain('KNOWLEDGE BASE')
    expect(out).toContain('[1] Horário')
    expect(out).toContain('Atendemos 9h–18h.')
    expect(out).toContain('[2] Endereço')
    // Similarity is exposed so the model can reason about confidence.
    expect(out).toContain('0.910')
  })

  it('produces a usable prompt even when KB is empty', () => {
    const out = buildSystemPrompt('Be polite.', [])
    expect(out).toContain('Be polite.')
    expect(out).toContain('(empty for this question)')
  })

  it('keeps the operator instructions BEFORE the guardrail', () => {
    // The guardrail tells the model to prefer KB and reply in the
    // customer's language. We want the operator's instructions to
    // appear first so the model treats them as the primary brief.
    const out = buildSystemPrompt('CUSTOM-OPERATOR-RULE', [])
    const opIdx = out.indexOf('CUSTOM-OPERATOR-RULE')
    const guardrailIdx = out.indexOf('knowledge base')
    expect(opIdx).toBeGreaterThanOrEqual(0)
    expect(guardrailIdx).toBeGreaterThan(opIdx)
  })

  it('trims surrounding whitespace from operator instructions', () => {
    const out = buildSystemPrompt('   spaced   ', [])
    // The trimmed value appears, raw whitespace doesn't leak as the
    // first character of the prompt.
    expect(out.startsWith('spaced')).toBe(true)
  })
})
