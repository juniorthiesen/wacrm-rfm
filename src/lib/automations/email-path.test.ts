import { describe, expect, it } from 'vitest'
import { maxMarketingEmailsPerPath, type PathStepRow } from './email-path'

const email = (id: string, parent: string | null = null, branch: 'yes' | 'no' | null = null, category?: string): PathStepRow => ({
  id,
  parent_step_id: parent,
  branch,
  step_type: 'send_email',
  step_config: category ? { category } : {},
})
const cond = (id: string, parent: string | null = null, branch: 'yes' | 'no' | null = null): PathStepRow => ({
  id,
  parent_step_id: parent,
  branch,
  step_type: 'condition',
  step_config: {},
})
const wait = (id: string): PathStepRow => ({ id, parent_step_id: null, branch: null, step_type: 'wait', step_config: {} })

describe('maxMarketingEmailsPerPath', () => {
  it('counts e-mails that run one after another', () => {
    // carrinho abandonado: wait → e-mail 1 → wait → e-mail 2 → wait → e-mail 3
    const rows = [wait('w1'), email('e1'), wait('w2'), email('e2'), wait('w3'), email('e3')]
    expect(maxMarketingEmailsPerPath(rows)).toBe(3)
  })

  it('counts one e-mail for an A/B split with four variants', () => {
    // ab 4:0 → yes: A | no → ab 4:1 → yes: B | no → ab 4:2 → yes: C | no: D
    const rows = [
      cond('c0'),
      email('A', 'c0', 'yes'),
      cond('c1', 'c0', 'no'),
      email('B', 'c1', 'yes'),
      cond('c2', 'c1', 'no'),
      email('C', 'c2', 'yes'),
      email('D', 'c2', 'no'),
    ]
    expect(maxMarketingEmailsPerPath(rows)).toBe(1)
  })

  it('adds a later e-mail that every branch shares', () => {
    // split → (A | B) then, for everyone, a follow-up e-mail at the root
    const rows = [cond('c0'), email('A', 'c0', 'yes'), email('B', 'c0', 'no'), email('follow')]
    expect(maxMarketingEmailsPerPath(rows)).toBe(2)
  })

  it('takes the heavier branch', () => {
    const rows = [cond('c0'), email('A1', 'c0', 'yes'), email('A2', 'c0', 'yes'), email('B', 'c0', 'no')]
    expect(maxMarketingEmailsPerPath(rows)).toBe(2)
  })

  it('ignores transactional e-mail', () => {
    expect(maxMarketingEmailsPerPath([email('t', null, null, 'transactional'), email('m')])).toBe(1)
  })

  it('is 0 without e-mail steps and safe on an empty list', () => {
    expect(maxMarketingEmailsPerPath([wait('w')])).toBe(0)
    expect(maxMarketingEmailsPerPath([])).toBe(0)
  })
})
