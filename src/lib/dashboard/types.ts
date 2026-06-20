// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface RepurchaseWindow {
  /** Window length in days (30 / 60 / 90). */
  days: number
  /** Customers whose first paid order is at least `days` old. */
  eligible: number
  /** Of the eligible, how many placed a 2nd order within the window. */
  repurchased: number
  /** repurchased / eligible * 100, rounded to 1 decimal. */
  rate: number
}

export interface RepurchaseMetrics {
  /** Distinct customers with >=1 paid order. */
  total_customers: number
  /** Paid orders across all those customers. */
  total_orders: number
  /** Sum of paid order totals (lifetime GMV). */
  total_revenue: number
  /** Customers with >=2 paid orders. */
  repeat_customers: number
  /** repeat_customers / total_customers * 100 — the north-star KPI. */
  repeat_rate: number
  avg_orders_per_customer: number
  avg_ticket: number
  /** The repurchase ladder: exactly-1, exactly-2, and 3+ (VIP) buyers. */
  funnel: { one: number; two: number; three_plus: number }
  /** to_2nd mirrors repeat_rate; to_3rd = % of 2x+ who reached a 3rd. */
  conversion: { to_2nd: number; to_3rd: number }
  windows: RepurchaseWindow[]
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
  meta?: {
    who?: string
    title?: string
    stage?: string
    name?: string
    count?: number
    status?: string
  }
}
