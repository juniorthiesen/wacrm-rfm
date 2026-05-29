// Types for the Mensurar (Meta Ads Attribution) module

export interface MetaAdsConfig {
  id: string
  user_id: string
  access_token: string
  ad_account_id: string
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

// Raw row from ad_campaigns_cache
export interface CampaignCacheRow {
  campaign_id: string
  campaign_name: string
  adset_id: string
  adset_name: string
  date: string
  spend: number
  impressions: number
  clicks: number
  reach: number
}

// Raw row from ad_attributions joined with contacts/deals
export interface AttributionRow {
  id: string
  contact_id: string
  contact_name: string | null
  contact_phone: string
  deal_id: string | null
  deal_title: string | null
  deal_value: number | null
  campaign_id: string
  campaign_name: string
  adset_id: string | null
  adset_name: string | null
  source: 'manual' | 'ctwa'
  attributed_at: string
}

// Aggregated KPIs for the summary cards
export interface AttributionKPIs {
  totalLeads: number
  totalSpend: number
  avgCPL: number
  estimatedROAS: number
  totalRevenue: number
  totalConversions: number
}

// One row in the campaigns breakdown table
export interface CampaignBreakdownRow {
  campaign_id: string
  campaign_name: string
  adset_id: string
  adset_name: string
  leads: number
  conversions: number   // leads with a linked deal
  spend: number
  cpl: number           // spend / leads
  revenue: number       // sum of deal values for linked deals
  roas: number          // revenue / spend
  impressions: number
  clicks: number
  ctr: number           // clicks / impressions
  cpc: number           // spend / clicks
}

// One point in the leads-over-time chart
export interface LeadsTimelinePoint {
  date: string          // 'YYYY-MM-DD'
  leads: number
  campaign_name: string
}

// Payload returned by the Meta sync API route
export interface MetaSyncResult {
  synced: number
  errors: string[]
  last_synced_at: string
}

// Option item for campaign picker in the attribution modal
export interface CampaignOption {
  campaign_id: string
  campaign_name: string
  adset_id: string
  adset_name: string
}
