import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailMessagePatch, EmailMessageRef, EmailStore } from "./store";
import type { EmailStatus, SuppressionReason } from "./types";

/**
 * Resend delivery events (Svix-signed webhooks) → email_messages updates.
 * Docs: events are `email.delivered`, `email.bounced`, `email.complained`,
 * `email.opened`, `email.clicked`, `email.failed`, ...
 */

const TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Svix signature check: HMAC-SHA256 over `${id}.${timestamp}.${body}` with the
 * base64-decoded part of the `whsec_...` secret; the header may carry several
 * space-separated `v1,<base64>` signatures (key rotation).
 */
export function verifySvixSignature(
  headers: SvixHeaders,
  body: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

  for (const candidate of signature.split(" ")) {
    const [version, value] = candidate.split(",");
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    tags?: Record<string, string> | { name: string; value: string }[];
    bounce?: { type?: string; message?: string };
    reason?: string;
  };
}

export interface EventEffect {
  /** Which message the event is about (provider id and/or our tag). */
  providerMessageId?: string;
  messageId?: string;
  patch: EmailMessagePatch;
  /** Increment counters instead of overwriting. */
  addOpens?: number;
  addClicks?: number;
  suppress?: { reason: SuppressionReason };
  /** Status this event moves the message to (subject to precedence rules). */
  nextStatus?: EmailStatus;
}

function tagValue(tags: NonNullable<ResendEvent["data"]>["tags"], name: string): string | undefined {
  if (!tags) return undefined;
  if (Array.isArray(tags)) return tags.find((t) => t.name === name)?.value;
  return tags[name];
}

/** Maps one Resend event to the changes it implies; null = ignore. */
export function mapResendEvent(event: ResendEvent): EventEffect | null {
  const data = event.data;
  if (!event.type || !data) return null;
  const at = event.created_at ?? new Date().toISOString();
  const base = {
    providerMessageId: data.email_id,
    messageId: tagValue(data.tags, "email_message_id"),
  };

  switch (event.type) {
    case "email.delivered":
      return { ...base, nextStatus: "delivered", patch: { delivered_at: at } };
    case "email.bounced": {
      // Only a permanent bounce kills the address; transient ones may recover.
      const permanent = (data.bounce?.type ?? "").toLowerCase() === "permanent";
      return {
        ...base,
        nextStatus: "bounced",
        patch: { error: data.bounce?.message ?? "bounced" },
        suppress: permanent ? { reason: "bounced" } : undefined,
      };
    }
    case "email.complained":
      return { ...base, nextStatus: "complained", patch: {}, suppress: { reason: "complained" } };
    case "email.failed":
      return { ...base, nextStatus: "failed", patch: { error: data.reason ?? "failed" } };
    case "email.opened":
      return { ...base, addOpens: 1, patch: { opened_at: at } };
    case "email.clicked":
      return { ...base, addClicks: 1, patch: { clicked_at: at } };
    default:
      return null;
  }
}

/** Higher = more final. A later "delivered" must never undo a bounce/complaint. */
const STATUS_RANK: Record<EmailStatus, number> = {
  queued: 0,
  skipped: 0,
  suppressed: 0,
  failed: 1,
  sent: 2,
  delivered: 3,
  bounced: 4,
  complained: 5,
};

export function shouldAdvanceStatus(current: EmailStatus, next: EmailStatus): boolean {
  return STATUS_RANK[next] > STATUS_RANK[current];
}

/** Applies a mapped event to the store. Returns the message it touched, or null if unknown. */
export async function applyEmailEvent(
  store: EmailStore,
  effect: EventEffect,
): Promise<EmailMessageRef | null> {
  const message = await store.findMessage({
    providerMessageId: effect.providerMessageId,
    messageId: effect.messageId,
  });
  if (!message) return null;

  const patch: EmailMessagePatch = { ...effect.patch };
  if (effect.nextStatus && shouldAdvanceStatus(message.status, effect.nextStatus)) {
    patch.status = effect.nextStatus;
  } else {
    // Keep the timestamps/error of an out-of-order event only when they don't contradict the status.
    if (effect.nextStatus) delete patch.error;
  }
  if (effect.addOpens) patch.open_count = message.open_count + effect.addOpens;
  if (effect.addClicks) patch.click_count = message.click_count + effect.addClicks;

  if (Object.keys(patch).length > 0) await store.updateMessage(message.id, patch);
  if (effect.suppress) {
    await store.addSuppression(message.user_id, message.to_email, effect.suppress.reason, "provider_webhook");
  }
  return message;
}
