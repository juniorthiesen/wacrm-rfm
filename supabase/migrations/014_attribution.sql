-- ============================================================
-- Migration 014: Meta Ads Attribution
-- Adds tables for:
--   1. meta_ads_config    — stores the user's Meta Ads token + account ID
--   2. ad_campaigns_cache — local cache of Meta Marketing API Insights data
--   3. ad_attributions    — links contacts/deals to specific campaigns
-- ============================================================

-- ============================================================
-- META_ADS_CONFIG
-- Stores the System User Token and Ad Account ID per user.
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_ads_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,      -- e.g. "act_123456789"
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

ALTER TABLE meta_ads_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own meta ads config" ON meta_ads_config;
CREATE POLICY "Users can manage own meta ads config"
  ON meta_ads_config FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON meta_ads_config;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON meta_ads_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- AD_CAMPAIGNS_CACHE
-- Local cache of data fetched from the Meta Marketing API.
-- Rows are upserted during sync; one row = one (campaign, adset, date) combo.
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_campaigns_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  adset_id TEXT NOT NULL,
  adset_name TEXT NOT NULL,
  date DATE NOT NULL,                 -- the date_start reported by Meta
  spend NUMERIC(12, 2) DEFAULT 0,     -- BRL or account currency
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, campaign_id, adset_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_cache_user_date
  ON ad_campaigns_cache(user_id, date DESC);

ALTER TABLE ad_campaigns_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own campaign cache" ON ad_campaigns_cache;
CREATE POLICY "Users can manage own campaign cache"
  ON ad_campaigns_cache FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON ad_campaigns_cache;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ad_campaigns_cache
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- AD_ATTRIBUTIONS
-- Links a contact (and optionally a deal) to a Meta Ads campaign.
-- Source can be 'manual' (user attributed it in the UI) or
-- 'ctwa' (click-to-WhatsApp — future automatic attribution).
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_attributions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  adset_id TEXT,
  adset_name TEXT,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'ctwa')),
  attributed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- One attribution per contact (a contact comes from one ad source)
  UNIQUE(user_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_ad_attributions_user_date
  ON ad_attributions(user_id, attributed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_attributions_contact
  ON ad_attributions(contact_id);
CREATE INDEX IF NOT EXISTS idx_ad_attributions_campaign
  ON ad_attributions(user_id, campaign_id);

ALTER TABLE ad_attributions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own attributions" ON ad_attributions;
CREATE POLICY "Users can manage own attributions"
  ON ad_attributions FOR ALL USING (auth.uid() = user_id);
