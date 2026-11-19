import { startOfLocalDay } from "@/lib/email/limits";

/**
 * Retry rules for automation steps that fail for a TRANSIENT reason.
 *
 * Without this, a step that fails (store down, provider rate limit, daily e-mail
 * limit reached, channel switched off for a moment) is recorded as failed and the
 * run stops: for a multi-step sequence the person is silently stranded.
 *
 * A step throws `RetryStep` to say "this is not final, try this same step again
 * later". The engine then parks the run exactly like a Wait step does
 * (`automation_pending_executions`, resumed by /api/automations/cron) but pointing
 * at the SAME step, with the context saved, so work done earlier in the run (e.g.
 * the coupon already created) is not repeated.
 *
 *  - kind "error": a real failure that may clear up. Backoff 1 h, 4 h, 12 h, 24 h,
 *    then give up (4 retries).
 *  - kind "limit": a rate/daily limit, not a failure. Try again just after the next
 *    local midnight, up to 6 times.
 *
 * Granularity is the cron that resumes parked runs: with a once-a-day trigger a
 * 1-hour backoff effectively becomes "next run".
 */

export type RetryKind = "error" | "limit";

export class RetryStep extends Error {
  readonly kind: RetryKind;

  constructor(message: string, kind: RetryKind) {
    super(message);
    this.name = "RetryStep";
    this.kind = kind;
  }
}

export const MAX_RETRIES: Record<RetryKind, number> = { error: 4, limit: 6 };

const HOUR_MS = 60 * 60 * 1000;
const ERROR_BACKOFF_HOURS = [1, 4, 12, 24];
/** Daily limits reset at local midnight; wait a few minutes past it. */
const LIMIT_RETRY_OFFSET_MS = 10 * 60 * 1000;

export type RetryDecision =
  | { retry: true; at: Date; attempt: number; max: number }
  | { retry: false; max: number };

/** `attempt` is the 1-based number of the retry about to be scheduled. */
export function planRetry(kind: RetryKind, attempt: number, now: Date): RetryDecision {
  const max = MAX_RETRIES[kind];
  const n = Math.max(1, Math.floor(attempt));
  if (n > max) return { retry: false, max };

  if (kind === "limit") {
    const at = new Date(startOfLocalDay(now).getTime() + 24 * HOUR_MS + LIMIT_RETRY_OFFSET_MS);
    return { retry: true, at, attempt: n, max };
  }

  const hours = ERROR_BACKOFF_HOURS[Math.min(n, ERROR_BACKOFF_HOURS.length) - 1];
  return { retry: true, at: new Date(now.getTime() + hours * HOUR_MS), attempt: n, max };
}
