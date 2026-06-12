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

/**
 * Recalculates the RFM scores and segments for all contacts of a given
 * user (tenant).
 *
 * Delegates to the `recalculate_user_rfm` Postgres function (migration
 * 025): aggregation, quintile scoring, segment derivation and the
 * upsert all run set-based in the database. This replaced an in-app
 * implementation that read orders through PostgREST and silently
 * capped at 1000 rows — under-counting any store with real history.
 * The SQL mirrors getSegment() above; keep them in sync.
 */
export async function recalculateUserRFM(
  supabase: SupabaseClient,
  userId: string
): Promise<{ success: boolean; updatedCount: number }> {
  const { data, error } = await supabase.rpc("recalculate_user_rfm", {
    p_user_id: userId,
  });

  if (error) {
    console.error("[RFM ENGINE ERROR]:", error);
    return { success: false, updatedCount: 0 };
  }

  return { success: true, updatedCount: typeof data === "number" ? data : 0 };
}
