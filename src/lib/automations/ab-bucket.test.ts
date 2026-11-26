import { describe, expect, it } from 'vitest'
import { abBucketOf, inAbBucket, parseAbOperand } from './ab-bucket'

describe('parseAbOperand', () => {
  it('reads N:K', () => {
    expect(parseAbOperand('3:1')).toEqual({ buckets: 3, bucket: 1 })
    expect(parseAbOperand(' 10:9 ')).toEqual({ buckets: 10, bucket: 9 })
  })

  it('rejects malformed or out-of-range operands', () => {
    for (const bad of ['', undefined, null, '3', '3:', ':1', '1:0', '11:0', '3:3', '3:-1', 'a:b', '3:1:2']) {
      expect(parseAbOperand(bad as string | undefined)).toBeNull()
    }
  })
})

describe('abBucketOf', () => {
  it('is stable for the same automation + contact', () => {
    expect(abBucketOf('auto-1', 'contact-1', 4)).toBe(abBucketOf('auto-1', 'contact-1', 4))
  })

  it('splits people evenly across groups', () => {
    const counts = [0, 0, 0, 0]
    const total = 8000
    for (let i = 0; i < total; i++) counts[abBucketOf('auto-1', `contact-${i}`, 4)]++
    for (const c of counts) {
      // Each group should hold ~25%; allow ±3 points of sampling noise.
      expect(c / total).toBeGreaterThan(0.22)
      expect(c / total).toBeLessThan(0.28)
    }
  })

  it('uses the automation id, so two automations split the same people differently', () => {
    let differ = 0
    for (let i = 0; i < 200; i++) {
      if (abBucketOf('auto-1', `c-${i}`, 3) !== abBucketOf('auto-2', `c-${i}`, 3)) differ++
    }
    expect(differ).toBeGreaterThan(50)
  })
})

describe('inAbBucket', () => {
  it('puts each person in exactly one of the N groups', () => {
    for (let i = 0; i < 300; i++) {
      const hits = [0, 1, 2].filter((k) => inAbBucket('auto-1', `c-${i}`, `3:${k}`))
      expect(hits).toHaveLength(1)
    }
  })

  it('is false for a malformed operand', () => {
    expect(inAbBucket('auto-1', 'c-1', 'x')).toBe(false)
  })
})
