import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      order_number,
      customer_name,
      customer_phone,
      customer_email,
      customer_cpf,
      type = "troca",
      reason,
      items,
      sender_address,
      bank_info,
    } = body;

    if (!order_number || !customer_phone || !customer_name) {
      return NextResponse.json(
        { error: "Número do pedido, nome e telefone WhatsApp são obrigatórios." },
        { status: 400 }
      );
    }

    if (!sender_address || !sender_address.cep || !sender_address.logradouro) {
      return NextResponse.json(
        { error: "Endereço com CEP e logradouro é obrigatório para postagem reversa." },
        { status: 400 }
      );
    }

    const cleanPhone = customer_phone.replace(/\D/g, "");
    const supabase = supabaseAdmin();

    // 1. Tentar encontrar pedido e contato vinculados
    let contactId: string | null = null;
    let orderId: string | null = null;
    let userId: string | null = null;

    const { data: orderData } = await supabase
      .from("orders")
      .select("id, contact_id, user_id")
      .eq("order_number", String(order_number).replace(/#/g, "").trim())
      .limit(1)
      .maybeSingle();

    if (orderData) {
      orderId = orderData.id;
      contactId = orderData.contact_id;
      userId = orderData.user_id;
    } else {
      const { data: contactData } = await supabase
        .from("contacts")
        .select("id, user_id")
        .ilike("phone", `%${cleanPhone.slice(-8)}%`)
        .limit(1)
        .maybeSingle();

      if (contactData) {
        contactId = contactData.id;
        userId = contactData.user_id;
      }
    }

    // 2. Montar objeto da solicitação de troca/devolução
    const exchangeRecord = {
      order_number: String(order_number).replace(/#/g, "").trim(),
      customer_name: customer_name.trim(),
      customer_phone: cleanPhone,
      status: "solicitado",
      contact_id: contactId,
      order_id: orderId,
      user_id: userId,
      reason: [
        `${type.toUpperCase()}: ${reason || "Não especificado"}`,
        customer_cpf ? `CPF: ${customer_cpf}` : "",
        customer_email ? `Email: ${customer_email}` : "",
      ].filter(Boolean).join(" | "),
      items: Array.isArray(items) ? items : [],
      sender_address: {
        ...sender_address,
        cpf: customer_cpf,
        email: customer_email,
        bank_info: bank_info || null,
      },
      recipient_address: {
        nome: "DLY INDUSTRIA E COMERCIO DE CONFECCOES LTDA",
        logradouro: "RUA 21 DE JUNHO",
        numero: "1837",
        bairro: "CENTRO",
        cidade: "ILHOTA",
        uf: "SC",
        cep: "88320001",
      },
    };

    const { data, error } = await supabase
      .from("exchanges")
      .insert(exchangeRecord)
      .select("id, order_number, status, created_at")
      .single();

    if (error) {
      console.error("[public/exchange] Error creating exchange record:", error);
      return NextResponse.json(
        { error: "Não foi possível registrar a solicitação no banco de dados." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      exchange_id: data.id,
      order_number: data.order_number,
      message: "Solicitação registrada com sucesso! Nossa equipe entrará em contato via WhatsApp.",
    });
  } catch (err: any) {
    console.error("[public/exchange] Unexpected error:", err);
    return NextResponse.json(
      { error: err.message || "Erro interno do servidor ao processar solicitação." },
      { status: 500 }
    );
  }
}
