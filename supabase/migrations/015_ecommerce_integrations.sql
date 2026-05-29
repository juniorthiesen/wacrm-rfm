-- ============================================================
-- Migration 015: E-commerce Integrations & RFM Analytics
-- Adds tables for:
--   1. integration_configs  — stores credentials for WooCommerce/Shopify/Nuvemshop
--   2. orders               — caches customer orders for RFM calculations
--   3. contact_rfm_metrics  — stores calculated RFM scores & segments
-- ============================================================

-- ============================================================
-- INTEGRATION_CONFIGS
-- Stores store connection metadata and credentials per platform.
-- ============================================================
CREATE TABLE IF NOT EXISTS integration_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('woocommerce', 'shopify', 'nuvemshop')),
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive')),
  store_url TEXT NOT NULL,
  credentials JSONB NOT NULL,       -- Encrypted API keys, secrets, or tokens
  webhook_secret TEXT,              -- Verification secret for webhooks
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, platform)
);

ALTER TABLE integration_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own integrations" ON integration_configs;
CREATE POLICY "Users can manage own integrations"
  ON integration_configs FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON integration_configs;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON integration_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ORDERS
-- Cached orders from integration platforms.
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  external_order_id TEXT NOT NULL,
  order_number TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('woocommerce', 'shopify', 'nuvemshop')),
  status TEXT NOT NULL,              -- completed, processing, pending, cancelled, refunded
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  customer_email TEXT,
  customer_phone TEXT,
  ordered_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, platform, external_order_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_user_contact ON orders(user_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_orders_ordered_at ON orders(ordered_at DESC);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own orders" ON orders;
CREATE POLICY "Users can manage own orders"
  ON orders FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON orders;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- CONTACT_RFM_METRICS
-- Caches RFM scores and segments per contact.
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_rfm_metrics (
  contact_id UUID PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recency_days INTEGER,
  frequency_count INTEGER DEFAULT 0,
  monetary_value NUMERIC(12, 2) DEFAULT 0,
  recency_score INTEGER CHECK (recency_score BETWEEN 1 AND 5),
  frequency_score INTEGER CHECK (frequency_score BETWEEN 1 AND 5),
  monetary_score INTEGER CHECK (monetary_score BETWEEN 1 AND 5),
  rfm_score TEXT,                   -- e.g. '553'
  segment TEXT,                     -- 'champion', 'loyal', 'about_to_sleep', 'in_risk', 'hibernating', 'lost', 'new_lead'
  last_calculated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rfm_user_segment ON contact_rfm_metrics(user_id, segment);

ALTER TABLE contact_rfm_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own RFM metrics" ON contact_rfm_metrics;
CREATE POLICY "Users can view own RFM metrics"
  ON contact_rfm_metrics FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON contact_rfm_metrics;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON contact_rfm_metrics
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
