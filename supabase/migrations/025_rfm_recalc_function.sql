-- ============================================================
-- 025: Push RFM recalculation into Postgres
--
-- Why:
--   The TS engine (lib/rfm/engine.ts) read every order with a plain
--   PostgREST select, which caps at 1000 rows — so stores with years
--   of history only ever scored their first 1000 orders ("RFM pulling
--   only a few days"). Loading 60k+ orders into the Vercel function to
--   fix that would blow the memory/time budget instead.
--
--   This function does the whole thing set-based in the database:
--   aggregate orders per contact, assign 1-5 quintile scores with
--   ntile(), derive the segment, and upsert contact_rfm_metrics. One
--   query, no row cap, no app-side memory.
--
-- The score/segment math mirrors lib/rfm/engine.ts exactly so the two
-- stay interchangeable (getSegment() there is still the unit-tested
-- source of truth; keep this CASE in sync if it changes):
--   - Recency: fewer days = better → score 5. (6 - ntile asc)
--   - Frequency / Monetary: higher = better → score 5. (ntile asc)
-- Only 'completed' and 'processing' orders count (paid revenue);
-- cancelled/refunded/pending are excluded, same as before.
-- ============================================================

-- Partial index so the per-tenant aggregation stays an index scan even
-- with hundreds of thousands of historical orders.
CREATE INDEX IF NOT EXISTS idx_orders_rfm_scan
  ON orders (user_id, contact_id)
  WHERE contact_id IS NOT NULL AND status IN ('completed', 'processing');

CREATE OR REPLACE FUNCTION recalculate_user_rfm(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Authenticated callers may only recalc their own tenant. Service-
  -- role callers (the webhook, sync, manual recalc route) have a NULL
  -- auth.uid() and bypass this — they already verified the user.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  WITH agg AS (
    SELECT
      contact_id,
      COUNT(*)::int AS frequency_count,
      COALESCE(SUM(total_amount), 0) AS monetary_value,
      GREATEST(
        0,
        FLOOR(EXTRACT(EPOCH FROM (now() - MAX(ordered_at))) / 86400)
      )::int AS recency_days
    FROM orders
    WHERE user_id = p_user_id
      AND contact_id IS NOT NULL
      AND status IN ('completed', 'processing')
    GROUP BY contact_id
  ),
  scored AS (
    SELECT
      contact_id,
      frequency_count,
      monetary_value,
      recency_days,
      -- fewer days is better, so invert the ntile (tile 1 = newest → 5)
      (6 - ntile(5) OVER (ORDER BY recency_days ASC))::int AS r,
      ntile(5) OVER (ORDER BY frequency_count ASC)::int AS f,
      ntile(5) OVER (ORDER BY monetary_value ASC)::int AS m
    FROM agg
  ),
  upserted AS (
    INSERT INTO contact_rfm_metrics (
      contact_id, user_id, recency_days, frequency_count, monetary_value,
      recency_score, frequency_score, monetary_score, rfm_score, segment,
      last_calculated_at
    )
    SELECT
      contact_id,
      p_user_id,
      recency_days,
      frequency_count,
      monetary_value,
      r,
      f,
      m,
      r::text || f::text || m::text,
      CASE
        WHEN r >= 4 AND (f + m) / 2.0 >= 4.5 THEN 'champion'
        WHEN r >= 3 AND (f + m) / 2.0 >= 3.5 THEN 'loyal'
        WHEN r >= 4 AND f <= 1 THEN 'new_customer'
        WHEN r <= 2 AND (f + m) / 2.0 >= 3.5 THEN 'in_risk'
        WHEN r = 3 AND (f + m) / 2.0 >= 1.5 AND (f + m) / 2.0 < 3.5 THEN 'about_to_sleep'
        WHEN r <= 2 AND (f + m) / 2.0 >= 1.5 AND (f + m) / 2.0 < 3.5 THEN 'hibernating'
        ELSE 'lost'
      END,
      now()
    FROM scored
    ON CONFLICT (contact_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      recency_days = EXCLUDED.recency_days,
      frequency_count = EXCLUDED.frequency_count,
      monetary_value = EXCLUDED.monetary_value,
      recency_score = EXCLUDED.recency_score,
      frequency_score = EXCLUDED.frequency_score,
      monetary_score = EXCLUDED.monetary_score,
      rfm_score = EXCLUDED.rfm_score,
      segment = EXCLUDED.segment,
      last_calculated_at = EXCLUDED.last_calculated_at
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_count FROM upserted;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION recalculate_user_rfm(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recalculate_user_rfm(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION recalculate_user_rfm(UUID) IS
  'Set-based RFM recalculation for one tenant: aggregates completed/processing orders per contact, assigns 1-5 quintile scores, derives the segment, and upserts contact_rfm_metrics. Mirrors lib/rfm/engine.ts. No row cap — handles full order history.';
