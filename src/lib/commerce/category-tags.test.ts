import { describe, it, expect } from "vitest";
import { deriveCategories } from "./category-tags";
import type { NormalizedLineItem } from "./types";

// Helper: build a minimal line item; only `name` drives categorization.
function item(name: string): NormalizedLineItem {
  return { name, quantity: 1, total: null, product_id: null };
}

function keys(names: string[]): string[] {
  return deriveCategories(names.map(item)).map((c) => c.key);
}

describe("deriveCategories", () => {
  it("tags a single sutiã (accent-insensitive)", () => {
    expect(keys(["Sutiã Anatômico Base Dupla N401"])).toEqual(["sutia"]);
  });

  it("tags a kit of calcinhas as BOTH calcinha and kit", () => {
    // Order follows CATEGORY_TAGS (calcinha before kit), not item text.
    expect(keys(["Kit 3 Calcinhas Fio Duplo"])).toEqual(["calcinha", "kit"]);
  });

  it("tags a kit of sutiãs as sutia + kit", () => {
    expect(keys(["Kit 3 Sutiãs Anatômicos"])).toEqual(["sutia", "kit"]);
  });

  it("tags conjunto and robe", () => {
    expect(keys(["Conjunto Rendado"])).toEqual(["conjunto"]);
    expect(keys(["Robe Plus Renda"])).toEqual(["robe", "plus"]);
  });

  it("detects plus size when present as a word", () => {
    expect(keys(["Sutiã Plus Size em Microfibra"])).toEqual(["sutia", "plus"]);
    expect(keys(["Kit Calcinhas Plus"])).toEqual(["calcinha", "kit", "plus"]);
  });

  it("does NOT mistake 'plush' for plus size (\\bplus\\b boundary)", () => {
    expect(keys(["Robe Plush Felpudo"])).toEqual(["robe"]);
  });

  it("unions categories across multiple items, de-duplicated", () => {
    expect(
      keys(["Sutiã Meia Taça N404", "Kit 2 Conjuntos Rendados", "Calcinha Fio"]),
    ).toEqual(["sutia", "calcinha", "conjunto", "kit"]);
  });

  it("matches plurals via word-stem (calcinhas, sutiãs, kits)", () => {
    expect(keys(["Kits Sortidos de Calcinhas"])).toEqual(["calcinha", "kit"]);
  });

  it("returns empty for unrelated or blank names", () => {
    expect(keys(["Frete", "Brinde Surpresa", ""])).toEqual([]);
    expect(deriveCategories([])).toEqual([]);
  });

  it("exposes label + color for tag creation", () => {
    const [cat] = deriveCategories([item("Sutiã N407")]);
    expect(cat.label).toBe("🛍️ Sutiã");
    expect(cat.color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
