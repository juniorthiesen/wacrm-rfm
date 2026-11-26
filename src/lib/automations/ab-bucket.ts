import { createHash } from 'node:crypto'

/**
 * A/B split for automation conditions (`ab_bucket`).
 *
 * The operand is "N:K": the contact belongs to group K (0-based) out of N equal
 * groups. The group is a stable hash of automation + contact, so the same person
 * always lands in the same group and the split is even without any stored state.
 * Chain conditions to make more than two variants:
 *   ab_bucket 3:0 → yes: A | no → ab_bucket 3:1 → yes: B | no: C
 */

export interface AbOperand {
  buckets: number
  bucket: number
}

const MAX_BUCKETS = 10

/** "3:1" → { buckets: 3, bucket: 1 }; null when malformed or out of range. */
export function parseAbOperand(operand: string | undefined | null): AbOperand | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec((operand ?? '').trim())
  if (!m) return null
  const buckets = Number(m[1])
  const bucket = Number(m[2])
  if (buckets < 2 || buckets > MAX_BUCKETS || bucket >= buckets) return null
  return { buckets, bucket }
}

/** Which of `buckets` groups this contact falls into (0..buckets-1). */
export function abBucketOf(
  automationId: string,
  contactId: string,
  buckets: number
): number {
  // Salted so it is independent of the control-group hash used by the recency cron.
  const digest = createHash('sha256')
    .update(`ab:${automationId}:${contactId}`)
    .digest()
  return digest.readUInt32BE(0) % buckets
}

/** True when the contact is in the group the operand names. False on a bad operand. */
export function inAbBucket(
  automationId: string,
  contactId: string,
  operand: string | undefined | null
): boolean {
  const parsed = parseAbOperand(operand)
  if (!parsed) return false
  return abBucketOf(automationId, contactId, parsed.buckets) === parsed.bucket
}
