import type { EmailCategory } from "./types";

/**
 * Send limits for the e-mail channel. Pure functions: the DB reads that feed
 * them live in store.ts, so the rules are unit-testable.
 *
 *  - transactional mail is never limited here (order notices must go out);
 *  - marketing is capped per local day (warm-up protection for the sending
 *    domain) and per address (one marketing e-mail every N days, summed over
 *    ALL automations/campaigns, so two flows can't hit the same person on the
 *    same day).
 */

export const STORE_TIME_ZONE = "America/Sao_Paulo";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LimitInput {
  category: EmailCategory;
  now: Date;
  /** Marketing e-mails already sent today (local day). */
  sentToday: number;
  dailyLimit: number;
  lastMarketingSentAt: Date | null;
  /** 0 disables the per-address cap. */
  minGapDays: number;
}

export type LimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "daily_limit" | "marketing_gap" };

export function evaluateLimits(input: LimitInput): LimitDecision {
  if (input.category === "transactional") return { allowed: true };

  if (input.sentToday >= input.dailyLimit) {
    return { allowed: false, reason: "daily_limit" };
  }
  if (
    input.minGapDays > 0 &&
    input.lastMarketingSentAt &&
    input.now.getTime() - input.lastMarketingSentAt.getTime() < input.minGapDays * DAY_MS
  ) {
    return { allowed: false, reason: "marketing_gap" };
  }
  return { allowed: true };
}

/** Offset (ms) of `timeZone` from UTC at the given instant: local = utc + offset. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instant of 00:00 (local) of the day that contains `now` in `timeZone`. */
export function startOfLocalDay(now: Date, timeZone: string = STORE_TIME_ZONE): Date {
  const offset = zoneOffsetMs(now, timeZone);
  const local = new Date(now.getTime() + offset);
  const localMidnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // Offset can differ at midnight (DST day); resolve using the offset at that instant.
  const guess = new Date(localMidnightAsUtc - offset);
  const offsetAtGuess = zoneOffsetMs(guess, timeZone);
  return new Date(localMidnightAsUtc - offsetAtGuess);
}
