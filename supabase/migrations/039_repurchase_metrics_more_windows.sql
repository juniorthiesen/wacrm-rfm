-- ============================================================
-- 039: Expand repurchase_metrics windows to 30/60/90/120/180/360
--
-- 038 shipped 30/60/90-day repurchase windows. The repurchase cycle for
-- DLY runs longer than a quarter (all-time repeat rate ~26% vs ~10% at
-- 90d), so add 120/180/360-day windows to see the full curve. The
-- dashboard renders data.windows dynamically, so no frontend change is
-- needed — it just gains three more bars.
--
-- CREATE OR REPLACE keeps the existing GRANTs. Only the VALUES list in
-- the `windows` aggregate changed vs 038; everything else is identical.
-- ============================================================

CREATE OR REPLACE FUNCTION repurchase_metrics(p_user_id UUID)
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

  WITH paid AS (
    SELECT
      contact_id,
      total_amount,
      ordered_at,
      ROW_NUMBER() OVER (
        PARTITION BY contact_id ORDER BY ordered_at ASC, id ASC
      ) AS rn
    FROM orders
    WHERE user_id = p_user_id
      AND contact_id IS NOT NULL
      AND regexp_replace(status, '^wc-', '') IN
          ('processing', 'completed', 'enviado', 'separacao')
  ),
  per_customer AS (
    SELECT
      contact_id,
      COUNT(*)::int AS order_count,
      COALESCE(SUM(total_amount), 0) AS revenue,
      MIN(ordered_at) AS first_at
    FROM paid
    GROUP BY contact_id
  ),
  seconds AS (
    SELECT contact_id, ordered_at AS second_at
    FROM paid
    WHERE rn = 2
  ),
  customer_window AS (
    SELECT
      pc.contact_id,
      pc.first_at,
      s.second_at
    FROM per_customer pc
    LEFT JOIN seconds s ON s.contact_id = pc.contact_id
  )
  SELECT jsonb_build_object(
    'total_customers', (SELECT COUNT(*) FROM per_customer),
    'total_orders',    (SELECT COUNT(*) FROM paid),
    'total_revenue',   (SELECT COALESCE(SUM(revenue), 0) FROM per_customer),
    'repeat_customers',(SELECT COUNT(*) FROM per_customer WHERE order_count >= 2),
    'repeat_rate', (
      SELECT CASE WHEN COUNT(*) = 0 THEN 0
        ELSE ROUND(
          100.0 * COUNT(*) FILTER (WHERE order_count >= 2) / COUNT(*), 1
        ) END
      FROM per_customer
    ),
    'avg_orders_per_customer', (
      SELECT CASE WHEN COUNT(*) = 0 THEN 0
        ELSE ROUND(SUM(order_count)::numeric / COUNT(*), 2) END
      FROM per_customer
    ),
    'avg_ticket', (
      SELECT CASE WHEN COALESCE(SUM(order_count), 0) = 0 THEN 0
        ELSE ROUND(SUM(revenue) / SUM(order_count), 2) END
      FROM per_customer
    ),
    'funnel', jsonb_build_object(
      'one',        (SELECT COUNT(*) FROM per_customer WHERE order_count = 1),
      'two',        (SELECT COUNT(*) FROM per_customer WHERE order_count = 2),
      'three_plus', (SELECT COUNT(*) FROM per_customer WHERE order_count >= 3)
    ),
    'conversion', jsonb_build_object(
      'to_2nd', (
        SELECT CASE WHEN COUNT(*) = 0 THEN 0
          ELSE ROUND(
            100.0 * COUNT(*) FILTER (WHERE order_count >= 2) / COUNT(*), 1
          ) END
        FROM per_customer
      ),
      'to_3rd', (
        SELECT CASE WHEN COUNT(*) FILTER (WHERE order_count >= 2) = 0 THEN 0
          ELSE ROUND(
            100.0 * COUNT(*) FILTER (WHERE order_count >= 3)
                  / COUNT(*) FILTER (WHERE order_count >= 2), 1
          ) END
        FROM per_customer
      )
    ),
    'windows', (
      SELECT COALESCE(jsonb_agg(row_to_json(w) ORDER BY w.days), '[]'::jsonb)
      FROM (
        SELECT
          d.days,
          COUNT(*) FILTER (
            WHERE cw.first_at <= now() - make_interval(days => d.days)
          )::int AS eligible,
          COUNT(*) FILTER (
            WHERE cw.first_at <= now() - make_interval(days => d.days)
              AND cw.second_at IS NOT NULL
              AND cw.second_at <= cw.first_at + make_interval(days => d.days)
          )::int AS repurchased,
          CASE
            WHEN COUNT(*) FILTER (
              WHERE cw.first_at <= now() - make_interval(days => d.days)
            ) = 0 THEN 0
            ELSE ROUND(
              100.0 * COUNT(*) FILTER (
                WHERE cw.first_at <= now() - make_interval(days => d.days)
                  AND cw.second_at IS NOT NULL
                  AND cw.second_at <= cw.first_at + make_interval(days => d.days)
              ) / COUNT(*) FILTER (
                WHERE cw.first_at <= now() - make_interval(days => d.days)
              ), 1)
          END AS rate
        FROM (VALUES (30), (60), (90), (120), (180), (360)) AS d(days)
        CROSS JOIN customer_window cw
        GROUP BY d.days
      ) w
    )
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION repurchase_metrics(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION repurchase_metrics(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION repurchase_metrics(UUID) IS
  'Set-based repurchase KPIs for one tenant: repeat rate (2x+), avg orders/customer, avg ticket, the 1x/2x/3x+ ladder with conversion, and matured-cohort 30/60/90/120/180/360-day repurchase rates. Paid-status definition mirrors recalculate_user_rfm. No row cap.';
