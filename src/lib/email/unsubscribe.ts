import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed unsubscribe tokens. Stateless (no table): the link carries the tenant
 * and the address, authenticated with an HMAC so nobody can unsubscribe
 * someone else by guessing. Tokens never expire on purpose: an unsubscribe
 * link in an old e-mail must keep working.
 *
 * Key: EMAIL_UNSUBSCRIBE_SECRET if set, otherwise derived from ENCRYPTION_KEY
 * (domain-separated, so the raw encryption key is never used as an HMAC key).
 * Rotating the key invalidates every link already sent.
 */

const VERSION = "v1";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signingKey(): Buffer {
  const base = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.ENCRYPTION_KEY;
  if (!base) {
    throw new Error("EMAIL_UNSUBSCRIBE_SECRET (or ENCRYPTION_KEY) must be set to sign unsubscribe links");
  }
  return createHmac("sha256", base).update("wacrm-email-unsubscribe-v1").digest();
}

function mac(data: string): Buffer {
  return createHmac("sha256", signingKey()).update(data).digest();
}

export function signUnsubscribeToken(userId: string, email: string): string {
  const body = b64url(JSON.stringify({ u: userId, e: normalizeEmail(email) }));
  const sig = b64url(mac(`${VERSION}.${body}`));
  return `${VERSION}.${body}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): { userId: string; email: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, body, sig] = parts;

  const expected = mac(`${VERSION}.${body}`);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      u?: unknown;
      e?: unknown;
    };
    if (typeof parsed.u !== "string" || typeof parsed.e !== "string" || !parsed.u || !parsed.e) {
      return null;
    }
    return { userId: parsed.u, email: normalizeEmail(parsed.e) };
  } catch {
    return null;
  }
}

/** `https://crm.example.com/api/public/unsubscribe?t=<token>` */
export function buildUnsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/public/unsubscribe?t=${encodeURIComponent(token)}`;
}
