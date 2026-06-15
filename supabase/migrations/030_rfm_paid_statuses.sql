-- ============================================================
-- 030: RFM counts all paid order statuses (incl. wc- prefix)
--
-- Why:
--   recalculate_user_rfm (migration 025) only counted status IN
--   ('completed','processing'). But this store's orders carry the
--   WooCommerce internal prefix ('wc-completed', 'wc-processing') and a
--   custom paid status 'wc-enviado' (shipped). None of those matched,
--   so the vast majority of real buyers were excluded — the RFM base
--   showed ~2k when the store had tens of thousands of paid orders.
--
--   Fix: strip a leading 'wc-' before comparing, and treat every post-
--   payment status as a purchase — processing, completed, enviado
--   (shipped), separacao (picking). pending/on-hold (awaiting payment)
--   and cancelled/refunded/failed stay excluded.
--
-- Re-run RFM after applying:  SELECT recalculate_user_rfm('<user>');
-- then refresh segment tags:  SELECT * FROM sync_rfm_tags('<user>');
-- ============================================================

-- Partial index matching the new paid-status predicate so the per-tenant
-- aggregation stays an index scan. regexp_replace is immutable, so it's
-- valid in a partial-index WHERE.
CREATE INDEX IF NOT EXISTS idx_orders_rfm_paid
  ON orders (user_id, contact_id)
  WHERE contact_id IS NOT NULL
    AND regexp_replace(status, '^wc-', '') IN
        ('processing', 'completed', 'enviado', 'separacao');

CREATE OR REPLACE FUNCTION recalculate_user_rfm(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
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
      -- Strip the WooCommerce 'wc-' prefix so 'wc-completed' and
      -- 'completed' both count; include every paid/post-payment status.
      AND regexp_replace(status, '^wc-', '') IN
          ('processing', 'completed', 'enviado', 'separacao')
    GROUP BY contact_id
  ),
  scored AS (
    SELECT
      contact_id,
      frequency_count,
      monetary_value,
      recency_days,
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

COMMENT ON FUNCTION recalculate_user_rfm(UUID) IS
  'Set-based RFM recalc for one tenant. Counts all paid statuses, stripping the WooCommerce wc- prefix (processing/completed/enviado/separacao). No row cap.';
