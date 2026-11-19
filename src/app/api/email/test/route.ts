import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { renderEmailLayout } from "@/lib/email/layout";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email/send";
import { supabaseEmailStore } from "@/lib/email/store";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/email/test
 *
 * Sends a test message to the LOGGED-IN user's own address (never to an
 * arbitrary recipient, so the endpoint can't be used to mail third parties),
 * using the saved configuration, as transactional mail (so daily/frequency
 * limits can't hide a configuration problem). 5 per minute per user.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!user.email) {
    return NextResponse.json({ error: "Sua conta não tem e-mail para receber o teste" }, { status: 400 });
  }

  const rl = checkRateLimit(`email-test:${user.id}`, { limit: 5, windowMs: 60_000 });
  if (!rl.success) return rateLimitResponse(rl);

  const result = await sendEmail(
    {
      userId: user.id,
      to: user.email,
      subject: "Teste de e-mail do WaCRM",
      category: "transactional",
      campaignKey: "config_test",
      render: ({ brand }) =>
        renderEmailLayout(
          {
            preheader: "Se você recebeu esta mensagem, o canal de e-mail está funcionando.",
            heading: "E-mail de teste",
            paragraphs: [
              "Se você está lendo isto, o remetente, a chave da API e o domínio de envio estão corretos.",
              "Este é o layout que seus clientes verão: logo, cores e rodapé vêm da aba E-mail das configurações.",
            ],
            benefit: "Mensagem enviada pelo botão de teste das configurações.",
          },
          brand,
        ),
    },
    { store: supabaseEmailStore(supabaseAdmin()) },
  );

  switch (result.status) {
    case "sent":
      return NextResponse.json({ status: "sent", to: user.email });
    case "not_configured":
      return NextResponse.json(
        { status: "not_configured", error: "Salve e ative a configuração (chave, remetente) antes de testar." },
        { status: 400 },
      );
    case "suppressed":
      return NextResponse.json(
        { status: "suppressed", error: `Seu endereço está na lista de bloqueio (${result.reason}).` },
        { status: 409 },
      );
    case "failed":
      return NextResponse.json({ status: "failed", error: result.error }, { status: 502 });
    default:
      return NextResponse.json({ status: result.status }, { status: 409 });
  }
}
