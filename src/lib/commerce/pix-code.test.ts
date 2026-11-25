import { describe, expect, it } from "vitest";
import { extractPixCode } from "./pix-code";

// Synthetic EMV-shaped strings (not real payment codes).
const EMV = "00020126580014br.gov.bcb.pix0136aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee5204000053039865802BR5909DLY TESTE6009SAO PAULO62070503***6304ABCD";

describe("extractPixCode", () => {
  it("reads the PagHiper code from a decoded wc_paghiper_data object (REST payload)", () => {
    const meta = [
      { key: "_payment_method", value: "paghiper_pix" },
      { key: "wc_paghiper_data", value: { transaction_id: "X1", emv: EMV, pix_url: "https://x" } },
    ];
    expect(extractPixCode(meta)).toBe(EMV);
  });

  it("reads it from JSON text and from the raw PHP-serialized string", () => {
    expect(extractPixCode([{ key: "wc_paghiper_data", value: JSON.stringify({ emv: EMV }) }])).toBe(EMV);
    const serialized = `a:2:{s:3:"emv";s:${EMV.length}:"${EMV}";s:6:"status";s:7:"pending";}`;
    expect(extractPixCode([{ key: "wc_paghiper_data", value: serialized }])).toBe(EMV);
  });

  it("keeps the flat keys of the other gateways working, and they win over PagHiper", () => {
    expect(extractPixCode([{ key: "_dados_cielo_api_pix_qrcode", value: "cielo-code" }])).toBe("cielo-code");
    expect(
      extractPixCode([
        { key: "wc_paghiper_data", value: { emv: EMV } },
        { key: "woo_pix_code", value: "free-plugin-code" },
      ]),
    ).toBe("free-plugin-code");
  });

  it("ignores a PagHiper value that is not an EMV payload (boleto, blank, junk)", () => {
    expect(extractPixCode([{ key: "wc_paghiper_data", value: { emv: "" } }])).toBe("");
    expect(extractPixCode([{ key: "wc_paghiper_data", value: { emv: "https://boleto.example/123" } }])).toBe("");
    expect(extractPixCode([{ key: "wc_paghiper_data", value: { barcode: "34191.79001" } }])).toBe("");
    expect(extractPixCode([{ key: "wc_paghiper_data", value: "garbage" }])).toBe("");
  });

  it("returns an empty string for missing or malformed meta_data", () => {
    expect(extractPixCode(undefined)).toBe("");
    expect(extractPixCode(null)).toBe("");
    expect(extractPixCode("x")).toBe("");
    expect(extractPixCode([])).toBe("");
    expect(extractPixCode([null, {}, { key: "other", value: "1" }])).toBe("");
  });
});
