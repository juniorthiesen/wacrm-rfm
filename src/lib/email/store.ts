import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EmailCategory,
  EmailConfig,
  EmailStatus,
  SuppressionReason,
} from "./types";

/**
 * Persistence seam for the e-mail channel. send.ts and the webhook handler talk
 * to this interface, so (a) unit tests use an in-memory store and (b) the
 * channel can later run on another database (the Next.js store / a packaged
 * multi-tenant version) by swapping the implementation.
 */

export interface NewEmailMessage {
  user_id: string;
  contact_id: string | null;
  automation_id: string | null;
  campaign_key: string | null;
  /** Lower-cased. */
  to_email: string;
  category: EmailCategory;
  subject: string;
  status: EmailStatus;
  skip_reason?: string | null;
  error?: string | null;
}

export interface EmailMessagePatch {
  status?: EmailStatus;
  skip_reason?: string | null;
  provider_message_id?: string | null;
  error?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  opened_at?: string | null;
  clicked_at?: string | null;
  open_count?: number;
  click_count?: number;
}

export interface EmailMessageRef {
  id: string;
  user_id: string;
  status: EmailStatus;
  to_email: string;
  open_count: number;
  click_count: number;
}

export interface EmailStore {
  getConfig(userId: string): Promise<EmailConfig | null>;
  /** The suppression reason if the address is suppressed, else null. */
  getSuppression(userId: string, email: string): Promise<SuppressionReason | null>;
  /** Marketing e-mails actually sent at/after `since`. */
  countMarketingSentSince(userId: string, since: Date): Promise<number>;
  lastMarketingSentAt(userId: string, email: string): Promise<Date | null>;
  insertMessage(row: NewEmailMessage): Promise<{ id: string }>;
  updateMessage(id: string, patch: EmailMessagePatch): Promise<void>;
  /** First reason wins (ON CONFLICT DO NOTHING): a complaint is never downgraded. */
  addSuppression(
    userId: string,
    email: string,
    reason: SuppressionReason,
    source: string,
  ): Promise<void>;
  findMessage(ref: { providerMessageId?: string; messageId?: string }): Promise<EmailMessageRef | null>;
}

const SENT_STATUSES: EmailStatus[] = ["sent", "delivered", "bounced", "complained"];

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`[email-store] ${context}: ${error?.message ?? "unknown error"}`);
}

export function supabaseEmailStore(db: SupabaseClient): EmailStore {
  return {
    async getConfig(userId) {
      const { data, error } = await db
        .from("email_config")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) fail("getConfig", error);
      return (data as EmailConfig | null) ?? null;
    },

    async getSuppression(userId, email) {
      const { data, error } = await db
        .from("email_suppressions")
        .select("reason")
        .eq("user_id", userId)
        .eq("email", email)
        .maybeSingle();
      if (error) fail("getSuppression", error);
      return (data?.reason as SuppressionReason | undefined) ?? null;
    },

    async countMarketingSentSince(userId, since) {
      const { count, error } = await db
        .from("email_messages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("category", "marketing")
        .in("status", SENT_STATUSES)
        .gte("sent_at", since.toISOString());
      if (error) fail("countMarketingSentSince", error);
      return count ?? 0;
    },

    async lastMarketingSentAt(userId, email) {
      const { data, error } = await db
        .from("email_messages")
        .select("sent_at")
        .eq("user_id", userId)
        .eq("to_email", email)
        .eq("category", "marketing")
        .in("status", SENT_STATUSES)
        .not("sent_at", "is", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("lastMarketingSentAt", error);
      return data?.sent_at ? new Date(data.sent_at as string) : null;
    },

    async insertMessage(row) {
      const { data, error } = await db.from("email_messages").insert(row).select("id").single();
      if (error || !data) fail("insertMessage", error);
      return { id: (data as { id: string }).id };
    },

    async updateMessage(id, patch) {
      const { error } = await db.from("email_messages").update(patch).eq("id", id);
      if (error) fail("updateMessage", error);
    },

    async addSuppression(userId, email, reason, source) {
      const { error } = await db
        .from("email_suppressions")
        .upsert(
          { user_id: userId, email, reason, source },
          { onConflict: "user_id,email", ignoreDuplicates: true },
        );
      if (error) fail("addSuppression", error);
    },

    async findMessage({ providerMessageId, messageId }) {
      const columns = "id, user_id, status, to_email, open_count, click_count";
      if (providerMessageId) {
        const { data, error } = await db
          .from("email_messages")
          .select(columns)
          .eq("provider_message_id", providerMessageId)
          .maybeSingle();
        if (error) fail("findMessage(provider)", error);
        if (data) return data as EmailMessageRef;
      }
      if (messageId) {
        const { data, error } = await db
          .from("email_messages")
          .select(columns)
          .eq("id", messageId)
          .maybeSingle();
        if (error) fail("findMessage(id)", error);
        if (data) return data as EmailMessageRef;
      }
      return null;
    },
  };
}
