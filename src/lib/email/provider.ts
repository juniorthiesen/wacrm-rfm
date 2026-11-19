/**
 * Provider seam for outbound e-mail. Resend is the first (and only) provider;
 * keep new providers (SES, Postmark) behind this interface.
 */

export interface OutboundEmail {
  /** Full RFC 5322 "From": `Name <address@domain>`. */
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Provider tags; Resend allows [A-Za-z0-9_-] in name and value. */
  tags?: { name: string; value: string }[];
  /** Same key + same payload = at most one delivery, even if we retry. */
  idempotencyKey?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(email: OutboundEmail): Promise<{ id: string }>;
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    /** True for 429/5xx/network: the caller may retry later. */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmailProviderError";
  }
}

/** `Name <a@b.c>`; strips characters that could break the header. */
export function formatFromAddress(name: string, email: string): string {
  const cleanName = name.replace(/[\r\n"<>]/g, "").trim();
  return cleanName ? `${cleanName} <${email}>` : email;
}
