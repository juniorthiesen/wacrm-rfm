import { describe, expect, it } from 'vitest'
import {
  computeWindowUntil,
  isWindowOpen,
  windowMsRemaining,
  WINDOW_DURATION_MS,
} from './conversation-window'

describe('conversation-window', () => {
  const now = new Date('2026-06-09T12:00:00.000Z')
  const inFuture = new Date(now.getTime() + 60 * 60 * 1000).toISOString() // +1h
  const inPast = new Date(now.getTime() - 60 * 60 * 1000).toISOString() // -1h

  describe('isWindowOpen', () => {
    it('returns false when contact is null/undefined', () => {
      expect(isWindowOpen(null, now)).toBe(false)
      expect(isWindowOpen(undefined, now)).toBe(false)
    })

    it('returns false when conversation_window_until is NULL', () => {
      expect(isWindowOpen({ conversation_window_until: null }, now)).toBe(false)
    })

    it('returns true when window-until is in the future', () => {
      expect(
        isWindowOpen({ conversation_window_until: inFuture }, now),
      ).toBe(true)
    })

    it('returns false when window-until is in the past', () => {
      expect(
        isWindowOpen({ conversation_window_until: inPast }, now),
      ).toBe(false)
    })

    it('returns false at the exact close moment (strict less-than)', () => {
      // The Meta window is right-open: at the boundary, the safe call
      // is to treat it as closed so we don't try to send free-form
      // and hit a Meta error.
      const exactly = new Date(now.getTime()).toISOString()
      expect(
        isWindowOpen({ conversation_window_until: exactly }, now),
      ).toBe(false)
    })

    it('returns false for malformed timestamps', () => {
      expect(
        isWindowOpen({ conversation_window_until: 'not-a-date' }, now),
      ).toBe(false)
    })
  })

  describe('windowMsRemaining', () => {
    it('returns 0 when no window', () => {
      expect(windowMsRemaining(null, now)).toBe(0)
      expect(
        windowMsRemaining({ conversation_window_until: null }, now),
      ).toBe(0)
    })

    it('returns 0 when window expired', () => {
      expect(
        windowMsRemaining({ conversation_window_until: inPast }, now),
      ).toBe(0)
    })

    it('returns positive ms when open', () => {
      const remaining = windowMsRemaining(
        { conversation_window_until: inFuture },
        now,
      )
      expect(remaining).toBe(60 * 60 * 1000)
    })
  })

  describe('computeWindowUntil', () => {
    it('returns now + 24h as ISO string', () => {
      const out = computeWindowUntil(now)
      const parsed = Date.parse(out)
      expect(parsed - now.getTime()).toBe(WINDOW_DURATION_MS)
    })
  })
})
