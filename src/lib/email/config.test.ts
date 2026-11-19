import { describe, expect, it } from "vitest";
import { parseEmailConfigInput, toPublicConfig } from "./config";
import { makeConfig } from "./test-utils";

const none = { has_api_key: false };
const stored = { has_api_key: true };
const valid = {
  from_name: "DLY Lingerie",
  from_email: "Ecom@DLY.com.br",
  api_key: "re_abcdefghij123456",
  is_active: true,
};

describe("parseEmailConfigInput", () => {
  it("accepts a valid config, normalising e-mail case and applying defaults", () => {
    const result = parseEmailConfigInput(valid, none);
    expect(result).toEqual({
      ok: true,
      value: {
        api_key: "re_abcdefghij123456",
        from_name: "DLY Lingerie",
        from_email: "ecom@dly.com.br",
        reply_to: null,
        daily_limit: 150,
        marketing_min_gap_days: 3,
        brand: {},
        is_active: true,
      },
    });
  });

  it("keeps the stored key when none is sent, and needs one to activate", () => {
    const { api_key, ...withoutKey } = valid;
    void api_key;
    const keep = parseEmailConfigInput(withoutKey, stored);
    expect(keep.ok).toBe(true);
    if (keep.ok) expect("api_key" in keep.value).toBe(false);

    const missing = parseEmailConfigInput(withoutKey, none);
    expect(missing).toEqual({ ok: false, errors: ["Informe a chave da API do Resend para ativar o canal"] });
  });

  it("allows saving an inactive draft with almost nothing filled in", () => {
    expect(parseEmailConfigInput({ is_active: false }, none).ok).toBe(true);
  });

  it("rejects malformed addresses, keys and secrets", () => {
    const result = parseEmailConfigInput(
      { ...valid, from_email: "nope", reply_to: "also nope", api_key: "sk_live_x", webhook_secret: "abc" },
      none,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          "E-mail do remetente inválido",
          "E-mail de resposta inválido",
          "Chave da API inválida (a chave do Resend começa com re_)",
          "Segredo do webhook inválido (começa com whsec_)",
        ]),
      );
    }
  });

  it("bounds the limits", () => {
    const result = parseEmailConfigInput({ ...valid, daily_limit: -1, marketing_min_gap_days: 91 }, none);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(2);
    const ok = parseEmailConfigInput({ ...valid, daily_limit: "300", marketing_min_gap_days: 0 }, none);
    expect(ok.ok && ok.value.daily_limit).toBe(300);
    expect(ok.ok && ok.value.marketing_min_gap_days).toBe(0);
  });

  it("validates and trims the brand, dropping empty fields", () => {
    const result = parseEmailConfigInput(
      {
        ...valid,
        brand: { logo_url: "https://dly.com.br/logo.png", accent: "#087f58", ink: " ", strip_text: "kits com desconto", footer_note: "" },
      },
      none,
    );
    expect(result.ok && result.value.brand).toEqual({
      logo_url: "https://dly.com.br/logo.png",
      accent: "#087f58",
      strip_text: "kits com desconto",
    });

    const bad = parseEmailConfigInput(
      { ...valid, brand: { logo_url: "javascript:alert(1)", accent: "red;background:url(x)" } },
      none,
    );
    expect(bad.ok).toBe(false);
  });

  it("rejects non-object bodies", () => {
    expect(parseEmailConfigInput(null, none).ok).toBe(false);
    expect(parseEmailConfigInput([], none).ok).toBe(false);
  });
});

describe("toPublicConfig", () => {
  it("never exposes encrypted secrets, only presence flags", () => {
    const row = makeConfig({ api_key_encrypted: "iv:ct:tag", webhook_secret_encrypted: null });
    const pub = toPublicConfig(row);
    expect(pub).not.toHaveProperty("api_key_encrypted");
    expect(pub).not.toHaveProperty("webhook_secret_encrypted");
    expect(pub.has_api_key).toBe(true);
    expect(pub.has_webhook_secret).toBe(false);
    expect(JSON.stringify(pub)).not.toContain("iv:ct:tag");
  });
});
