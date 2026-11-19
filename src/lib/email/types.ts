/**
 * Shared types for the e-mail channel (phase 1 of docs/handoff-email-channel.md).
 * DB shape lives in supabase/migrations/053_email_channel.sql.
 */

/** marketing = promotional (subject to unsubscribe, daily limit and frequency cap);
 *  transactional = order/account notices (only blocked by hard bounces/complaints). */
export type EmailCategory = "marketing" | "transactional";

export type EmailStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "suppressed"
  | "skipped";

export type SuppressionReason = "unsubscribed" | "bounced" | "complained" | "manual";

/** Visual identity consumed by layout.ts. Every field is optional. */
export interface EmailBrand {
  /** Public https URL of the logo (PNG/JPG; most mail clients block SVG). */
  logo_url?: string;
  /** Wordmark shown when there is no logo (defaults to the tenant name). */
  company_name?: string;
  /** Primary action / coupon accent colour. Default #087f58. */
  accent?: string;
  /** Text + header/footer band colour. Default #111111. */
  ink?: string;
  /** Text of the thin band above the logo (e.g. "KITS COM DESCONTO AUTOMÁTICO"). */
  strip_text?: string;
  /** Small print under the footer band (address, CNPJ, legal). */
  footer_note?: string;
}

export interface EmailConfig {
  id: string;
  user_id: string;
  provider: "resend";
  api_key_encrypted: string | null;
  webhook_secret_encrypted: string | null;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  daily_limit: number;
  marketing_min_gap_days: number;
  brand: EmailBrand;
  is_active: boolean;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

export interface SendEmailInput {
  userId: string;
  /** Recipient. Normalised (trim + lower-case) before use. */
  to: string;
  subject: string;
  category: EmailCategory;
  /**
   * Builds the final HTML/text. Receives the unsubscribe URL (marketing only)
   * and the tenant's brand from email_config.
   */
  render: (ctx: { unsubscribeUrl: string | null; brand: EmailBrand }) => RenderedEmail;
  contactId?: string | null;
  automationId?: string | null;
  /** Reporting tag, e.g. "reativacao_d97". */
  campaignKey?: string | null;
  /**
   * Skip the "one marketing e-mail every N days per address" rule. Only for a
   * sequence the customer themself triggered (cart recovery sends 3 e-mails in
   * 3 days). The daily cap and the suppression list still apply.
   */
  ignoreMinGap?: boolean;
}

export type SendEmailResult =
  | { status: "sent"; messageId: string; providerMessageId: string }
  | { status: "suppressed"; messageId: string | null; reason: SuppressionReason }
  | { status: "skipped"; messageId: string | null; reason: "daily_limit" | "marketing_gap" }
  | {
      status: "failed";
      messageId: string | null;
      error: string;
      /** A later attempt may succeed (429 / 5xx / network). */
      retryable: boolean;
      /**
       * The provider gave no definite answer (timeout, dropped connection): the
       * e-mail MAY have been sent. Do not retry automatically, a duplicate is worse.
       */
      ambiguous?: boolean;
    }
  | { status: "not_configured" };
