-- ============================================================
-- 038: Repurchase / repeat-purchase KPIs in Postgres
--
-- Why:
--   The strategy's north-star KPI is "% of customers who bought 2x+",
--   plus the repurchase ladder (1x → 2x → 3x+/VIP) and windowed
--   repurchase rates (30/60/90d). None of these were surfaced anywhere.
--   The store has ~45k orders, so any client-side aggregation hits the
--   PostgREST 1000-row cap and lies — same reason RFM moved set-based
--   (see 025/027/030). This does the whole thing in one query.
--
-- Paid-order definition mirrors recalculate_user_rfm (030): strip a
-- leading 'wc-' and count processing/completed/enviado/separacao;
-- pending/on-hold/cancelled/refunded/failed are excluded.
--
-- Windowed repurchase uses a MATURED-COHORT denominator: a customer
-- only counts toward the N-day rate once their first order is at least
-- N days old (they've had the full window to come back). Numerator =
-- those whose 2nd paid order landed within N days of the 1st. This is
-- the honest definition — recent first-buyers who haven't had time
-- don't drag the rate down.
--
-- Returns one JSONB blob the dashboard renders directly.
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
  -- Authenticated callers may only read their own tenant; service-role
  -- (auth.uid() IS NULL) is allowed. Same guard as the RFM functions.
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
  -- Second paid order timestamp per customer (for the windowed rate).
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
      -- % of all customers who reached a 2nd order (mirrors repeat_rate).
      'to_2nd', (
        SELECT CASE WHEN COUNT(*) = 0 THEN 0
          ELSE ROUND(
            100.0 * COUNT(*) FILTER (WHERE order_count >= 2) / COUNT(*), 1
          ) END
        FROM per_customer
      ),
      -- % of repeat (2x+) customers who reached a 3rd order.
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
        FROM (VALUES (30), (60), (90)) AS d(days)
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
  'Set-based repurchase KPIs for one tenant: repeat rate (2x+), avg orders/customer, avg ticket, the 1x/2x/3x+ ladder with conversion, and matured-cohort 30/60/90-day repurchase rates. Paid-status definition mirrors recalculate_user_rfm. No row cap.';
