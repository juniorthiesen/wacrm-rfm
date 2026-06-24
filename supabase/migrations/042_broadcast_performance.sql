-- ============================================================
-- 042: Broadcast performance — measure return on a campaign
--
-- Ties "who received" (broadcast_recipients) to "who bought after"
-- (orders) so a campaign can be measured end-to-end: engagement funnel
-- + attributed conversions/revenue + (with a per-message cost) ROAS.
--
--   * engagement: sent / delivered / read / replied / failed counts.
--   * conversion: contacts who placed a PAID order within p_window_days
--     of their send (last-touch time-window attribution), plus the order
--     count and revenue. "created" variants include not-yet-paid orders
--     (PIX/boleto still pending) to show intent.
--
-- msg_cost (added to broadcasts) stores the per-message cost the operator
-- sets, so the results panel can compute cost = sent * msg_cost and the
-- return (ROAS = revenue / cost). Persisted per campaign = "saved in CRM".
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS msg_cost NUMERIC(10, 4);

CREATE OR REPLACE FUNCTION broadcast_performance(
  p_broadcast_id UUID,
  p_window_days  INT DEFAULT 7
)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID;
  result    JSONB;
BEGIN
  SELECT user_id INTO v_user_id FROM broadcasts WHERE id = p_broadcast_id;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> v_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  WITH r AS (
    SELECT contact_id, sent_at, status
    FROM broadcast_recipients
    WHERE broadcast_id = p_broadcast_id
  ),
  conv AS (
    -- Orders placed by a recipient within the attribution window after
    -- their own send time. Excludes failed sends (never delivered).
    SELECT DISTINCT ON (o.id)
      o.id, o.contact_id, o.total_amount,
      regexp_replace(o.status, '^wc-', '') IN
        ('processing','completed','enviado','separacao') AS paid
    FROM r
    JOIN orders o
      ON o.contact_id = r.contact_id
     AND o.user_id = v_user_id
     AND r.sent_at IS NOT NULL
     AND r.status <> 'failed'
     AND o.ordered_at >= r.sent_at
     AND o.ordered_at <= r.sent_at + make_interval(days => p_window_days)
  )
  SELECT jsonb_build_object(
    'window_days', p_window_days,
    'total',      (SELECT count(*) FROM r),
    'sent',       (SELECT count(*) FROM r WHERE status IN ('sent','delivered','read','replied')),
    'delivered',  (SELECT count(*) FROM r WHERE status IN ('delivered','read','replied')),
    'read',       (SELECT count(*) FROM r WHERE status IN ('read','replied')),
    'replied',    (SELECT count(*) FROM r WHERE status = 'replied'),
    'failed',     (SELECT count(*) FROM r WHERE status = 'failed'),
    'buyers',         (SELECT count(DISTINCT contact_id) FROM conv WHERE paid),
    'paid_orders',    (SELECT count(*) FROM conv WHERE paid),
    'revenue',        (SELECT COALESCE(sum(total_amount), 0) FROM conv WHERE paid),
    'buyers_all',     (SELECT count(DISTINCT contact_id) FROM conv),
    'orders_all',     (SELECT count(*) FROM conv),
    'revenue_all',    (SELECT COALESCE(sum(total_amount), 0) FROM conv)
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION broadcast_performance(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION broadcast_performance(UUID, INT) TO authenticated, service_role;

COMMENT ON FUNCTION broadcast_performance(UUID, INT) IS
  'Per-broadcast measurement: engagement funnel + attributed conversions/revenue (paid orders by recipients within p_window_days of their send). Pair with broadcasts.msg_cost for ROAS.';
