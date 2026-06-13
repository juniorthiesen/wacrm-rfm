-- ============================================================
-- 027: Aggregate RFM insights in Postgres
--
-- Why:
--   /api/rfm/insights read every contact_rfm_metrics row with a plain
--   select and aggregated in JS. PostgREST caps that select at 1000
--   rows, so a tenant with tens of thousands of scored customers saw
--   totals, segment counts, revenue and the heatmap computed over only
--   1000 of them — the page showed "1.0k customers" regardless of the
--   real base. (Same 1000-row cap that bit the RFM recalc and contact
--   matching.)
--
--   This function does the aggregation set-based: totals, per-segment
--   buckets and the 5x5 R×F heatmap in one query, no row cap. The
--   endpoint formats the result and fetches top contacts separately
--   with an indexed ORDER BY ... LIMIT (which is never capped).
--
-- Mirrors the JS aggregation it replaces: segment defaults to 'lost'
-- when null; avg_ticket is the mean over all customers of
-- monetary/frequency (0 when a customer has no countable frequency).
-- ============================================================

CREATE OR REPLACE FUNCTION rfm_insights(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  result JSONB;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  WITH m AS (
    SELECT
      COALESCE(segment, 'lost') AS segment,
      recency_score,
      frequency_score,
      recency_days,
      frequency_count,
      monetary_value,
      last_calculated_at
    FROM contact_rfm_metrics
    WHERE user_id = p_user_id
  )
  SELECT jsonb_build_object(
    'total_customers', (SELECT count(*) FROM m),
    'total_revenue', (SELECT COALESCE(sum(monetary_value), 0) FROM m),
    'avg_recency_days', (SELECT avg(recency_days) FROM m),
    'avg_ticket', (
      SELECT COALESCE(
        sum(CASE WHEN frequency_count > 0
              THEN monetary_value / frequency_count ELSE 0 END), 0
      ) / NULLIF(count(*), 0)
      FROM m
    ),
    'last_calculated_at', (SELECT max(last_calculated_at) FROM m),
    'segments', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'segment', segment,
        'count', cnt,
        'revenue', revenue,
        'ticket_sum', ticket_sum
      )), '[]'::jsonb)
      FROM (
        SELECT
          segment,
          count(*) AS cnt,
          COALESCE(sum(monetary_value), 0) AS revenue,
          COALESCE(sum(CASE WHEN frequency_count > 0
                THEN monetary_value / frequency_count ELSE 0 END), 0) AS ticket_sum
        FROM m
        GROUP BY segment
      ) s
    ),
    'heatmap', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'r', recency_score,
        'f', frequency_score,
        'count', cnt,
        'revenue', revenue
      )), '[]'::jsonb)
      FROM (
        SELECT
          recency_score,
          frequency_score,
          count(*) AS cnt,
          COALESCE(sum(monetary_value), 0) AS revenue
        FROM m
        WHERE recency_score IS NOT NULL AND frequency_score IS NOT NULL
        GROUP BY recency_score, frequency_score
      ) h
    )
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION rfm_insights(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rfm_insights(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION rfm_insights(UUID) IS
  'Set-based aggregation for the RFM dashboard: totals, per-segment buckets and the 5x5 R×F heatmap in one query. Replaces an in-app aggregation that capped at 1000 rows. Top-contact lists are fetched separately with ORDER BY ... LIMIT.';
