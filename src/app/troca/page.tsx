"use client";

import React, { useState } from "react";

interface OrderLineItem {
  id: string | number;
  product_id?: number | string;
  name: string;
  quantity: number;
  original_size: string;
  requested_size: string;
  price?: number;
  image?: string | null;
  selected: boolean;
}

export default function TrocaPage() {
  // Busca
  const [orderNumberInput, setOrderNumberInput] = useState("");
  const [cpfInput, setCpfInput] = useState("");
  const [searchingOrder, setSearchingOrder] = useState(false);
  const [orderFound, setOrderFound] = useState(false);
  const [searchFeedback, setSearchFeedback] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  // Dados do formulário
  const [orderNumber, setOrderNumber] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [cpf, setCpf] = useState("");
  const [email, setEmail] = useState("");
  const [type, setType] = useState<"troca" | "devolucao">("troca");
  const [reason, setReason] = useState("Tamanho não serviu (ficou pequeno)");
  const [customReason, setCustomReason] = useState("");
  const [pixKey, setPixKey] = useState("");

  // Endereço
  const [cep, setCep] = useState("");
  const [logradouro, setLogradouro] = useState("");
  const [numero, setNumero] = useState("");
  const [complemento, setComplemento] = useState("");
  const [bairro, setBairro] = useState("");
  const [cidade, setCidade] = useState("");
  const [uf, setUf] = useState("");
  const [loadingCep, setLoadingCep] = useState(false);

  // Itens encontrados do pedido
  const [orderItems, setOrderItems] = useState<OrderLineItem[]>([]);

  // Itens manuais (caso o pedido não seja localizado)
  const [manualItems, setManualItems] = useState<
    { name: string; original_size: string; requested_size: string; quantity: number }[]
  >([{ name: "", original_size: "M", requested_size: "G", quantity: 1 }]);

  // Termos
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Estados de envio
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successData, setSuccessData] = useState<{
    orderNumber: string;
    protocol: string;
  } | null>(null);

  // Máscaras
  const formatPhone = (val: string) => {
    const raw = val.replace(/\D/g, "").slice(0, 11);
    if (raw.length <= 2) return raw;
    if (raw.length <= 7) return `(${raw.slice(0, 2)}) ${raw.slice(2)}`;
    return `(${raw.slice(0, 2)}) ${raw.slice(2, 7)}-${raw.slice(7)}`;
  };

  const formatCpf = (val: string) => {
    const raw = val.replace(/\D/g, "").slice(0, 11);
    if (raw.length <= 3) return raw;
    if (raw.length <= 6) return `${raw.slice(0, 3)}.${raw.slice(3)}`;
    if (raw.length <= 9) return `${raw.slice(0, 3)}.${raw.slice(3, 6)}.${raw.slice(6)}`;
    return `${raw.slice(0, 3)}.${raw.slice(3, 6)}.${raw.slice(6, 9)}-${raw.slice(9)}`;
  };

  const handleCepChange = async (val: string) => {
    const raw = val.replace(/\D/g, "").slice(0, 8);
    const masked = raw.length > 5 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw;
    setCep(masked);

    if (raw.length === 8) {
      setLoadingCep(true);
      try {
        const res = await fetch(`https://viacep.com.br/ws/${raw}/json/`);
        const data = await res.json();
        if (!data.erro) {
          setLogradouro(data.logradouro || "");
          setBairro(data.bairro || "");
          setCidade(data.localidade || "");
          setUf(data.uf || "");
        }
      } catch (e) {
        console.error("Erro ao buscar CEP:", e);
      } finally {
        setLoadingCep(false);
      }
    }
  };

  // Buscar Pedido por Número e CPF
  const handleSearchOrder = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSearchFeedback(null);

    const cleanNum = orderNumberInput.replace(/#/g, "").trim();
    const cleanCpf = cpfInput.replace(/\D/g, "").trim();

    if (!cleanNum) {
      setSearchFeedback({
        type: "error",
        text: "Por favor, digite o número do seu pedido.",
      });
      return;
    }

    setSearchingOrder(true);

    try {
      const url = `/api/public/exchange/order?order_number=${encodeURIComponent(
        cleanNum
      )}&cpf=${encodeURIComponent(cleanCpf)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (res.ok && data.found && data.order) {
        const o = data.order;
        setOrderNumber(o.order_number);
        if (o.customer_name) setName(o.customer_name);
        if (o.customer_phone) setPhone(formatPhone(o.customer_phone));
        if (o.customer_email) setEmail(o.customer_email);
        if (cleanCpf) setCpf(formatCpf(cleanCpf));

        if (o.shipping_address) {
          const addr = o.shipping_address;
          if (addr.cep) setCep(addr.cep.length === 8 ? `${addr.cep.slice(0, 5)}-${addr.cep.slice(5)}` : addr.cep);
          if (addr.logradouro) setLogradouro(addr.logradouro);
          if (addr.numero) setNumero(addr.numero);
          if (addr.complemento) setComplemento(addr.complemento);
          if (addr.bairro) setBairro(addr.bairro);
          if (addr.cidade) setCidade(addr.cidade);
          if (addr.uf) setUf(addr.uf);
        }

        if (Array.isArray(o.items) && o.items.length > 0) {
          const loadedItems: OrderLineItem[] = o.items.map((it: any) => ({
            id: it.id,
            name: it.name,
            quantity: it.quantity || 1,
            original_size: it.original_size || "Padrão",
            requested_size: it.original_size === "M" ? "G" : "M",
            price: it.price,
            image: it.image,
            selected: true, // Selecionado por padrão para facilidade
          }));
          setOrderItems(loadedItems);
          setOrderFound(true);
        } else {
          setOrderFound(false);
        }

        setSearchFeedback({
          type: "success",
          text: `Pedido #${o.order_number} localizado com sucesso! Verifique os itens e dados abaixo.`,
        });
      } else {
        setOrderFound(false);
        setOrderNumber(cleanNum);
        if (cleanCpf) setCpf(formatCpf(cleanCpf));
        setSearchFeedback({
          type: "info",
          text:
            data.error ||
            "Não foi possível buscar automaticamente com esse CPF. Você pode preencher os dados manualmente logo abaixo.",
        });
      }
    } catch (err: any) {
      setOrderFound(false);
      setSearchFeedback({
        type: "info",
        text: "Não conseguimos carregar o pedido automaticamente. Prossiga preenchendo os campos abaixo.",
      });
    } finally {
      setSearchingOrder(false);
    }
  };

  const toggleItemSelection = (idx: number) => {
    setOrderItems((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], selected: !copy[idx].selected };
      return copy;
    });
  };

  const updateOrderItemSize = (idx: number, size: string) => {
    setOrderItems((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], requested_size: size };
      return copy;
    });
  };

  const updateOrderItemQty = (idx: number, qty: number) => {
    setOrderItems((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], quantity: qty };
      return copy;
    });
  };

  // Itens Manuais
  const addManualItem = () => {
    setManualItems((prev) => [
      ...prev,
      { name: "", original_size: "M", requested_size: "G", quantity: 1 },
    ]);
  };

  const removeManualItem = (idx: number) => {
    if (manualItems.length <= 1) return;
    setManualItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateManualItem = (idx: number, field: string, val: any) => {
    setManualItems((prev) => {
      const copy = [...prev] as any[];
      copy[idx] = { ...copy[idx], [field]: val };
      return copy;
    });
  };

  // Submissão do Formulário
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");

    const finalOrderNumber = orderNumber || orderNumberInput;
    if (!finalOrderNumber.trim()) {
      setErrorMsg("Informe o número do seu pedido.");
      return;
    }
    if (!name.trim()) {
      setErrorMsg("Informe seu nome completo.");
      return;
    }
    if (phone.replace(/\D/g, "").length < 10) {
      setErrorMsg("Informe um WhatsApp válido com DDD.");
      return;
    }
    if (!logradouro.trim() || !numero.trim() || !cidade.trim() || !uf.trim()) {
      setErrorMsg("Preencha o endereço completo para envio.");
      return;
    }

    // Coletar itens selecionados ou manuais
    let finalItems: any[] = [];
    if (orderFound && orderItems.length > 0) {
      const selected = orderItems.filter((it) => it.selected);
      if (selected.length === 0) {
        setErrorMsg("Selecione ao menos 1 peça que deseja trocar ou devolver.");
        return;
      }
      finalItems = selected.map((it) => ({
        name: it.name,
        original_size: it.original_size,
        requested_size: type === "troca" ? it.requested_size : null,
        quantity: it.quantity,
      }));
    } else {
      const invalid = manualItems.some((it) => !it.name.trim());
      if (invalid) {
        setErrorMsg("Informe o nome ou modelo de todas as peças listadas.");
        return;
      }
      finalItems = manualItems.map((it) => ({
        name: it.name.trim(),
        original_size: it.original_size,
        requested_size: type === "troca" ? it.requested_size : null,
        quantity: it.quantity,
      }));
    }

    if (!termsAccepted) {
      setErrorMsg("Você precisa aceitar os termos de envio e higiene da DLY.");
      return;
    }

    setSubmitting(true);

    try {
      const fullReason =
        reason === "Outro" && customReason.trim()
          ? `Outro: ${customReason.trim()}`
          : reason;

      const payload = {
        order_number: finalOrderNumber.trim(),
        customer_name: name.trim(),
        customer_phone: phone.replace(/\D/g, ""),
        customer_email: email.trim(),
        customer_cpf: (cpf || cpfInput).trim(),
        type,
        reason: fullReason,
        items: finalItems,
        sender_address: {
          cep: cep.replace(/\D/g, ""),
          logradouro: logradouro.trim(),
          numero: numero.trim(),
          complemento: complemento.trim(),
          bairro: bairro.trim(),
          cidade: cidade.trim(),
          uf: uf.trim().toUpperCase(),
        },
        bank_info: type === "devolucao" && pixKey.trim() ? { pix_key: pixKey.trim() } : null,
      };

      const res = await fetch("/api/public/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Erro ao registrar a solicitação.");
      }

      setSuccessData({
        orderNumber: data.order_number,
        protocol: data.exchange_id?.slice(0, 8).toUpperCase() || "DLY",
      });
    } catch (err: any) {
      setErrorMsg(err.message || "Erro inesperado. Tente novamente.");
    } finally {
      setSubmitting(false);
    }
  };

  if (successData) {
    const waUrl = `https://wa.me/554799375864?text=${encodeURIComponent(
      `Olá! Acabei de enviar minha solicitação de ${type} para o pedido #${successData.orderNumber} (Protocolo: ${successData.protocol}).`
    )}`;

    return (
      <main className="max-w-xl mx-auto px-4 py-12">
        <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-100 text-center">
          <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl font-bold">
            ✓
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">
            Solicitação Registrada!
          </h1>
          <p className="text-slate-600 mb-6 text-sm">
            Recebemos seu pedido de <strong>{type === "troca" ? "Troca" : "Devolução"}</strong> referente ao pedido{" "}
            <strong>#{successData.orderNumber}</strong>.
          </p>

          <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 mb-6 text-left text-sm space-y-2">
            <div className="flex justify-between border-b border-slate-200/50 pb-2">
              <span className="text-slate-500">Protocolo:</span>
              <span className="font-mono font-bold text-slate-700">#{successData.protocol}</span>
            </div>
            <div className="flex justify-between border-b border-slate-200/50 pb-2">
              <span className="text-slate-500">Status:</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800">
                Em Análise pela Atendente
              </span>
            </div>
            <p className="text-xs text-slate-500 pt-1">
              Nossa equipe já está analisando seus dados e entrará em contato via WhatsApp com a sua <strong>Autorização de Postagem Reversa dos Correios</strong>.
            </p>
          </div>

          <div className="space-y-3">
            <a
              href={waUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full inline-flex items-center justify-center gap-2 bg-[#25D366] hover:bg-[#20ba59] text-white font-semibold py-3.5 px-6 rounded-xl transition-all shadow-sm"
            >
              <span>Avisar Atendimento no WhatsApp</span>
            </a>
            <button
              onClick={() => {
                setSuccessData(null);
                setOrderNumber("");
                setOrderItems([]);
                setOrderFound(false);
              }}
              className="w-full py-2.5 text-xs text-slate-500 hover:text-slate-700 transition-colors"
            >
              Fazer outra solicitação
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-8 md:py-12">
      {/* Header */}
      <div className="text-center mb-8">
        <span className="inline-block px-3 py-1 bg-rose-100 text-[#d4569e] rounded-full text-xs font-semibold tracking-wider uppercase mb-3">
          Atendimento DLY Lingerie
        </span>
        <h1 className="text-2xl md:text-3xl font-bold text-slate-800 tracking-tight">
          Portal de Trocas & Devoluções
        </h1>
        <p className="text-slate-500 text-sm mt-2 max-w-md mx-auto">
          Localize seu pedido pelo número e CPF para carregar suas peças e endereço automaticamente.
        </p>
      </div>

      {/* Box de Busca do Pedido */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200/80 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">🔍</span>
          <h2 className="font-bold text-slate-800 text-sm uppercase tracking-wide">
            Localizar Meu Pedido
          </h2>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Digite o número do seu pedido e o seu CPF para preencher as peças e o endereço de envio automaticamente.
        </p>

        <form onSubmit={handleSearchOrder} className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
          <div className="sm:col-span-4">
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Número do Pedido *
            </label>
            <input
              type="text"
              value={orderNumberInput}
              onChange={(e) => setOrderNumberInput(e.target.value)}
              placeholder="Ex: 12345"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
            />
          </div>

          <div className="sm:col-span-5">
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              CPF do Titular da Compra
            </label>
            <input
              type="text"
              value={cpfInput}
              onChange={(e) => setCpfInput(formatCpf(e.target.value))}
              placeholder="000.000.000-00"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
            />
          </div>

          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={searchingOrder}
              className="w-full py-2.5 px-4 rounded-xl font-bold text-white bg-[#e47cbd] hover:bg-[#d4569e] transition-all text-sm shadow-sm disabled:opacity-60 flex items-center justify-center gap-1.5"
            >
              {searchingOrder ? (
                <span>Buscando...</span>
              ) : (
                <>
                  <span>Buscar</span>
                  <span>→</span>
                </>
              )}
            </button>
          </div>
        </form>

        {searchFeedback && (
          <div
            className={`mt-4 p-3 rounded-xl text-xs font-medium border ${
              searchFeedback.type === "success"
                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                : searchFeedback.type === "error"
                ? "bg-red-50 text-red-800 border-red-200"
                : "bg-blue-50 text-blue-800 border-blue-200"
            }`}
          >
            {searchFeedback.text}
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Card 1: Tipo de Solicitação */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
            1. O que você deseja fazer?
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setType("troca")}
              className={`p-4 rounded-xl border text-left transition-all ${
                type === "troca"
                  ? "border-[#e47cbd] bg-rose-50/50 shadow-sm"
                  : "border-slate-200 hover:border-slate-300 bg-white"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-slate-800">🔄 Troca de Peça/Tamanho</span>
                {type === "troca" && <span className="text-[#e47cbd] font-bold">✓</span>}
              </div>
              <p className="text-xs text-slate-500">
                Até 30 dias após o recebimento. Escolha novos tamanhos ou modelos.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setType("devolucao")}
              className={`p-4 rounded-xl border text-left transition-all ${
                type === "devolucao"
                  ? "border-[#e47cbd] bg-rose-50/50 shadow-sm"
                  : "border-slate-200 hover:border-slate-300 bg-white"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-slate-800">📦 Devolução e Reembolso</span>
                {type === "devolucao" && <span className="text-[#e47cbd] font-bold">✓</span>}
              </div>
              <p className="text-xs text-slate-500">
                Até 7 dias após o recebimento. Estorno em cartão ou Pix.
              </p>
            </button>
          </div>

          <div className="mt-4">
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Motivo principal:
            </label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
            >
              <option value="Tamanho não serviu (ficou pequeno)">Tamanho não serviu (ficou pequeno)</option>
              <option value="Tamanho não serviu (ficou grande)">Tamanho não serviu (ficou grande)</option>
              <option value="Não vestiu bem / Modelo não agradou">Não vestiu bem / Modelo não agradou</option>
              <option value="Defeito de fabricação">Defeito de fabricação</option>
              <option value="Produto divergente do comprado">Produto divergente do comprado</option>
              <option value="Arrependimento da compra (Devolução)">Arrependimento da compra (Devolução)</option>
              <option value="Outro">Outro motivo</option>
            </select>
          </div>

          {reason === "Outro" && (
            <div className="mt-3">
              <input
                type="text"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Descreva brevemente o motivo..."
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>
          )}

          {type === "devolucao" && (
            <div className="mt-4 p-3.5 bg-amber-50/70 border border-amber-200/60 rounded-xl">
              <label className="block text-xs font-semibold text-amber-900 mb-1">
                Chave PIX para reembolso (se pago por Pix ou Boleto):
              </label>
              <input
                type="text"
                value={pixKey}
                onChange={(e) => setPixKey(e.target.value)}
                placeholder="CPF, E-mail, Celular ou Chave Aleatória"
                className="w-full px-3.5 py-2 rounded-lg border border-amber-300/70 bg-white text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
          )}
        </div>

        {/* Card 2: Peças do Pedido */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
            2. Selecione as peças para {type === "troca" ? "trocar" : "devolver"}
          </label>

          {orderFound && orderItems.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs text-slate-500 mb-2">
                Peças compradas no pedido. Marque as que você deseja e escolha os tamanhos pretendidos:
              </p>
              {orderItems.map((it, idx) => (
                <div
                  key={it.id || idx}
                  className={`p-4 rounded-xl border transition-all ${
                    it.selected
                      ? "border-[#e47cbd] bg-rose-50/30 shadow-sm"
                      : "border-slate-200 bg-slate-50 opacity-60"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      id={`item-cb-${idx}`}
                      checked={it.selected}
                      onChange={() => toggleItemSelection(idx)}
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-[#e47cbd] focus:ring-[#e47cbd]"
                    />
                    <div className="flex-1">
                      <label htmlFor={`item-cb-${idx}`} className="font-semibold text-slate-800 text-sm cursor-pointer block">
                        {it.name}
                      </label>
                      <div className="text-xs text-slate-500 mt-0.5">
                        Tamanho original da compra: <strong className="text-slate-700">{it.original_size}</strong>
                        {it.price ? ` · R$ ${it.price.toFixed(2)}` : ""}
                      </div>

                      {it.selected && (
                        <div className="mt-3 pt-3 border-t border-slate-200/60 grid grid-cols-2 gap-3 items-center">
                          {type === "troca" ? (
                            <div>
                              <label className="block text-xs font-semibold text-slate-700 mb-1">
                                Novo tamanho desejado:
                              </label>
                              <select
                                value={it.requested_size}
                                onChange={(e) => updateOrderItemSize(idx, e.target.value)}
                                className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]"
                              >
                                <option value="P">P (40)</option>
                                <option value="M">M (42)</option>
                                <option value="G">G (44)</option>
                                <option value="GG">GG (46)</option>
                                <option value="XGG">XGG (48+)</option>
                                <option value="Outro Modelo">Outro modelo (cupom)</option>
                              </select>
                            </div>
                          ) : (
                            <div className="text-xs text-slate-500">
                              Esta peça será reembolsada após análise.
                            </div>
                          )}

                          <div>
                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                              Quantidade:
                            </label>
                            <input
                              type="number"
                              min={1}
                              max={it.quantity || 99}
                              value={it.quantity}
                              onChange={(e) => updateOrderItemQty(idx, parseInt(e.target.value) || 1)}
                              className="w-20 px-2.5 py-1 bg-white rounded-lg border border-slate-200 text-xs font-medium focus:outline-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div>
              <p className="text-xs text-slate-500 mb-3">
                Preencha as peças manualmente:
              </p>
              <div className="space-y-3">
                {manualItems.map((it, idx) => (
                  <div
                    key={idx}
                    className="p-4 bg-slate-50 rounded-xl border border-slate-200/60 relative space-y-3"
                  >
                    {manualItems.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeManualItem(idx)}
                        className="absolute top-2 right-2 text-slate-400 hover:text-red-500 text-xs p-1"
                      >
                        Remover ✕
                      </button>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Nome da peça ou descrição:
                      </label>
                      <input
                        type="text"
                        required
                        value={it.name}
                        onChange={(e) => updateManualItem(idx, "name", e.target.value)}
                        placeholder="Ex: Sutiã Renda Conforto Preto"
                        className="w-full px-3 py-2 bg-white rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30"
                      />
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">
                          Tam. Recebido:
                        </label>
                        <select
                          value={it.original_size}
                          onChange={(e) => updateManualItem(idx, "original_size", e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200 text-sm focus:outline-none"
                        >
                          <option value="P">P (40)</option>
                          <option value="M">M (42)</option>
                          <option value="G">G (44)</option>
                          <option value="GG">GG (46)</option>
                          <option value="XGG">XGG (48+)</option>
                          <option value="U">Único</option>
                        </select>
                      </div>

                      {type === "troca" && (
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">
                            Tam. Desejado:
                          </label>
                          <select
                            value={it.requested_size}
                            onChange={(e) => updateManualItem(idx, "requested_size", e.target.value)}
                            className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200 text-sm focus:outline-none"
                          >
                            <option value="P">P (40)</option>
                            <option value="M">M (42)</option>
                            <option value="G">G (44)</option>
                            <option value="GG">GG (46)</option>
                            <option value="XGG">XGG (48+)</option>
                            <option value="Outro">Outro modelo</option>
                          </select>
                        </div>
                      )}

                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">
                          Quantidade:
                        </label>
                        <input
                          type="number"
                          min={1}
                          value={it.quantity}
                          onChange={(e) => updateManualItem(idx, "quantity", parseInt(e.target.value) || 1)}
                          className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200 text-sm focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={addManualItem}
                  className="text-xs font-bold text-[#e47cbd] hover:text-[#d4569e] transition-colors"
                >
                  + Adicionar outra peça
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Card 3: Dados de Identificação */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-4">
            3. Seus Dados de Contato
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Número do Pedido *
              </label>
              <input
                type="text"
                required
                value={orderNumber || orderNumberInput}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="Ex: 12345"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                WhatsApp com DDD *
              </label>
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(formatPhone(e.target.value))}
                placeholder="(47) 99999-9999"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Nome Completo *
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Como no cadastro da compra"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                CPF do Titular *
              </label>
              <input
                type="text"
                value={cpf || cpfInput}
                onChange={(e) => setCpf(formatCpf(e.target.value))}
                placeholder="000.000.000-00"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                E-mail
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu@email.com"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>
          </div>
        </div>

        {/* Card 4: Endereço de Envio (Correios) */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-4">
            4. Endereço de Coleta (Para a Postagem Reversa)
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                CEP * {loadingCep && <span className="text-xs text-[#e47cbd] font-normal">(buscando...)</span>}
              </label>
              <input
                type="text"
                required
                value={cep}
                onChange={(e) => handleCepChange(e.target.value)}
                placeholder="00000-000"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Rua / Logradouro *
              </label>
              <input
                type="text"
                required
                value={logradouro}
                onChange={(e) => setLogradouro(e.target.value)}
                placeholder="Nome da sua rua ou avenida"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Número *
              </label>
              <input
                type="text"
                required
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                placeholder="123"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Complemento
              </label>
              <input
                type="text"
                value={complemento}
                onChange={(e) => setComplemento(e.target.value)}
                placeholder="Apto, Bloco..."
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Bairro *
              </label>
              <input
                type="text"
                required
                value={bairro}
                onChange={(e) => setBairro(e.target.value)}
                placeholder="Bairro"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Cidade *
              </label>
              <input
                type="text"
                required
                value={cidade}
                onChange={(e) => setCidade(e.target.value)}
                placeholder="Cidade"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Estado (UF) *
              </label>
              <input
                type="text"
                maxLength={2}
                required
                value={uf}
                onChange={(e) => setUf(e.target.value.toUpperCase())}
                placeholder="SC"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#e47cbd]/30 focus:border-[#e47cbd] uppercase"
              />
            </div>
          </div>
        </div>

        {/* Card 5: Termos e Condições DLY */}
        <div className="bg-rose-50/50 border border-rose-100 rounded-2xl p-5 text-xs text-slate-600 space-y-3">
          <div className="font-bold text-slate-800 flex items-center gap-1.5">
            <span>⚠️</span> Condições Importantes para Envio (Moda Íntima):
          </div>
          <ul className="space-y-1.5 list-disc pl-4 text-slate-600">
            <li>As peças devem conter todas as <strong>etiquetas originais fixadas</strong>.</li>
            <li>Não serão aceitos produtos com odor, sinais de uso, manchas ou modificações.</li>
            <li><strong>Sutiãs de bojo</strong> devem ser enviados abertos na caixa original para não danificar a estrutura.</li>
            <li>O código de postagem reversa dos Correios é 100% gratuito e será enviado pelo nosso atendimento no WhatsApp.</li>
          </ul>

          <label className="flex items-start gap-2.5 pt-2 cursor-pointer border-t border-rose-200/50">
            <input
              type="checkbox"
              required
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-[#e47cbd] focus:ring-[#e47cbd]"
            />
            <span className="text-xs font-medium text-slate-800">
              Li e concordo com a política de troca e devolução da DLY Lingerie.
            </span>
          </label>
        </div>

        {errorMsg && (
          <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs font-semibold">
            {errorMsg}
          </div>
        )}

        {/* Botão de Envio */}
        <button
          type="submit"
          disabled={submitting}
          className="w-full py-4 px-6 rounded-xl font-bold text-white bg-[#34495e] hover:bg-[#2c3e50] active:scale-[0.99] transition-all shadow-md hover:shadow-lg disabled:opacity-50 disabled:pointer-events-none"
        >
          {submitting ? "Registrando solicitação..." : "Enviar Solicitação de Troca"}
        </button>

        <p className="text-center text-xs text-slate-400">
          Dúvidas? Entre em contato pelo WhatsApp (47) 99937-5864.
        </p>
      </form>
    </main>
  );
}
