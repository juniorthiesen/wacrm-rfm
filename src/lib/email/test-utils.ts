import { EmailProviderError, type EmailProvider, type OutboundEmail } from "./provider";
import type {
  EmailMessagePatch,
  EmailMessageRef,
  EmailStore,
  NewEmailMessage,
} from "./store";
import type { EmailConfig, EmailStatus, SuppressionReason } from "./types";

/** Test helpers only (not imported by production code). */

export const USER_ID = "user-1";

export function makeConfig(overrides: Partial<EmailConfig> = {}): EmailConfig {
  return {
    id: "cfg-1",
    user_id: USER_ID,
    provider: "resend",
    api_key_encrypted: "encrypted-key",
    webhook_secret_encrypted: null,
    from_name: "DLY Lingerie",
    from_email: "ecom@dly.com.br",
    reply_to: null,
    daily_limit: 150,
    marketing_min_gap_days: 3,
    brand: {},
    is_active: true,
    ...overrides,
  };
}

export interface StoredMessage extends NewEmailMessage {
  id: string;
  provider_message_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  open_count: number;
  click_count: number;
}

const SENT: EmailStatus[] = ["sent", "delivered", "bounced", "complained"];

export interface MemoryStore extends EmailStore {
  messages: StoredMessage[];
  suppressions: Map<string, SuppressionReason>;
}

export function createMemoryStore(
  options: {
    config?: EmailConfig | null;
    suppressions?: Record<string, SuppressionReason>;
    messages?: Partial<StoredMessage>[];
  } = {},
): MemoryStore {
  const config = options.config === undefined ? makeConfig() : options.config;
  const suppressions = new Map<string, SuppressionReason>(Object.entries(options.suppressions ?? {}));
  const messages: StoredMessage[] = [];
  let seq = 0;

  function add(row: Partial<StoredMessage> & NewEmailMessage): StoredMessage {
    const stored: StoredMessage = {
      provider_message_id: null,
      sent_at: null,
      delivered_at: null,
      opened_at: null,
      clicked_at: null,
      open_count: 0,
      click_count: 0,
      id: `msg-${++seq}`,
      ...row,
    };
    messages.push(stored);
    return stored;
  }
  for (const seed of options.messages ?? []) {
    add({
      user_id: USER_ID,
      contact_id: null,
      automation_id: null,
      campaign_key: null,
      to_email: "x@y.co",
      category: "marketing",
      subject: "seed",
      status: "sent",
      ...seed,
    });
  }

  return {
    messages,
    suppressions,
    async getConfig() {
      return config;
    },
    async getSuppression(_userId, email) {
      return suppressions.get(email) ?? null;
    },
    async countMarketingSentSince(userId, since) {
      return messages.filter(
        (m) =>
          m.user_id === userId &&
          m.category === "marketing" &&
          SENT.includes(m.status) &&
          m.sent_at !== null &&
          new Date(m.sent_at) >= since,
      ).length;
    },
    async lastMarketingSentAt(userId, email) {
      const times = messages
        .filter(
          (m) =>
            m.user_id === userId &&
            m.to_email === email &&
            m.category === "marketing" &&
            SENT.includes(m.status) &&
            m.sent_at !== null,
        )
        .map((m) => new Date(m.sent_at as string).getTime());
      return times.length ? new Date(Math.max(...times)) : null;
    },
    async insertMessage(row) {
      return { id: add(row).id };
    },
    async updateMessage(id: string, patch: EmailMessagePatch) {
      const message = messages.find((m) => m.id === id);
      if (!message) throw new Error(`no message ${id}`);
      Object.assign(message, patch);
    },
    async addSuppression(_userId, email, reason) {
      if (!suppressions.has(email)) suppressions.set(email, reason);
    },
    async findMessage({ providerMessageId, messageId }): Promise<EmailMessageRef | null> {
      const found =
        (providerMessageId && messages.find((m) => m.provider_message_id === providerMessageId)) ||
        (messageId && messages.find((m) => m.id === messageId)) ||
        null;
      if (!found) return null;
      return {
        id: found.id,
        user_id: found.user_id,
        status: found.status,
        to_email: found.to_email,
        open_count: found.open_count,
        click_count: found.click_count,
      };
    },
  };
}

export class FakeProvider implements EmailProvider {
  readonly name = "fake";
  sent: OutboundEmail[] = [];
  private nextError: EmailProviderError | null = null;

  failNextWith(error: EmailProviderError) {
    this.nextError = error;
  }

  async send(email: OutboundEmail): Promise<{ id: string }> {
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    this.sent.push(email);
    return { id: `prov-${this.sent.length}` };
  }
}
