import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { createReverseLogistics } from "@/lib/correios/client";

export async function GET(request: NextRequest) {
  const apiKey = request.headers.get("x-api-key") || request.nextUrl.searchParams.get("api_key");
  const expectedKey = process.env.EXTENSION_API_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey || (expectedKey && apiKey !== expectedKey)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const phone = request.nextUrl.searchParams.get("phone");
  const orderNumber = request.nextUrl.searchParams.get("order_number");

  const supabase = supabaseAdmin();
  let query = supabase.from("exchanges").select("*").order("created_at", { ascending: false });

  if (orderNumber) {
    query = query.eq("order_number", orderNumber);
  } else if (phone) {
    const cleanPhone = phone.replace(/\D/g, "");
    query = query.ilike("customer_phone", `%${cleanPhone.slice(-8)}%`);
  }

  const { data, error } = await query.limit(10);
  if (error) {
    // If table doesn't exist yet, return empty list gracefully
    return NextResponse.json({ exchanges: [] });
  }

  return NextResponse.json({ exchanges: data || [] });
}

export async function POST(request: NextRequest) {
  const apiKey = request.headers.get("x-api-key") || request.nextUrl.searchParams.get("api_key");
  const expectedKey = process.env.EXTENSION_API_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey || (expectedKey && apiKey !== expectedKey)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { orderNumber, phone, client, items, reason, notes } = body;

    if (!orderNumber) {
      return NextResponse.json({ error: "Número do pedido é obrigatório" }, { status: 400 });
    }

    if (!client || !client.nome || !client.logradouro || !client.cep) {
      return NextResponse.json({
        error: "Dados de endereço do cliente incompletos (nome, logradouro e CEP são obrigatórios)",
      }, { status: 400 });
    }

    // Call Correios Reverse Logistics API
    const result = await createReverseLogistics({
      orderNumber,
      client,
      items: items || [],
      daysValid: 15,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Erro ao emitir código nos Correios" }, { status: 400 });
    }

    const codeToPresent = result.eTicket || result.trackingCode || "";
    const validUntilParts = (result.validUntil || "").split("-");
    const validUntilBr = validUntilParts.length === 3 ? `${validUntilParts[2]}/${validUntilParts[1]}/${validUntilParts[0]}` : result.validUntil;

    // Build friendly customer WhatsApp message
    const itemsText = (items || []).map((i: any) => `- ${i.quantity || 1}x ${i.name}`).join("\n");
    const messageTemplate = `*Solicitação de Troca Autorizada! 🔄*\n\nPedido: *#${orderNumber}*\n${itemsText ? `Itens a devolver:\n${itemsText}\n\n` : ""}📦 *Código de Postagem Correios:* *${codeToPresent}*\n📅 *Validade:* até *${validUntilBr}*\n\n*Instruções:*\n1. Coloque as peças embaladas (pode usar a mesma caixa/embalagem virada do avesso).\n2. Apresente este código em qualquer agência dos Correios.\n3. O envio é 100% gratuito para você!\n\nAssim que postar, já começamos a preparar o seu novo envio! ✨`;

    // Persist exchange to Supabase
    const supabase = supabaseAdmin();
    try {
      await supabase.from("exchanges").insert({
        order_number: String(orderNumber),
        customer_name: client.nome,
        customer_phone: phone || client.telefone || null,
        status: "codigo_gerado",
        tracking_code: result.trackingCode,
        e_ticket_code: codeToPresent,
        expires_at: result.validUntil,
        items: items || [],
        reason: reason || null,
        sender_address: client,
      });
    } catch (dbErr) {
      console.warn("[WACRM] Note: Could not insert into exchanges table:", dbErr);
    }

    return NextResponse.json({
      success: true,
      eTicket: codeToPresent,
      trackingCode: result.trackingCode,
      validUntil: validUntilBr,
      messageTemplate,
    });
  } catch (err: any) {
    console.error("[WACRM] Error in create exchange route:", err);
    return NextResponse.json({ error: err.message || "Erro interno do servidor" }, { status: 500 });
  }
}
