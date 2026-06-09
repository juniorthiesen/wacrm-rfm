/**
 * Meta 24-hour customer service window helpers.
 *
 * The window opens whenever the contact sends ANY inbound message to
 * us — text, media, swipe-reply, OR a tap on an interactive / template
 * Quick Reply button. While the window is open, we can send free-form
 * text messages for free instead of paid templates.
 *
 * The webhook (src/app/api/whatsapp/webhook/route.ts) is the single
 * writer of `contacts.conversation_window_until`. This module is
 * read-only — it answers "is the window open right now?" for the
 * broadcast smart sender, automations engine, and inbox UI.
 *
 * See docs/whatsapp-cost-strategy.md for the strategy this enables.
 */

const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000

interface MinimalContactRow {
  conversation_window_until: string | null
}

/**
 * True when `now` is strictly before the recorded window-close time.
 *
 * Returns false when the column is NULL, when it's malformed, or when
 * `now >= windowUntil`. Defensive against bad data — never throws.
 */
export function isWindowOpen(
  contact: MinimalContactRow | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!contact?.conversation_window_until) return false
  const until = Date.parse(contact.conversation_window_until)
  if (Number.isNaN(until)) return false
  return now.getTime() < until
}

/**
 * Milliseconds left in the window, clamped to 0 when closed.
 * Useful for "expires in 2h" UI labels.
 */
export function windowMsRemaining(
  contact: MinimalContactRow | null | undefined,
  now: Date = new Date(),
): number {
  if (!contact?.conversation_window_until) return 0
  const until = Date.parse(contact.conversation_window_until)
  if (Number.isNaN(until)) return 0
  return Math.max(0, until - now.getTime())
}

/**
 * The ISO string the webhook writes to refresh / open the window.
 * Exported so tests and the webhook stay in lockstep on the duration.
 */
export function computeWindowUntil(now: Date = new Date()): string {
  return new Date(now.getTime() + WINDOW_DURATION_MS).toISOString()
}

export { WINDOW_DURATION_MS }
