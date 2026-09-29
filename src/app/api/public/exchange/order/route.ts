import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";

export async function GET(request: NextRequest) {
  try {
    const orderNumberParam = request.nextUrl.searchParams.get("order_number");
    const cpfParam = request.nextUrl.searchParams.get("cpf");

    if (!orderNumberParam) {
      return NextResponse.json(
        { error: "Número do pedido é obrigatório." },
        { status: 400 }
      );
    }

    const cleanOrderNumber = orderNumberParam.replace(/#/g, "").trim();
    const cleanCpf = (cpfParam || "").replace(/\D/g, "");
    const supabase = supabaseAdmin();

    // 1. Tentar buscar primeiro via WooCommerce se houver integração ativa
    let wooOrder: any = null;
    const { data: wooConfig } = await supabase
      .from("integration_configs")
      .select("store_url, credentials, status")
      .eq("platform", "woocommerce")
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (wooConfig?.store_url && wooConfig?.credentials) {
      try {
        const { consumer_key, consumer_secret } = wooConfig.credentials as {
          consumer_key?: string;
          consumer_secret?: string;
        };

        if (consumer_key && consumer_secret) {
          const baseUrl = wooConfig.store_url.replace(/\/+$/, "");
          const authHeader = `Basic ${Buffer.from(`${consumer_key}:${consumer_secret}`).toString("base64")}`;

          // Tentar buscar por ID direto
          const res = await fetch(`${baseUrl}/wp-json/wc/v3/orders/${cleanOrderNumber}`, {
            headers: { Authorization: authHeader },
          });

          if (res.ok) {
            wooOrder = await res.json();
          }
        }
      } catch (e) {
        console.warn("[public/exchange/order] Falha ao consultar WooCommerce diretamente:", e);
      }
    }

    // 2. Se encontrou no WooCommerce
    if (wooOrder) {
      // Extrair meta_data útil
      const getMeta = (key: string) => {
        const item = wooOrder.meta_data?.find((m: any) => m.key === key || m.key === `_${key}`);
        return item?.value || "";
      };

      const orderCpf = (wooOrder.billing?.cpf || getMeta("billing_cpf") || "").replace(/\D/g, "");

      // Se o cliente forneceu CPF e o pedido tem CPF, validar
      if (cleanCpf && orderCpf && cleanCpf.length >= 4 && orderCpf.length >= 4) {
        const inputTail = cleanCpf.slice(-4);
        const orderTail = orderCpf.slice(-4);
        if (inputTail !== orderTail && cleanCpf !== orderCpf) {
          return NextResponse.json(
            { error: "O CPF informado não confere com o titular deste pedido." },
            { status: 403 }
          );
        }
      }

      const shipping = wooOrder.shipping?.address_1 ? wooOrder.shipping : wooOrder.billing;
      const streetNumber = shipping?.number || getMeta("shipping_number") || getMeta("billing_number") || "";
      const neighborhood = shipping?.neighborhood || getMeta("shipping_neighborhood") || getMeta("billing_neighborhood") || "";

      const items = (wooOrder.line_items || []).map((li: any) => {
        // Encontrar variação de tamanho nas meta_data
        let size = "";
        if (Array.isArray(li.meta_data)) {
          const sizeMeta = li.meta_data.find((m: any) =>
            /tamanho|size|pa_tamanho/i.test(m.key || "") || /tamanho/i.test(m.display_key || "")
          );
          if (sizeMeta) {
            size = String(sizeMeta.display_value || sizeMeta.value || "");
          }
        }

        return {
          id: li.id,
          product_id: li.product_id,
          name: li.name,
          quantity: li.quantity,
          original_size: size || "Padrão",
          price: parseFloat(li.total || 0),
          image: li.image?.src || null,
        };
      });

      return NextResponse.json({
        found: true,
        source: "woocommerce",
        order: {
          order_number: String(wooOrder.number || wooOrder.id),
          customer_name: `${wooOrder.billing?.first_name || ""} ${wooOrder.billing?.last_name || ""}`.trim(),
          customer_phone: wooOrder.billing?.phone || "",
          customer_email: wooOrder.billing?.email || "",
          customer_cpf: orderCpf,
          status: wooOrder.status,
          date_created: wooOrder.date_created,
          shipping_address: {
            cep: (shipping?.postcode || "").replace(/\D/g, ""),
            logradouro: shipping?.address_1 || "",
            numero: streetNumber,
            complemento: shipping?.address_2 || "",
            bairro: neighborhood,
            cidade: shipping?.city || "",
            uf: shipping?.state || "",
          },
          items,
        },
      });
    }

    // 3. Fallback: Buscar na tabela orders local do Supabase
    const { data: dbOrder } = await supabase
      .from("orders")
      .select(`
        id,
        order_number,
        external_order_id,
        status,
        customer_email,
        customer_phone,
        line_items,
        ordered_at,
        contact_id,
        contacts (
          id,
          name,
          phone,
          metadata
        )
      `)
      .or(`order_number.eq.${cleanOrderNumber},external_order_id.eq.${cleanOrderNumber}`)
      .limit(1)
      .maybeSingle();

    if (!dbOrder) {
      return NextResponse.json(
        { found: false, message: "Pedido não localizado. Preencha os campos manualmente." },
        { status: 404 }
      );
    }

    const contact = (dbOrder as any).contacts;
    const contactMeta = (contact?.metadata as any) || {};
    const contactCpf = (contactMeta.cpf || "").replace(/\D/g, "");

    if (cleanCpf && contactCpf && cleanCpf.length >= 4 && contactCpf.length >= 4) {
      if (cleanCpf.slice(-4) !== contactCpf.slice(-4) && cleanCpf !== contactCpf) {
        return NextResponse.json(
          { error: "O CPF informado não confere com o titular deste pedido." },
          { status: 403 }
        );
      }
    }

    const items = ((dbOrder.line_items as any[]) || []).map((li: any, idx: number) => ({
      id: li.product_id || idx,
      name: li.name || "Produto",
      quantity: li.quantity || 1,
      original_size: li.size || "Padrão",
      price: li.total || 0,
    }));

    return NextResponse.json({
      found: true,
      source: "supabase",
      order: {
        order_number: dbOrder.order_number || dbOrder.external_order_id,
        customer_name: contact?.name || "",
        customer_phone: dbOrder.customer_phone || contact?.phone || "",
        customer_email: dbOrder.customer_email || "",
        customer_cpf: contactCpf,
        status: dbOrder.status,
        date_created: dbOrder.ordered_at,
        shipping_address: contactMeta.address || null,
        items,
      },
    });
  } catch (err: any) {
    console.error("[public/exchange/order] Erro:", err);
    return NextResponse.json(
      { error: "Erro ao buscar pedido. Você pode preencher manualmente." },
      { status: 500 }
    );
  }
}
