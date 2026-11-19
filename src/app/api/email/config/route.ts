import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseEmailConfigInput, toPublicConfig } from "@/lib/email/config";
import type { EmailConfig } from "@/lib/email/types";
import { encrypt } from "@/lib/whatsapp/encryption";

/**
 * GET /api/email/config  → the tenant's e-mail channel settings (secrets omitted)
 * PUT /api/email/config  → create/update them
 *
 * Runs with the user's own session (RLS: auth.uid() = user_id), so one tenant
 * can never read or write another's row. The Resend API key and the webhook
 * signing secret are encrypted (AES-256-GCM, same key as the WhatsApp token)
 * and are write-only: GET only reports whether they are set.
 */

async function currentUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  return { supabase, user: error ? null : user };
}

export async function GET() {
  const { supabase, user } = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("email_config")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    console.error("[email-config] read failed", error);
    return NextResponse.json({ error: "Falha ao ler a configuração" }, { status: 500 });
  }

  return NextResponse.json({
    config: data ? toPublicConfig(data as EmailConfig) : null,
    // Marketing e-mail refuses to send without a public URL for the unsubscribe link.
    site_url_configured: !!process.env.NEXT_PUBLIC_SITE_URL,
  });
}

export async function PUT(request: NextRequest) {
  const { supabase, user } = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { data: existing, error: readError } = await supabase
    .from("email_config")
    .select("api_key_encrypted")
    .eq("user_id", user.id)
    .maybeSingle();
  if (readError) {
    console.error("[email-config] read before write failed", readError);
    return NextResponse.json({ error: "Falha ao salvar a configuração" }, { status: 500 });
  }

  const parsed = parseEmailConfigInput(body, { has_api_key: !!existing?.api_key_encrypted });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.errors.join("; "), errors: parsed.errors }, { status: 400 });
  }
  const { api_key, webhook_secret, ...fields } = parsed.value;

  const { data, error } = await supabase
    .from("email_config")
    .upsert(
      {
        user_id: user.id,
        provider: "resend",
        ...fields,
        ...(api_key ? { api_key_encrypted: encrypt(api_key) } : {}),
        ...(webhook_secret ? { webhook_secret_encrypted: encrypt(webhook_secret) } : {}),
      },
      { onConflict: "user_id" },
    )
    .select("*")
    .single();
  if (error || !data) {
    console.error("[email-config] write failed", error);
    return NextResponse.json({ error: "Falha ao salvar a configuração" }, { status: 500 });
  }

  return NextResponse.json({ config: toPublicConfig(data as EmailConfig) });
}
