"use client";

import React, { useState } from "react";

interface Item {
  name: string;
  original_size: string;
  requested_size: string;
  quantity: number;
}

export default function TrocaPage() {
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

  // Itens
  const [items, setItems] = useState<Item[]>([
    { name: "", original_size: "M", requested_size: "G", quantity: 1 },
  ]);

  // Termos
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Estados de envio
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successData, setSuccessData] = useState<{
    orderNumber: string;
    protocol: string;
  } | null>(null);

  // Formatação de Máscaras
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

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { name: "", original_size: "M", requested_size: "G", quantity: 1 },
    ]);
  };

  const removeItem = (idx: number) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, field: keyof Item, val: any) => {
    setItems((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: val };
      return copy;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");

    if (!orderNumber.trim()) {
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
    const hasInvalidItem = items.some((it) => !it.name.trim());
    if (hasInvalidItem) {
      setErrorMsg("Informe o nome ou modelo de todas as peças listadas.");
      return;
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
        order_number: orderNumber.trim(),
        customer_name: name.trim(),
        customer_phone: phone.replace(/\D/g, ""),
        customer_email: email.trim(),
        customer_cpf: cpf.trim(),
        type,
        reason: fullReason,
        items,
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
          Formulário de Trocas & Devoluções
        </h1>
        <p className="text-slate-500 text-sm mt-2 max-w-md mx-auto">
          Preencha os dados abaixo para gerarmos sua autorização de postagem reversa dos Correios.
        </p>
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

        {/* Card 2: Identificação do Pedido */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-4">
            2. Seus Dados e Pedido
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Número do Pedido *
              </label>
              <input
                type="text"
                required
                value={orderNumber}
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
                value={cpf}
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

        {/* Card 3: Peças */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">
              3. Peças para {type === "troca" ? "Troca" : "Devolução"}
            </label>
            <button
              type="button"
              onClick={addItem}
              className="text-xs font-bold text-[#e47cbd] hover:text-[#d4569e] transition-colors"
            >
              + Adicionar outra peça
            </button>
          </div>

          <div className="space-y-3">
            {items.map((it, idx) => (
              <div
                key={idx}
                className="p-4 bg-slate-50 rounded-xl border border-slate-200/60 relative space-y-3"
              >
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
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
                    onChange={(e) => updateItem(idx, "name", e.target.value)}
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
                      onChange={(e) => updateItem(idx, "original_size", e.target.value)}
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
                        onChange={(e) => updateItem(idx, "requested_size", e.target.value)}
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
                      onChange={(e) => updateItem(idx, "quantity", parseInt(e.target.value) || 1)}
                      className="w-full px-2.5 py-1.5 bg-white rounded-lg border border-slate-200 text-sm focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Card 4: Endereço de Coleta */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-4">
            4. Endereço para Postagem Reversa
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
