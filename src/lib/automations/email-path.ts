/**
 * How many marketing e-mails ONE person can receive from a sequence.
 *
 * Steps at the same level run one after another, so their e-mails add up. A
 * condition sends the person down exactly one branch, so only the heavier branch
 * counts. Counting every `send_email` row would overstate the load: an A/B split
 * with four e-mail variants delivers one e-mail per person, not four, and the
 * daily cap would be cut to a quarter for no reason (regua.ts divides the daily
 * e-mail limit by this number).
 */

export interface PathStepRow {
  id?: string
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  step_type: string
  step_config: Record<string, unknown> | null
}

const isMarketingEmail = (s: PathStepRow) =>
  s.step_type === 'send_email' &&
  (s.step_config?.category ?? 'marketing') !== 'transactional'

export function maxMarketingEmailsPerPath(rows: PathStepRow[]): number {
  const children = new Map<string, PathStepRow[]>()
  const roots: PathStepRow[] = []
  for (const row of rows) {
    if (!row.parent_step_id) {
      roots.push(row)
      continue
    }
    const key = `${row.parent_step_id}|${row.branch ?? 'yes'}`
    const list = children.get(key)
    if (list) list.push(row)
    else children.set(key, [row])
  }

  const seen = new Set<string>()
  const count = (list: PathStepRow[]): number => {
    let total = 0
    for (const step of list) {
      if (isMarketingEmail(step)) total += 1
      if (step.step_type === 'condition' && step.id && !seen.has(step.id)) {
        seen.add(step.id)
        total += Math.max(
          count(children.get(`${step.id}|yes`) ?? []),
          count(children.get(`${step.id}|no`) ?? [])
        )
      }
    }
    return total
  }
  return count(roots)
}
