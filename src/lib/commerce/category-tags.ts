import type { NormalizedLineItem } from "./types";

// ============================================================
// Purchase-category tagging
//
// Bridges order line items → contact tags so cross-sell campaigns can
// target "everyone who bought a Sutiã" from the broadcast tag picker —
// the same mechanism RFM segments use (see migration 029 sync_rfm_tags).
//
// A product can belong to MORE THAN ONE category, by design: a
// "Kit 3 Calcinhas" is both a Kit and a Calcinha, and the DLY cross-sell
// rules key off each independently ("comprou calcinha → oferece sutiã",
// "comprou kit → oferece kit de maior ticket"). Derivation therefore
// returns the UNION of categories across an order's items.
//
// Matching runs on the product NAME (the only human-readable field the
// normalized line item carries — SKU codes like N401 are not present),
// accent-stripped and lowercased. Each category is a word-stem regex so
// plurals match ("calcinha" ⊇ "calcinhas") while mid-word collisions do
// not — notably `plus` is bounded (\bplus\b) so "Robe Plush" is NOT
// tagged Plus Size.
//
// Taxonomy is lingerie-specific because the deployment is (DLY). Adding a
// category is a one-line edit here; nothing downstream needs to change.
// ============================================================

export interface CategoryTagDef {
  /** Stable, accent-free key. Used in code/tests, never shown to users. */
  key: string;
  /** Tag name as it appears in the broadcast audience picker. */
  label: string;
  /** Tag color (hex), matched to the RFM-tag visual language. */
  color: string;
  /** Tested against the accent-stripped, lowercased product name. */
  pattern: RegExp;
}

// Order here is the picker display order and the order deriveCategories
// returns matches in.
export const CATEGORY_TAGS: readonly CategoryTagDef[] = [
  { key: "sutia", label: "🛍️ Sutiã", color: "#ec4899", pattern: /\bsutia/ },
  { key: "calcinha", label: "🛍️ Calcinha", color: "#f472b6", pattern: /\bcalcinha/ },
  { key: "conjunto", label: "🛍️ Conjunto", color: "#a855f7", pattern: /\bconjunto/ },
  { key: "robe", label: "🛍️ Robe", color: "#8b5cf6", pattern: /\b(robe|roupao)/ },
  { key: "pijama", label: "🛍️ Pijama", color: "#6366f1", pattern: /\bpijama/ },
  { key: "kit", label: "🛍️ Kit", color: "#14b8a6", pattern: /\bkit/ },
  { key: "plus", label: "🛍️ Plus Size", color: "#f59e0b", pattern: /\bplus\b/ },
] as const;

/** Lowercase + strip diacritics so "Sutiã" and "sutia" match alike. */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Categories present in an order's line items. Pure and
 * order-independent: the result preserves CATEGORY_TAGS order regardless
 * of item order, and de-duplicates. Empty when nothing matches.
 */
export function deriveCategories(
  items: NormalizedLineItem[],
): CategoryTagDef[] {
  const matched = new Set<string>();
  for (const item of items) {
    const name = normalize(item.name ?? "");
    if (!name) continue;
    for (const cat of CATEGORY_TAGS) {
      if (cat.pattern.test(name)) matched.add(cat.key);
    }
  }
  return CATEGORY_TAGS.filter((c) => matched.has(c.key));
}
