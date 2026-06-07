import { describe, expect, it } from 'vitest'
import { toPgVector } from './embeddings'
import { EMBEDDING_DIMENSIONS } from './types'

describe('toPgVector', () => {
  it('formats a valid vector as a pgvector literal', () => {
    const v = new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => i / 1000)
    const out = toPgVector(v)
    expect(out.startsWith('[')).toBe(true)
    expect(out.endsWith(']')).toBe(true)
    // No spaces — pgvector accepts both forms but our impl emits compact.
    expect(out).not.toContain(' ')
    expect(out.split(',')).toHaveLength(EMBEDDING_DIMENSIONS)
  })

  it('throws on wrong dimension count — catches model swap regressions', () => {
    expect(() => toPgVector([0.1, 0.2])).toThrow(/dims/i)
  })

  it('preserves negative values', () => {
    const v = new Array(EMBEDDING_DIMENSIONS).fill(0)
    v[0] = -0.5
    const out = toPgVector(v)
    expect(out.startsWith('[-0.5,')).toBe(true)
  })
})
