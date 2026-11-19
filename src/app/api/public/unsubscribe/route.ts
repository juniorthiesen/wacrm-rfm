import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { escapeHtml } from "@/lib/email/layout";
import { supabaseEmailStore } from "@/lib/email/store";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe";

/**
 * Public unsubscribe endpoint for e-mail (target of the footer link and of the
 * `List-Unsubscribe` header).
 *
 *  GET  ?t=<token>  → confirmation page with a button. It deliberately does NOT
 *                      unsubscribe: mail scanners and link-previewers fetch GET
 *                      URLs, and that must not silently remove people.
 *  POST ?t=<token>  → performs the unsubscribe. This is also what mail clients
 *                      call for RFC 8058 one-click (`List-Unsubscribe=One-Click`).
 *
 * Auth is the HMAC in the token (see src/lib/email/unsubscribe.ts). The route
 * is public on purpose: it is not under any path the middleware protects.
 */

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

function page(title: string, body: string, status = 200): NextResponse {
  const html =
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<meta name="robots" content="noindex" />` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="margin:0;background:#f6f3f0;font-family:Jost,Arial,Helvetica,sans-serif;color:#111111;">` +
    `<main style="max-width:480px;margin:12vh auto;padding:32px 28px;background:#ffffff;border:1px solid #e5e5e5;text-align:center;">` +
    `<h1 style="margin:0 0 14px;font-size:22px;font-weight:500;">${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const INVALID = () =>
  page(
    "Link inválido",
    `<p style="margin:0;color:#444;line-height:1.6;">Este link de cancelamento não é válido. Se você ainda recebe e-mails que não quer, responda a um deles pedindo para sair.</p>`,
    400,
  );

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("t") ?? "";
  const parsed = verifyUnsubscribeToken(token);
  if (!parsed) return INVALID();

  return page(
    "Cancelar inscrição",
    `<p style="margin:0 0 22px;color:#444;line-height:1.6;">Você deixará de receber nossos e-mails promocionais em <strong>${escapeHtml(maskEmail(parsed.email))}</strong>.</p>` +
      `<form method="post" action="/api/public/unsubscribe?t=${encodeURIComponent(token)}">` +
      `<button type="submit" style="background:#111111;color:#ffffff;border:0;padding:15px 28px;font-size:14px;font-weight:600;letter-spacing:0.1em;cursor:pointer;">CONFIRMAR CANCELAMENTO</button>` +
      `</form>`,
  );
}

export async function POST(request: NextRequest) {
  let token = request.nextUrl.searchParams.get("t") ?? "";
  let oneClick = false;

  // RFC 8058: the body is `List-Unsubscribe=One-Click` (form-encoded).
  try {
    const form = await request.formData();
    if (form.get("List-Unsubscribe") === "One-Click") oneClick = true;
    if (!token) token = String(form.get("t") ?? "");
  } catch {
    // no/invalid form body: the token in the query string is enough
  }

  const parsed = verifyUnsubscribeToken(token);
  if (!parsed) return INVALID();

  try {
    await supabaseEmailStore(supabaseAdmin()).addSuppression(
      parsed.userId,
      parsed.email,
      "unsubscribed",
      oneClick ? "one_click" : "link",
    );
  } catch (err) {
    console.error("[unsubscribe] failed to record suppression", err);
    return page(
      "Não foi possível concluir",
      `<p style="margin:0;color:#444;line-height:1.6;">Tente novamente em alguns minutos ou responda a um dos e-mails pedindo para sair.</p>`,
      500,
    );
  }

  return page(
    "Inscrição cancelada",
    `<p style="margin:0;color:#444;line-height:1.6;">Pronto. Você não receberá mais e-mails promocionais neste endereço.</p>`,
  );
}
