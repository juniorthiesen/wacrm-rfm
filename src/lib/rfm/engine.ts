import type { SupabaseClient } from "@supabase/supabase-js";

export type RFMSegment =
  | "champion"
  | "loyal"
  | "new_customer"
  | "about_to_sleep"
  | "in_risk"
  | "hibernating"
  | "lost"
  | "new_lead";

/**
 * Determines the customer segment based on R, F, M scores (each 1-5).
 */
export function getSegment(r: number, f: number, m: number): RFMSegment {
  const avgFM = (f + m) / 2;

  if (r >= 4 && avgFM >= 4.5) return "champion";
  if (r >= 3 && avgFM >= 3.5) return "loyal";
  if (r >= 4 && f <= 1) return "new_customer";
  if (r <= 2 && avgFM >= 3.5) return "in_risk";
  if (r === 3 && avgFM >= 1.5 && avgFM < 3.5) return "about_to_sleep";
  if (r <= 2 && avgFM >= 1.5 && avgFM < 3.5) return "hibernating";
  return "lost";
}

interface CustomerRawMetrics {
  contact_id: string;
  recency_days: number;
  frequency_count: number;
  monetary_value: number;
}

/**
 * Recalculates the RFM scores and segments for all contacts of a given user (tenant).
 * Uses statistical quintiles (percentiles) of the customer base.
 */
export async function recalculateUserRFM(
  supabase: SupabaseClient,
  userId: string
): Promise<{ success: boolean; updatedCount: number }> {
  try {
    // 1. Fetch completed/processing orders grouped by contact_id
    // Only count active orders (exclude cancelled/refunded for RFM metrics)
    const { data: dbOrders, error: ordersError } = await supabase
      .from("orders")
      .select("contact_id, total_amount, ordered_at")
      .eq("user_id", userId)
      .not("contact_id", "is", null)
      .in("status", ["completed", "processing"]);

    if (ordersError) throw ordersError;
    if (!dbOrders || dbOrders.length === 0) {
      return { success: true, updatedCount: 0 };
    }

    // 2. Aggregate raw metrics per customer
    const now = new Date();
    const customerMap = new Map<string, { lastOrderDate: Date; orderCount: number; totalSpend: number }>();

    for (const order of dbOrders) {
      const contactId = order.contact_id as string;
      const amount = parseFloat(order.total_amount || 0);
      const orderDate = new Date(order.ordered_at);

      const existing = customerMap.get(contactId);
      if (!existing) {
        customerMap.set(contactId, {
          lastOrderDate: orderDate,
          orderCount: 1,
          totalSpend: amount,
        });
      } else {
        existing.orderCount += 1;
        existing.totalSpend += amount;
        if (orderDate > existing.lastOrderDate) {
          existing.lastOrderDate = orderDate;
        }
      }
    }

    const customers: CustomerRawMetrics[] = [];
    customerMap.forEach((val, contactId) => {
      const diffMs = now.getTime() - val.lastOrderDate.getTime();
      const recencyDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      customers.push({
        contact_id: contactId,
        recency_days: recencyDays,
        frequency_count: val.orderCount,
        monetary_value: val.totalSpend,
      });
    });

    const totalCustomers = customers.length;
    if (totalCustomers === 0) {
      return { success: true, updatedCount: 0 };
    }

    // Helper to calculate score (1-5) based on sorted index (quintiles)
    // For Recency: lower is better (index 0 is smallest days -> gets 5)
    // For Frequency & Monetary: higher is better (index 0 is smallest -> gets 1)
    const assignScores = (
      sortedList: { contact_id: string; value: number }[],
      ascendingBetter: boolean
    ): Map<string, number> => {
      const scoreMap = new Map<string, number>();
      sortedList.forEach((item, index) => {
        // Calculate percentile position (0 to 1)
        const rank = index / totalCustomers;
        let score = 1;
        if (rank < 0.2) score = ascendingBetter ? 1 : 5;
        else if (rank < 0.4) score = ascendingBetter ? 2 : 4;
        else if (rank < 0.6) score = ascendingBetter ? 3 : 3;
        else if (rank < 0.8) score = ascendingBetter ? 4 : 2;
        else score = ascendingBetter ? 5 : 1;

        scoreMap.set(item.contact_id, score);
      });
      return scoreMap;
    };

    // Sort and calculate scores
    const rList = [...customers]
      .sort((a, b) => a.recency_days - b.recency_days) // Ascending (lower days first)
      .map((c) => ({ contact_id: c.contact_id, value: c.recency_days }));
    const rScores = assignScores(rList, false); // lower is better

    const fList = [...customers]
      .sort((a, b) => a.frequency_count - b.frequency_count) // Ascending (higher count last)
      .map((c) => ({ contact_id: c.contact_id, value: c.frequency_count }));
    const fScores = assignScores(fList, true); // higher is better

    const mList = [...customers]
      .sort((a, b) => a.monetary_value - b.monetary_value) // Ascending (higher spend last)
      .map((c) => ({ contact_id: c.contact_id, value: c.monetary_value }));
    const mScores = assignScores(mList, true); // higher is better

    // 3. Prepare batch upsert objects
    const rfmUpdates = customers.map((c) => {
      const r = rScores.get(c.contact_id) || 1;
      const f = fScores.get(c.contact_id) || 1;
      const m = mScores.get(c.contact_id) || 1;
      const segment = getSegment(r, f, m);

      return {
        contact_id: c.contact_id,
        user_id: userId,
        recency_days: c.recency_days,
        frequency_count: c.frequency_count,
        monetary_value: c.monetary_value,
        recency_score: r,
        frequency_score: f,
        monetary_score: m,
        rfm_score: `${r}${f}${m}`,
        segment,
        last_calculated_at: new Date().toISOString(),
      };
    });

    // 4. Batch upsert into contact_rfm_metrics
    const { error: upsertError } = await supabase
      .from("contact_rfm_metrics")
      .upsert(rfmUpdates, { onConflict: "contact_id" });

    if (upsertError) throw upsertError;

    return { success: true, updatedCount: rfmUpdates.length };
  } catch (error) {
    console.error("[RFM ENGINE ERROR]:", error);
    return { success: false, updatedCount: 0 };
  }
}
