// ============================================================
// Birthday extraction + parsing
//
// Birthdays arrive from the WooCommerce checkout, where different
// plugins/themes store the date under different keys (billing field or
// meta_data entry) and in different formats (ISO, pt-BR day-first, or
// day/month with no year). This module turns whatever the store sends
// into a canonical YYYY-MM-DD we persist on contacts.birthday.
//
// Only month + day are ever used for matching (see the birthday cron);
// the year is kept when known and a leap-safe placeholder otherwise.
// ============================================================

// Year stamped when the source only gives day/month. 1904 is a leap year
// so "29/02" stays a valid date. Never used for matching.
const PLACEHOLDER_YEAR = 1904;

// Candidate billing.<key> fields, in priority order.
const BIRTHDAY_BILLING_KEYS = [
  "birthdate",
  "birth_date",
  "data_nascimento",
  "nascimento",
  "aniversario",
  "dob",
] as const;

// Candidate meta_data keys (each entry is { key, value }). Brazilian
// checkout plugins prefix with billing_/_billing_; we probe both. If your
// store uses a different key, add it here.
const BIRTHDAY_META_KEYS = [
  "_billing_birthdate",
  "billing_birthdate",
  "_billing_data_nascimento",
  "billing_data_nascimento",
  "data_nascimento",
  "_data_nascimento",
  "birth_date",
  "_birth_date",
  "aniversario",
  "_aniversario",
  "nascimento",
  "_nascimento",
  "dob",
  "_dob",
] as const;

interface MetaItem {
  key?: string;
  value?: unknown;
}

/**
 * Pull the raw birthday string out of a WooCommerce billing object and/or
 * its meta_data array. Returns the first non-empty match, or null.
 *
 * meta_data is scanned FIRST, on purpose. On the real DLY store the
 * structured `billing.birthdate` field is US-formatted MM-DD-YYYY with a
 * time suffix ("12-18-1981T00:00:00"), which is ambiguous against the
 * pt-BR DD-MM order parseBirthday expects — it would yield the wrong day
 * (or null when the day is > 12). The accompanying meta key
 * `_billing_birthdate` carries the same date as clean DD/MM/YYYY
 * ("18/12/1981"), so preferring it gives the correct date. The billing
 * fields stay as a fallback for stores that only expose an ISO date there.
 */
export function extractBirthdayRaw(
  billing: unknown,
  metaData: unknown,
): string | null {
  if (Array.isArray(metaData)) {
    const lookup = new Set<string>(BIRTHDAY_META_KEYS);
    for (const entry of metaData as MetaItem[]) {
      if (!entry?.key || !lookup.has(entry.key)) continue;
      const v = entry.value;
      if (v != null && String(v).trim()) return String(v);
    }
  }

  if (billing && typeof billing === "object") {
    const b = billing as Record<string, unknown>;
    for (const k of BIRTHDAY_BILLING_KEYS) {
      const v = b[k];
      if (v != null && String(v).trim()) return String(v);
    }
  }

  return null;
}

/**
 * Normalize a raw birthday string to canonical YYYY-MM-DD, or null when
 * it can't be understood. Accepts:
 *   - ISO-ish    "1990-05-14" / "1990/05/14" / "1990-05-14T00:00:00"
 *   - pt-BR      "14/05/1990" / "14-05-1990"  (day-first)
 *   - no year    "14/05" / "14-05"            (stamped with a placeholder)
 */
export function parseBirthday(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // ISO-ish: 4-digit year first.
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

  // Day-first with year.
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return build(Number(m[3]), Number(m[2]), Number(m[1]));

  // Day/month, no year.
  m = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (m) return build(PLACEHOLDER_YEAR, Number(m[2]), Number(m[1]));

  return null;
}

function build(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip through a real date to reject impossible combos (e.g. 31/02).
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}
