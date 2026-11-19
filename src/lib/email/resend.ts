import { EmailProviderError, type EmailProvider, type OutboundEmail } from "./provider";

/**
 * Resend over plain fetch (no SDK dependency). Docs: POST https://api.resend.com/emails
 * Idempotency is sent in the `Idempotency-Key` header.
 */
export class ResendProvider implements EmailProvider {
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = "https://api.resend.com",
    private readonly timeoutMs: number = 20_000,
  ) {}

  async send(email: OutboundEmail): Promise<{ id: string }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (email.idempotencyKey) headers["Idempotency-Key"] = email.idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
          ...(email.headers ? { headers: email.headers } : {}),
          ...(email.tags ? { tags: email.tags } : {}),
        }),
      });
    } catch (err) {
      // Network error / timeout: the request may or may not have been accepted,
      // but the idempotency key makes a retry safe.
      const message = err instanceof Error ? err.message : "network error";
      throw new EmailProviderError(`Resend request failed: ${message}`, true);
    }

    let body: { id?: string; message?: string; name?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON body: fall through to status handling
    }

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new EmailProviderError(
        body.message || `Resend responded ${res.status}`,
        retryable,
        res.status,
      );
    }
    if (!body.id) {
      throw new EmailProviderError("Resend response had no id", true, res.status);
    }
    return { id: body.id };
  }
}
