/**
 * Correios API Client for Reverse Logistics (Logística Reversa / Pré-Postagem)
 * Automatically authenticates using contract credentials, caches token,
 * and communicates with api.correios.com.br
 */

interface CorreiosConfig {
  usuario: string;
  codigoAcesso: string;
  cartaoPostagem: string;
  contrato: string;
}

const DEFAULT_CONFIG: CorreiosConfig = {
  usuario: process.env.CORREIOS_USUARIO || "dlylingerie",
  codigoAcesso: process.env.CORREIOS_CODIGO_ACESSO || "OsxzNRyO0vzRwl7gPnLH9WSqTMKelVyHxmXYCZkS",
  cartaoPostagem: process.env.CORREIOS_CARTAO_POSTAGEM || "0076381803",
  contrato: process.env.CORREIOS_CONTRATO || "9912531459",
};

// DLY Lingerie fixed recipient details for reverse logistics
export const DLY_RECIPIENT = {
  nome: "DLY INDUSTRIA E COMERCIO DE CONFECCOES LTDA",
  cpfCnpj: "41143831000108",
  dddTelefone: "47",
  celular: "984612262",
  email: "financeiro@dullyacqua.com.br",
  endereco: {
    logradouro: "RUA 21 DE JUNHO",
    numero: "1837",
    complemento: "CASA",
    bairro: "CENTRO",
    cidade: "ILHOTA",
    uf: "SC",
    cep: "88320001",
  },
};

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Obtain Bearer Token from Correios API with 24h caching
 */
export async function getCorreiosToken(config: CorreiosConfig = DEFAULT_CONFIG): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const basicAuth = Buffer.from(`${config.usuario}:${config.codigoAcesso}`).toString("base64");
  const response = await fetch("https://api.correios.com.br/token/v1/autentica/cartaopostagem", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ numero: config.cartaoPostagem }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Falha na autenticação dos Correios (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const token = data.token as string;
  // Parse expiration (default 24h)
  const expiresAt = data.expiraEm ? new Date(data.expiraEm).getTime() : now + 24 * 60 * 60 * 1000;
  cachedToken = { token, expiresAt };
  return token;
}

export interface ClientAddress {
  nome: string;
  cpfCnpj?: string;
  email?: string;
  telefone?: string;
  logradouro: string;
  numero: string;
  complemento?: string;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
}

export interface ReverseLogisticsParams {
  orderNumber: string;
  client: ClientAddress;
  serviceCode?: string; // default "04669" (PAC Reverso)
  daysValid?: number;   // default 15 days
  items?: Array<{ name: string; quantity: number; value?: number }>;
  weightGrams?: number; // default 300g
}

export interface ReverseLogisticsResult {
  success: boolean;
  trackingCode?: string;   // e.g. QD...BR
  eTicket?: string;        // Authorization code / idAtendimento
  validUntil?: string;     // ISO Date
  error?: string;
}

/**
 * Generate Reverse Logistics (Pré-Postagem Reversa) in Correios
 */
export async function createReverseLogistics(
  params: ReverseLogisticsParams,
  config: CorreiosConfig = DEFAULT_CONFIG
): Promise<ReverseLogisticsResult> {
  try {
    const token = await getCorreiosToken(config);

    const cleanCepRemetente = (params.client.cep || "").replace(/\D/g, "").padStart(8, "0");
    const cleanPhone = (params.client.telefone || "").replace(/\D/g, "");
    const ddd = cleanPhone.length >= 10 ? cleanPhone.slice(-11, -9) : "47";
    const phoneNum = cleanPhone.length >= 8 ? cleanPhone.slice(-9) : cleanPhone;

    // Format items for declaration of contents
    const itensDeclaracao = (params.items && params.items.length > 0)
      ? params.items.map((item) => ({
          conteudo: item.name.substring(0, 50),
          quantidade: Math.max(1, item.quantity || 1),
          valor: item.value || 50.0,
        }))
      : [
          {
            conteudo: "Pecas de Lingerie / Vestuario para Troca",
            quantidade: 1,
            valor: 50.0,
          },
        ];

    const days = params.daysValid || 15;
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + days);
    const validUntilIso = expirationDate.toISOString().split("T")[0];

    const payload = {
      codigoServico: params.serviceCode || "04669", // PAC Reverso
      numeroCartaoPostagem: config.cartaoPostagem,
      logisticaReversa: "S",
      pesoInformado: String(params.weightGrams || 300),
      prazoPostagem: days,
      dataValidadeLogReversa: validUntilIso,
      pedidoExternoOrigem: String(params.orderNumber),
      remetente: {
        nome: params.client.nome.substring(0, 50),
        cpfCnpj: params.client.cpfCnpj ? params.client.cpfCnpj.replace(/\D/g, "") : undefined,
        email: params.client.email || undefined,
        dddCelular: ddd,
        celular: phoneNum,
        endereco: {
          logradouro: (params.client.logradouro || "Rua").substring(0, 50),
          numero: (params.client.numero || "S/N").substring(0, 6),
          complemento: (params.client.complemento || "").substring(0, 30),
          bairro: (params.client.bairro || "Centro").substring(0, 30),
          cidade: (params.client.cidade || "").substring(0, 30),
          uf: (params.client.uf || "SC").toUpperCase().substring(0, 2),
          cep: cleanCepRemetente,
        },
      },
      destinatario: DLY_RECIPIENT,
      itensDeclaracaoConteudo: itensDeclaracao,
    };

    const res = await fetch("https://api.correios.com.br/prepostagem/v1/prepostagens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      const errMsg = errJson.msg || errJson.msgs?.join(", ") || `Erro HTTP ${res.status} dos Correios`;
      return { success: false, error: errMsg };
    }

    const data = await res.json();
    return {
      success: true,
      trackingCode: data.codigoObjeto || data.numeroEtiqueta || null,
      eTicket: data.id || data.idAtendimento || data.codigoObjeto || null,
      validUntil: validUntilIso,
    };
  } catch (err: any) {
    console.error("[Correios] Erro ao criar logística reversa:", err);
    return { success: false, error: err.message || "Erro inesperado ao conectar aos Correios" };
  }
}
