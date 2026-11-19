import { beforeEach, describe, expect, it } from "vitest";
import { EmailProviderError } from "./provider";
import { sendEmail } from "./send";
import { createMemoryStore, FakeProvider, makeConfig, USER_ID } from "./test-utils";
import type { SendEmailInput } from "./types";

const NOW = new Date("2026-11-19T15:00:00Z"); // 12:00 in São Paulo
const SITE = "https://crm.example.com";
const DAY = 24 * 60 * 60 * 1000;

function input(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    userId: USER_ID,
    to: "Maria@Gmail.com",
    subject: "Sentimos sua falta",
    category: "marketing",
    campaignKey: "reativacao_d97",
    render: ({ unsubscribeUrl }) => ({
      html: `<p>oi</p>${unsubscribeUrl ?? ""}`,
      text: `oi ${unsubscribeUrl ?? ""}`,
    }),
    ...overrides,
  };
}

describe("sendEmail", () => {
  let provider: FakeProvider;
  beforeEach(() => {
    provider = new FakeProvider();
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  const deps = (store: ReturnType<typeof createMemoryStore>) => ({
    store,
    provider,
    now: () => NOW,
    siteUrl: SITE,
  });

  it("does nothing (and logs nothing) when the channel is not configured or inactive", async () => {
    for (const config of [null, makeConfig({ is_active: false }), makeConfig({ api_key_encrypted: null }), makeConfig({ from_email: "" })]) {
      const store = createMemoryStore({ config });
      expect(await sendEmail(input(), deps(store))).toEqual({ status: "not_configured" });
      expect(store.messages).toHaveLength(0);
    }
    expect(provider.sent).toHaveLength(0);
  });

  it("logs an invalid address as failed without calling the provider", async () => {
    const store = createMemoryStore();
    const result = await sendEmail(input({ to: "not-an-email" }), deps(store));
    expect(result).toMatchObject({ status: "failed", error: "invalid_email", retryable: false });
    expect(store.messages[0]).toMatchObject({ status: "failed", error: "invalid_email" });
    expect(provider.sent).toHaveLength(0);
  });

  it("sends marketing mail with unsubscribe headers, idempotency key and tags", async () => {
    const store = createMemoryStore();
    const result = await sendEmail(input(), deps(store));

    expect(result.status).toBe("sent");
    expect(provider.sent).toHaveLength(1);
    const sent = provider.sent[0];
    expect(sent.to).toBe("maria@gmail.com");
    expect(sent.from).toBe("DLY Lingerie <ecom@dly.com.br>");
    expect(sent.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/crm\.example\.com\/api\/public\/unsubscribe\?t=/);
    expect(sent.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent.html).toContain("/api/public/unsubscribe?t=");
    expect(sent.idempotencyKey).toBe(store.messages[0].id);
    expect(sent.tags).toContainEqual({ name: "email_message_id", value: store.messages[0].id });
    expect(store.messages[0]).toMatchObject({
      status: "sent",
      provider_message_id: "prov-1",
      to_email: "maria@gmail.com",
      campaign_key: "reativacao_d97",
      sent_at: NOW.toISOString(),
    });
  });

  it("sends transactional mail without unsubscribe headers", async () => {
    const store = createMemoryStore();
    await sendEmail(input({ category: "transactional" }), deps(store));
    expect(provider.sent[0].headers).toBeUndefined();
    expect(provider.sent[0].html).toBe("<p>oi</p>");
  });

  it("refuses marketing mail when the unsubscribe link cannot be built", async () => {
    const store = createMemoryStore();
    const result = await sendEmail(input(), { store, provider, now: () => NOW });
    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect((result as { error: string }).error).toContain("NEXT_PUBLIC_SITE_URL");
    expect(provider.sent).toHaveLength(0);
  });

  describe("suppression", () => {
    it("blocks marketing for any suppression reason", async () => {
      for (const reason of ["unsubscribed", "bounced", "complained", "manual"] as const) {
        const store = createMemoryStore({ suppressions: { "maria@gmail.com": reason } });
        const result = await sendEmail(input(), deps(store));
        expect(result).toMatchObject({ status: "suppressed", reason });
        expect(store.messages[0]).toMatchObject({ status: "suppressed", skip_reason: reason });
      }
      expect(provider.sent).toHaveLength(0);
    });

    it("lets transactional mail through an unsubscribe, but not a hard bounce or complaint", async () => {
      const unsub = createMemoryStore({ suppressions: { "maria@gmail.com": "unsubscribed" } });
      expect((await sendEmail(input({ category: "transactional" }), deps(unsub))).status).toBe("sent");

      for (const reason of ["bounced", "complained"] as const) {
        const store = createMemoryStore({ suppressions: { "maria@gmail.com": reason } });
        expect((await sendEmail(input({ category: "transactional" }), deps(store))).status).toBe("suppressed");
      }
    });
  });

  describe("limits", () => {
    it("skips marketing when today's cap is reached, counting only sends since local midnight", async () => {
      const store = createMemoryStore({
        config: makeConfig({ daily_limit: 2 }),
        messages: [
          { to_email: "a@a.co", sent_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString() },
          { to_email: "b@b.co", sent_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() },
          // yesterday (before 03:00Z today): must not count
          { to_email: "c@c.co", sent_at: "2026-11-19T02:00:00Z" },
        ],
      });
      const result = await sendEmail(input(), deps(store));
      expect(result).toMatchObject({ status: "skipped", reason: "daily_limit" });
      expect(provider.sent).toHaveLength(0);
    });

    it("skips a second marketing e-mail to the same address inside the gap, from any automation", async () => {
      const store = createMemoryStore({
        messages: [
          { to_email: "maria@gmail.com", automation_id: "other-flow", sent_at: new Date(NOW.getTime() - DAY).toISOString() },
        ],
      });
      const result = await sendEmail(input(), deps(store));
      expect(result).toMatchObject({ status: "skipped", reason: "marketing_gap" });
      expect(store.messages.at(-1)).toMatchObject({ status: "skipped", skip_reason: "marketing_gap" });
    });

    it("sends again once the gap has passed", async () => {
      const store = createMemoryStore({
        messages: [{ to_email: "maria@gmail.com", sent_at: new Date(NOW.getTime() - 4 * DAY).toISOString() }],
      });
      expect((await sendEmail(input(), deps(store))).status).toBe("sent");
    });

    it("lets a customer-triggered sequence ignore the per-address gap, but not the daily cap", async () => {
      const recent = { to_email: "maria@gmail.com", sent_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() };

      const gapStore = createMemoryStore({ messages: [recent] });
      expect(await sendEmail(input({ ignoreMinGap: true }), deps(gapStore))).toMatchObject({ status: "sent" });

      const capStore = createMemoryStore({ config: makeConfig({ daily_limit: 1 }), messages: [recent] });
      expect(await sendEmail(input({ ignoreMinGap: true }), deps(capStore))).toMatchObject({
        status: "skipped",
        reason: "daily_limit",
      });
    });

    it("does not apply marketing limits to transactional mail", async () => {
      const store = createMemoryStore({
        config: makeConfig({ daily_limit: 0 }),
        messages: [{ to_email: "maria@gmail.com", sent_at: new Date(NOW.getTime() - 1000).toISOString() }],
      });
      expect((await sendEmail(input({ category: "transactional" }), deps(store))).status).toBe("sent");
    });
  });

  it("flags a timeout as ambiguous (the e-mail may have been sent) but not an explicit rejection", async () => {
    const store = createMemoryStore();
    provider.failNextWith(new EmailProviderError("Resend request failed: timeout", true));
    const timeout = await sendEmail(input(), deps(store));
    expect(timeout).toMatchObject({ status: "failed", retryable: true, ambiguous: true });

    provider.failNextWith(new EmailProviderError("Too many requests", true, 429));
    const rateLimited = await sendEmail(input({ to: "other@gmail.com" }), deps(createMemoryStore()));
    expect(rateLimited).toMatchObject({ status: "failed", retryable: true, ambiguous: false });

    provider.failNextWith(new EmailProviderError("Resend response had no id", true, 200));
    const noId = await sendEmail(input({ to: "third@gmail.com" }), deps(createMemoryStore()));
    expect(noId).toMatchObject({ ambiguous: true });
  });

  it("records provider failures and reports whether a retry makes sense", async () => {
    const store = createMemoryStore();
    provider.failNextWith(new EmailProviderError("Too many requests", true, 429));
    const result = await sendEmail(input(), deps(store));
    expect(result).toMatchObject({ status: "failed", error: "Too many requests", retryable: true });
    expect(store.messages[0]).toMatchObject({ status: "failed", error: "Too many requests" });

    provider.failNextWith(new EmailProviderError("Invalid from", false, 422));
    const permanent = await sendEmail(input({ to: "other@gmail.com" }), deps(createMemoryStore()));
    expect(permanent).toMatchObject({ status: "failed", retryable: false });
  });
});
