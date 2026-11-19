import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { supabaseEmailStore } from "@/lib/email/store";
import {
  applyEmailEvent,
  mapResendEvent,
  verifySvixSignature,
  type ResendEvent,
} from "@/lib/email/webhook";
import { decrypt } from "@/lib/whatsapp/encryption";

/**
 * Resend delivery webhook (delivered / bounced / complained / opened / clicked).
 *
 * Which tenant's signing secret to use is only known after finding the message
 * the event refers to, so the flow is: parse (untrusted) → look the message up
 * (read-only) → verify the signature with that tenant's secret (or the
 * RESEND_WEBHOOK_SECRET fallback) → only then write. Unknown messages and
 * event types we don't track answer 200 so Resend stops retrying.
 *
 * Public route (not under any middleware-protected path).
 */
export async function POST(request: NextRequest) {
  const body = await request.text();

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const effect = mapResendEvent(event);
  if (!effect) return NextResponse.json({ ok: true, ignored: true });

  const store = supabaseEmailStore(supabaseAdmin());
  const message = await store.findMessage({
    providerMessageId: effect.providerMessageId,
    messageId: effect.messageId,
  });
  if (!message) return NextResponse.json({ ok: true, matched: false });

  const config = await store.getConfig(message.user_id);
  const secret = config?.webhook_secret_encrypted
    ? decrypt(config.webhook_secret_encrypted)
    : process.env.RESEND_WEBHOOK_SECRET;

  const verified =
    !!secret &&
    verifySvixSignature(
      {
        id: request.headers.get("svix-id"),
        timestamp: request.headers.get("svix-timestamp"),
        signature: request.headers.get("svix-signature"),
      },
      body,
      secret,
    );
  if (!verified) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  await applyEmailEvent(store, effect);
  return NextResponse.json({ ok: true });
}
