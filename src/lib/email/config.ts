import type { EmailBrand, EmailConfig } from "./types";

/**
 * Validation + shaping of the e-mail channel settings (email_config).
 * Pure, so the API route stays thin and the rules are unit-tested.
 * The API key / webhook secret are write-only: they are encrypted by the
 * route and never sent back to the browser (only `has_*` flags).
 */

export interface EmailConfigInput {
  /** Plain Resend API key; absent = keep the stored one. */
  api_key?: string;
  /** Plain Svix signing secret ("whsec_..."); absent = keep the stored one. */
  webhook_secret?: string;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  daily_limit: number;
  marketing_min_gap_days: number;
  brand: EmailBrand;
  is_active: boolean;
}

export type PublicEmailConfig = Omit<EmailConfig, "api_key_encrypted" | "webhook_secret_encrypted"> & {
  has_api_key: boolean;
  has_webhook_secret: boolean;
};

export const DEFAULT_DAILY_LIMIT = 150;
export const DEFAULT_MARKETING_GAP_DAYS = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const RESEND_KEY_RE = /^re_[A-Za-z0-9_-]{10,}$/;

const str = (v: unknown): string => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim() : "");

function intIn(value: unknown, fallback: number, min: number, max: number, label: string, errors: string[]): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${label} deve ser um número inteiro entre ${min} e ${max}`);
    return fallback;
  }
  return n;
}

export function parseEmailConfigInput(
  body: unknown,
  existing: { has_api_key: boolean },
): { ok: true; value: EmailConfigInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["corpo da requisição inválido"] };
  }
  const b = body as Record<string, unknown>;

  const fromEmail = str(b.from_email).toLowerCase();
  if (fromEmail && !EMAIL_RE.test(fromEmail)) errors.push("E-mail do remetente inválido");

  const replyTo = str(b.reply_to).toLowerCase();
  if (replyTo && !EMAIL_RE.test(replyTo)) errors.push("E-mail de resposta inválido");

  const fromName = str(b.from_name);
  if (fromName.length > 80) errors.push("Nome do remetente muito longo (máximo 80)");

  const apiKey = str(b.api_key);
  if (apiKey && !RESEND_KEY_RE.test(apiKey)) errors.push("Chave da API inválida (a chave do Resend começa com re_)");

  const webhookSecret = str(b.webhook_secret);
  if (webhookSecret && !webhookSecret.startsWith("whsec_")) {
    errors.push("Segredo do webhook inválido (começa com whsec_)");
  }

  const dailyLimit = intIn(b.daily_limit, DEFAULT_DAILY_LIMIT, 0, 10_000, "Limite diário", errors);
  const gapDays = intIn(b.marketing_min_gap_days, DEFAULT_MARKETING_GAP_DAYS, 0, 90, "Intervalo entre e-mails", errors);

  const rawBrand = b.brand && typeof b.brand === "object" && !Array.isArray(b.brand) ? (b.brand as Record<string, unknown>) : {};
  const brand: EmailBrand = {};
  const logo = str(rawBrand.logo_url);
  if (logo) {
    if (!/^https?:\/\//i.test(logo)) errors.push("O link da logo deve começar com http:// ou https://");
    else brand.logo_url = logo;
  }
  for (const key of ["accent", "ink"] as const) {
    const color = str(rawBrand[key]);
    if (!color) continue;
    if (!HEX_RE.test(color)) errors.push(`Cor "${key}" inválida (use o formato #087f58)`);
    else brand[key] = color;
  }
  const limits = { company_name: 60, strip_text: 80, footer_note: 300 } as const;
  for (const [key, max] of Object.entries(limits) as [keyof typeof limits, number][]) {
    const value = str(rawBrand[key]);
    if (!value) continue;
    if (value.length > max) errors.push(`"${key}" muito longo (máximo ${max})`);
    else brand[key] = value;
  }

  const isActive = b.is_active === true;
  if (isActive) {
    if (!fromEmail) errors.push("Informe o e-mail do remetente para ativar o canal");
    if (!apiKey && !existing.has_api_key) errors.push("Informe a chave da API do Resend para ativar o canal");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      ...(apiKey ? { api_key: apiKey } : {}),
      ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
      from_name: fromName,
      from_email: fromEmail,
      reply_to: replyTo || null,
      daily_limit: dailyLimit,
      marketing_min_gap_days: gapDays,
      brand,
      is_active: isActive,
    },
  };
}

export function toPublicConfig(row: EmailConfig): PublicEmailConfig {
  const { api_key_encrypted, webhook_secret_encrypted, ...rest } = row;
  return {
    ...rest,
    has_api_key: !!api_key_encrypted,
    has_webhook_secret: !!webhook_secret_encrypted,
  };
}
