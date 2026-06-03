-- ============================================================
-- Migration 016: Cache line items on orders
-- ============================================================
-- The webhook used to throw away `payload.line_items` after building the
-- automation `items_list` variable. The inbox contact sidebar needs to
-- show purchased products, so we now persist a small normalized shape:
--
--   [{ name: string, quantity: number, total: number | null,
--      product_id: number | string | null }, ...]
--
-- Kept as a JSONB column rather than a child table because line items
-- are only ever read alongside their order — never queried in isolation.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS line_items JSONB NOT NULL DEFAULT '[]'::jsonb;
