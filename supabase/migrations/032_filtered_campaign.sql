-- ============================================================
-- 032: Filtered campaign builder (beyond RFM segment)
--
-- create_segment_campaign (031) only filtered by RFM segment. This
-- adds a richer audience builder: combine segment, recency window,
-- spend range, frequency floor and "bought a product whose name
-- matches" — any subset, all ANDed. Every filter is optional (NULL =
-- ignored). Same snapshot + drip plumbing, so campaigns stay immune to
-- RFM recalcs.
--
-- Product filter note: orders.line_items carries name/quantity/total/
-- product_id (no SKU yet), so product targeting is by name match or
-- product_id. SKU/category would need ingestion changes + re-sync.
--
-- Preview a filter's size before committing with count_filtered_audience
-- (same args, returns just the count).
-- ============================================================

-- Shared predicate as an inlineable SQL function keeps the count and the
-- create paths from drifting. Returns the matching contact_ids.
CREATE OR REPLACE FUNCTION filtered_audience_ids(
  p_user_id            UUID,
  p_segments           TEXT[],
  p_min_recency_days   INT,
  p_max_recency_days   INT,
  p_min_monetary       NUMERIC,
  p_max_monetary       NUMERIC,
  p_min_frequency      INT,
  p_product_name_like  TEXT
)
RETURNS TABLE(contact_id UUID, monetary_value NUMERIC) AS $$
  SELECT r.contact_id, r.monetary_value
  FROM contact_rfm_metrics r
  JOIN contacts c ON c.id = r.contact_id
  WHERE r.user_id = p_user_id
    AND c.phone NOT LIKE 'wooc_%'
    AND c.phone ~ '^[0-9]{12,13}$'
    AND (p_segments IS NULL OR r.segment = ANY(p_segments))
    AND (p_min_recency_days IS NULL OR r.recency_days >= p_min_recency_days)
    AND (p_max_recency_days IS NULL OR r.recency_days <= p_max_recency_days)
    AND (p_min_monetary IS NULL OR r.monetary_value >= p_min_monetary)
    AND (p_max_monetary IS NULL OR r.monetary_value <= p_max_monetary)
    AND (p_min_frequency IS NULL OR r.frequency_count >= p_min_frequency)
    AND (
      p_product_name_like IS NULL OR EXISTS (
        SELECT 1 FROM orders o
        CROSS JOIN LATERAL jsonb_array_elements(o.line_items) AS li
        WHERE o.contact_id = r.contact_id
          AND li->>'name' ILIKE '%' || p_product_name_like || '%'
      )
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Preview: how many contacts match these filters (no campaign created).
CREATE OR REPLACE FUNCTION count_filtered_audience(
  p_user_id            UUID,
  p_segments           TEXT[]  DEFAULT NULL,
  p_min_recency_days   INT     DEFAULT NULL,
  p_max_recency_days   INT     DEFAULT NULL,
  p_min_monetary       NUMERIC DEFAULT NULL,
  p_max_monetary       NUMERIC DEFAULT NULL,
  p_min_frequency      INT     DEFAULT NULL,
  p_product_name_like  TEXT    DEFAULT NULL
)
RETURNS INTEGER AS $$
  SELECT count(*)::int FROM filtered_audience_ids(
    p_user_id, p_segments, p_min_recency_days, p_max_recency_days,
    p_min_monetary, p_max_monetary, p_min_frequency, p_product_name_like
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Build the campaign + snapshot the filtered audience (ranked by spend).
CREATE OR REPLACE FUNCTION create_filtered_campaign(
  p_user_id            UUID,
  p_name               TEXT,
  p_template_name      TEXT,
  p_template_language  TEXT,
  p_template_variables JSONB,
  p_daily_limit        INTEGER DEFAULT 2000,
  p_segments           TEXT[]  DEFAULT NULL,
  p_min_recency_days   INT     DEFAULT NULL,
  p_max_recency_days   INT     DEFAULT NULL,
  p_min_monetary       NUMERIC DEFAULT NULL,
  p_max_monetary       NUMERIC DEFAULT NULL,
  p_min_frequency      INT     DEFAULT NULL,
  p_product_name_like  TEXT    DEFAULT NULL
)
RETURNS TABLE(broadcast_id UUID, total_recipients INT) AS $$
DECLARE
  v_broadcast_id UUID;
  v_total INT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  INSERT INTO broadcasts (
    user_id, name, template_name, template_language, template_variables,
    status, daily_limit
  ) VALUES (
    p_user_id, p_name, p_template_name, p_template_language,
    p_template_variables, 'sending', p_daily_limit
  ) RETURNING id INTO v_broadcast_id;

  INSERT INTO broadcast_recipients (broadcast_id, contact_id, rank, status)
  SELECT
    v_broadcast_id,
    a.contact_id,
    row_number() OVER (ORDER BY a.monetary_value DESC, a.contact_id),
    'pending'
  FROM filtered_audience_ids(
    p_user_id, p_segments, p_min_recency_days, p_max_recency_days,
    p_min_monetary, p_max_monetary, p_min_frequency, p_product_name_like
  ) a;

  GET DIAGNOSTICS v_total = ROW_COUNT;
  UPDATE broadcasts SET total_recipients = v_total WHERE id = v_broadcast_id;

  broadcast_id := v_broadcast_id;
  total_recipients := v_total;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION filtered_audience_ids(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION count_filtered_audience(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION create_filtered_campaign(UUID, TEXT, TEXT, TEXT, JSONB, INTEGER, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION count_filtered_audience(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION create_filtered_campaign(UUID, TEXT, TEXT, TEXT, JSONB, INTEGER, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION create_filtered_campaign(UUID, TEXT, TEXT, TEXT, JSONB, INTEGER, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, TEXT) IS
  'Creates a drip campaign from a combined audience filter (RFM segment + recency window + spend range + frequency + product-name match). Snapshots into broadcast_recipients ranked by spend.';
