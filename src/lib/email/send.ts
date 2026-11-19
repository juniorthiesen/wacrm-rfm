import { decrypt } from "@/lib/whatsapp/encryption";
import { evaluateLimits, startOfLocalDay } from "./limits";
import {
  EmailProviderError,
  formatFromAddress,
  type EmailProvider,
} from "./provider";
import { ResendProvider } from "./resend";
import type { EmailStore } from "./store";
import {
  buildUnsubscribeUrl,
  normalizeEmail,
  signUnsubscribeToken,
} from "./unsubscribe";
import type { SendEmailInput, SendEmailResult } from "./types";

/**
 * The one entry point every automation/campaign uses to send an e-mail.
 * Order of checks (cheapest/most protective first):
 *   1. channel configured and active
 *   2. address valid
 *   3. suppression list (marketing: any reason; transactional: only bounce/complaint)
 *   4. limits (marketing only): daily cap, one-marketing-mail-every-N-days per address
 *   5. marketing requires a public site URL so the unsubscribe link can be built
 * Every outcome except "not configured" leaves a row in email_messages.
 */

export interface SendDeps {
  store: EmailStore;
  /** Inject a provider in tests; otherwise built from the tenant's encrypted key. */
  provider?: EmailProvider;
  now?: () => Date;
  /** Public base URL for the unsubscribe link. Default: NEXT_PUBLIC_SITE_URL. */
  siteUrl?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendEmail(input: SendEmailInput, deps: SendDeps): Promise<SendEmailResult> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const to = normalizeEmail(input.to);

  const config = await store.getConfig(input.userId);
  if (!config || !config.is_active || !config.api_key_encrypted || !config.from_email) {
    return { status: "not_configured" };
  }

  const base = {
    user_id: input.userId,
    contact_id: input.contactId ?? null,
    automation_id: input.automationId ?? null,
    campaign_key: input.campaignKey ?? null,
    to_email: to,
    category: input.category,
    subject: input.subject,
  } as const;

  if (!EMAIL_RE.test(to)) {
    const { id } = await store.insertMessage({ ...base, status: "failed", error: "invalid_email" });
    return { status: "failed", messageId: id, error: "invalid_email", retryable: false };
  }

  // 3. suppression
  const suppression = await store.getSuppression(input.userId, to);
  const blocksTransactional = suppression === "bounced" || suppression === "complained";
  if (suppression && (input.category === "marketing" || blocksTransactional)) {
    const { id } = await store.insertMessage({ ...base, status: "suppressed", skip_reason: suppression });
    return { status: "suppressed", messageId: id, reason: suppression };
  }

  // 4. limits
  if (input.category === "marketing") {
    const [sentToday, lastMarketingSentAt] = await Promise.all([
      store.countMarketingSentSince(input.userId, startOfLocalDay(now)),
      store.lastMarketingSentAt(input.userId, to),
    ]);
    const decision = evaluateLimits({
      category: input.category,
      now,
      sentToday,
      dailyLimit: config.daily_limit,
      lastMarketingSentAt,
      // A step that belongs to a sequence the customer triggered (cart recovery)
      // opts out of the per-address gap; the daily cap and suppression still apply.
      minGapDays: input.ignoreMinGap ? 0 : config.marketing_min_gap_days,
    });
    if (!decision.allowed) {
      const { id } = await store.insertMessage({ ...base, status: "skipped", skip_reason: decision.reason });
      return { status: "skipped", messageId: id, reason: decision.reason };
    }
  }

  // 5. unsubscribe link (marketing must always carry one)
  let unsubscribeUrl: string | null = null;
  if (input.category === "marketing") {
    const siteUrl = deps.siteUrl ?? process.env.NEXT_PUBLIC_SITE_URL;
    if (!siteUrl) {
      const error = "NEXT_PUBLIC_SITE_URL is not set; refusing to send marketing e-mail without an unsubscribe link";
      const { id } = await store.insertMessage({ ...base, status: "failed", error });
      return { status: "failed", messageId: id, error, retryable: false };
    }
    unsubscribeUrl = buildUnsubscribeUrl(siteUrl, signUnsubscribeToken(input.userId, to));
  }

  const { id: messageId } = await store.insertMessage({ ...base, status: "queued" });

  try {
    const rendered = input.render({ unsubscribeUrl, brand: config.brand ?? {} });
    const provider = deps.provider ?? new ResendProvider(decrypt(config.api_key_encrypted));
    const { id: providerMessageId } = await provider.send({
      from: formatFromAddress(config.from_name, config.from_email),
      to,
      subject: input.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: config.reply_to ?? undefined,
      headers: unsubscribeUrl
        ? {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : undefined,
      tags: [
        { name: "email_message_id", value: messageId },
        { name: "category", value: input.category },
      ],
      // Our row id: a retry of the same row never produces a second delivery.
      idempotencyKey: messageId,
    });

    await store.updateMessage(messageId, {
      status: "sent",
      provider_message_id: providerMessageId,
      sent_at: now.toISOString(),
    });
    return { status: "sent", messageId, providerMessageId };
  } catch (err) {
    const retryable = err instanceof EmailProviderError ? err.retryable : false;
    // No HTTP status (network/timeout) or a 2xx without an id: the provider may
    // have accepted the e-mail. An explicit 4xx/5xx/429 means it was NOT sent.
    const ambiguous = err instanceof EmailProviderError && (err.status === undefined || err.status < 400);
    const error = err instanceof Error ? err.message : "unknown error";
    await store.updateMessage(messageId, { status: "failed", error });
    return { status: "failed", messageId, error, retryable, ambiguous };
  }
}
