/**
 * Phone number normalization helper for WACRM e-commerce integrations.
 *
 * Normalizes messy customer phone inputs from e-commerce platforms (like WooCommerce)
 * into the standard E.164-like clean digit format required by the WhatsApp Business API.
 */
export function normalizePhone(rawPhone: string | null | undefined): string | null {
  if (!rawPhone) return null;

  const hasPlus = rawPhone.trim().startsWith("+");

  // 1. Remove all non-digit characters
  let cleaned = rawPhone.replace(/\D/g, "");

  // 2. Remove leading "00" or single "0" (often used in Brazil as carrier prefix, e.g., 051999998888)
  if (cleaned.startsWith("00")) {
    cleaned = cleaned.substring(2);
  } else if (cleaned.startsWith("0")) {
    cleaned = cleaned.substring(1);
  }

  // If empty after stripping, return null
  if (!cleaned) return null;

  // 3. Handle Brazil (55) specific formats if country code is missing.
  // Standard Brazilian numbers (area code + number):
  // - Mobile: 11 digits (e.g. 51988887777 -> area code 51 + 9 + 8 digits)
  // - Landline: 10 digits (e.g. 5133334444 -> area code 51 + 8 digits)
  // If the number is 10 or 11 digits, and did not have a leading '+', we assume it's Brazilian and lacks the country code.
  if (!hasPlus && (cleaned.length === 10 || cleaned.length === 11)) {
    cleaned = "55" + cleaned;
  }

  // 4. Sometimes Brazilian numbers with country code are 12 digits (without 9) or 13 digits (with 9).
  return cleaned;
}
