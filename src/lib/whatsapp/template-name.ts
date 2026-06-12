/**
 * Helpers for recovering from Meta template-name conflicts.
 *
 * Deleting a template on Meta is asynchronous: while the deletion
 * propagates, the name+language pair is unavailable and submissions
 * fail with "You cannot add new content … while existing content …
 * is being deleted". If the deleted template had been APPROVED, the
 * name stays locked for 30 days. The submit endpoint detects that
 * error with `isNameConflictError` and offers the UI a way out via
 * `suggestNextName` ("rename to _v2 and resubmit").
 */

/** Meta template-name rules: lowercase letters, digits, underscores. */
export const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/

export const MAX_TEMPLATE_NAME_LENGTH = 512

const VERSION_SUFFIX = /_v(\d+)$/

export interface MetaErrorShape {
  message?: string
  error_user_title?: string
  error_user_msg?: string
}

/**
 * True when Meta refused a template submission because a same-name
 * template is mid-deletion (or the name is still locked from a past
 * deletion). Meta localises `error_user_msg` per the WABA's locale,
 * so match both the English `message` and the Portuguese variant we
 * see in production ("… está sendo excluído …").
 */
export function isNameConflictError(
  err: MetaErrorShape | undefined | null,
): boolean {
  if (!err) return false
  const text = [err.message, err.error_user_title, err.error_user_msg]
    .filter(Boolean)
    .join(' ')
  return /being deleted|sendo exclu/i.test(text)
}

/**
 * Suggest the next free versioned name: `base_v2`, `base_v3`, …
 *
 * A name that already carries a `_vN` suffix keeps its base, so
 * `woo_order_paid_v2` suggests `woo_order_paid_v3` rather than
 * `woo_order_paid_v2_v2`. `taken` is the user's existing template
 * names (any status, any language) — the caller dedupes against
 * Meta by simply resubmitting; if Meta still refuses, this runs
 * again on the new name and walks to the next suffix.
 */
export function suggestNextName(
  name: string,
  taken: Iterable<string>,
): string {
  const takenSet = new Set(taken)
  const match = name.match(VERSION_SUFFIX)
  const base = match ? name.slice(0, -match[0].length) : name
  let n = match ? Number(match[1]) + 1 : 2
  for (;;) {
    const suffix = `_v${n}`
    const candidate =
      base.slice(0, MAX_TEMPLATE_NAME_LENGTH - suffix.length) + suffix
    if (!takenSet.has(candidate)) return candidate
    n += 1
  }
}
