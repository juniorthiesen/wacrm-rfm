/**
 * Finds the PIX "copia e cola" code (EMV) in a WooCommerce order's meta_data.
 *
 * Each PIX gateway stores it differently, so we probe in priority order.
 *
 * Flat keys (the value is the code itself):
 *   - pix_copiar_colar              generic / theme-installed
 *   - _dados_cielo_api_pix_qrcode   Cielo official plugin
 *   - _pix_copy_and_paste           Loja5 theme
 *   - woo_pix_code                  Pix for WooCommerce free plugin
 *   - efi_pix_copy_and_paste        Efí (formerly Gerencianet)
 *
 * Nested (the value is a structure that holds the code):
 *   - wc_paghiper_data              PagHiper: { ..., emv: "000201...", qrcode_image_url, pix_url }
 *     The store switched from Cielo to PagHiper around 11/11/2026 and the PIX
 *     reminder silently stopped, because this key was not read.
 *
 * The REST API returns a PHP-serialized array either already decoded (an
 * object), as JSON text, or as the raw serialized string; all three are handled.
 */

const FLAT_KEYS = [
  "pix_copiar_colar",
  "_dados_cielo_api_pix_qrcode",
  "_pix_copy_and_paste",
  "woo_pix_code",
  "efi_pix_copy_and_paste",
] as const;

const NESTED: ReadonlyArray<{ key: string; field: string }> = [{ key: "wc_paghiper_data", field: "emv" }];

interface MetaItem {
  key?: string;
  value?: unknown;
}

/** A PIX copia-e-cola payload is an EMV string that starts with the payload format indicator "000201". */
function looksLikeEmv(s: string): boolean {
  return /^000201[0-9A-Za-z .\-_@/:+*]{20,}$/.test(s.trim());
}

function fromNestedValue(value: unknown, field: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = (value as Record<string, unknown>)[field];
    return typeof v === "string" ? v.trim() : "";
  }
  if (typeof value !== "string" || !value) return "";

  // JSON text
  if (value.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const v = parsed?.[field];
      if (typeof v === "string") return v.trim();
    } catch {
      /* fall through to the serialized form */
    }
  }
  // PHP-serialized: s:3:"emv";s:166:"000201...";
  const m = new RegExp(`s:${field.length}:"${field}";s:\\d+:"([^"]+)";`).exec(value);
  return m ? m[1].trim() : "";
}

export function extractPixCode(metaData: unknown): string {
  if (!Array.isArray(metaData)) return "";
  const items = metaData as MetaItem[];

  for (const key of FLAT_KEYS) {
    for (const it of items) {
      if (it?.key !== key || it.value == null) continue;
      const s = typeof it.value === "string" ? it.value : String(it.value);
      if (s.trim()) return s;
    }
  }

  for (const { key, field } of NESTED) {
    for (const it of items) {
      if (it?.key !== key) continue;
      const code = fromNestedValue(it.value, field);
      // The nested path is only trusted when it really is an EMV payload.
      if (code && looksLikeEmv(code)) return code;
    }
  }
  return "";
}
