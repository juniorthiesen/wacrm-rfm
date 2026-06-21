-- ============================================================
-- 040: Audience builder — rich, composable e-commerce segmentation
--
-- Supersedes the unused 032 filtered-campaign functions with a fuller
-- filter set for marketing campaigns. Every filter is optional
-- (NULL = ignored) and ANDed. One core function (audience_rows) is the
-- single source of truth; count / list (CSV) / create-campaign all wrap
-- it so they can never drift.
--
-- Perf: audience_rows is a plain STABLE SQL function (NOT security
-- definer) so the planner INLINES it into the guarded wrappers,
-- pushing predicates down. It reads only contact_rfm_metrics + contacts;
-- the per-contact order/tag checks are correlated EXISTS that the
-- planner only evaluates for rows surviving the cheap RFM filters AND
-- only when that filter is actually set. The first-purchase date (for
-- display) is computed in list_audience over just the page of rows.
--
-- Filters:
--   segments[]            — RFM segment (champion, loyal, ...)
--   recency  min/max      — days since last paid order
--   monetary min/max      — lifetime paid spend (LTV)
--   frequency min/max     — number of paid orders
--   avg_ticket min/max    — monetary / frequency
--   product_like          — bought an item whose name ILIKEs this
--   product_not_like      — did NOT buy such an item (cross-sell)
--   first_order after/before — cohort by first paid purchase date
--   birthday_month        — contacts whose birthday is this month
--   include_tag_ids[]     — has at least one of these tags
--   exclude_tag_ids[]     — has none of these tags
--
-- Only contacts with a WhatsApp-valid phone (12-13 digits) are returned.
-- Paid-status definition mirrors recalculate_user_rfm.
-- ============================================================

-- Accent-insensitive product matching: "Sutia" should match "Sutiã".
-- Brazilian product names are accented; the operator won't always type
-- them that way.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Drop the whole set first (CASCADE) so the function return-type change
-- vs an earlier revision of this migration re-applies cleanly.
DROP FUNCTION IF EXISTS audience_rows(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]) CASCADE;

CREATE OR REPLACE FUNCTION audience_rows(
  p_user_id            UUID,
  p_segments           TEXT[]  DEFAULT NULL,
  p_min_recency_days   INT     DEFAULT NULL,
  p_max_recency_days   INT     DEFAULT NULL,
  p_min_monetary       NUMERIC DEFAULT NULL,
  p_max_monetary       NUMERIC DEFAULT NULL,
  p_min_frequency      INT     DEFAULT NULL,
  p_max_frequency      INT     DEFAULT NULL,
  p_min_avg_ticket     NUMERIC DEFAULT NULL,
  p_max_avg_ticket     NUMERIC DEFAULT NULL,
  p_product_like       TEXT    DEFAULT NULL,
  p_product_not_like   TEXT    DEFAULT NULL,
  p_first_order_after  DATE    DEFAULT NULL,
  p_first_order_before DATE    DEFAULT NULL,
  p_birthday_month     INT     DEFAULT NULL,
  p_include_tag_ids    UUID[]  DEFAULT NULL,
  p_exclude_tag_ids    UUID[]  DEFAULT NULL
)
RETURNS TABLE(
  contact_id      UUID,
  name            TEXT,
  phone           TEXT,
  email           TEXT,
  monetary_value  NUMERIC,
  frequency_count INT,
  recency_days    INT,
  avg_ticket      NUMERIC,
  segment         TEXT
) AS $$
  SELECT
    r.contact_id,
    c.name,
    c.phone,
    c.email,
    r.monetary_value,
    r.frequency_count,
    r.recency_days,
    CASE WHEN r.frequency_count > 0
         THEN ROUND(r.monetary_value / r.frequency_count, 2)
         ELSE 0 END AS avg_ticket,
    r.segment
  FROM contact_rfm_metrics r
  JOIN contacts c ON c.id = r.contact_id
  WHERE r.user_id = p_user_id
    AND c.phone ~ '^[0-9]{12,13}$'
    AND (p_segments IS NULL OR r.segment = ANY(p_segments))
    AND (p_min_recency_days IS NULL OR r.recency_days >= p_min_recency_days)
    AND (p_max_recency_days IS NULL OR r.recency_days <= p_max_recency_days)
    AND (p_min_monetary IS NULL OR r.monetary_value >= p_min_monetary)
    AND (p_max_monetary IS NULL OR r.monetary_value <= p_max_monetary)
    AND (p_min_frequency IS NULL OR r.frequency_count >= p_min_frequency)
    AND (p_max_frequency IS NULL OR r.frequency_count <= p_max_frequency)
    AND (p_min_avg_ticket IS NULL OR
         (CASE WHEN r.frequency_count > 0 THEN r.monetary_value / r.frequency_count ELSE 0 END) >= p_min_avg_ticket)
    AND (p_max_avg_ticket IS NULL OR
         (CASE WHEN r.frequency_count > 0 THEN r.monetary_value / r.frequency_count ELSE 0 END) <= p_max_avg_ticket)
    AND (p_birthday_month IS NULL OR
         (c.birthday IS NOT NULL AND EXTRACT(MONTH FROM c.birthday) = p_birthday_month))
    -- Cohort: first paid order on/after p_first_order_after = no paid
    -- order strictly before it. Only evaluated when the param is set.
    AND (p_first_order_after IS NULL OR NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.contact_id = r.contact_id
        AND regexp_replace(o.status, '^wc-', '') IN ('processing','completed','enviado','separacao')
        AND o.ordered_at < p_first_order_after
    ))
    -- first paid order on/before p_first_order_before = some paid order
    -- by end of that day.
    AND (p_first_order_before IS NULL OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.contact_id = r.contact_id
        AND regexp_replace(o.status, '^wc-', '') IN ('processing','completed','enviado','separacao')
        AND o.ordered_at < (p_first_order_before + INTERVAL '1 day')
    ))
    AND (p_product_like IS NULL OR EXISTS (
      SELECT 1 FROM orders o
      CROSS JOIN LATERAL jsonb_array_elements(o.line_items) AS li
      WHERE o.contact_id = r.contact_id
        AND unaccent(li->>'name') ILIKE unaccent('%' || p_product_like || '%')
    ))
    AND (p_product_not_like IS NULL OR NOT EXISTS (
      SELECT 1 FROM orders o
      CROSS JOIN LATERAL jsonb_array_elements(o.line_items) AS li
      WHERE o.contact_id = r.contact_id
        AND unaccent(li->>'name') ILIKE unaccent('%' || p_product_not_like || '%')
    ))
    AND (p_include_tag_ids IS NULL OR EXISTS (
      SELECT 1 FROM contact_tags ct
      WHERE ct.contact_id = r.contact_id AND ct.tag_id = ANY(p_include_tag_ids)
    ))
    AND (p_exclude_tag_ids IS NULL OR NOT EXISTS (
      SELECT 1 FROM contact_tags ct
      WHERE ct.contact_id = r.contact_id AND ct.tag_id = ANY(p_exclude_tag_ids)
    ));
$$ LANGUAGE sql STABLE;

-- Count wrapper (guards tenant isolation; audience_rows inlines).
CREATE OR REPLACE FUNCTION count_audience(
  p_user_id            UUID,
  p_segments           TEXT[]  DEFAULT NULL,
  p_min_recency_days   INT     DEFAULT NULL,
  p_max_recency_days   INT     DEFAULT NULL,
  p_min_monetary       NUMERIC DEFAULT NULL,
  p_max_monetary       NUMERIC DEFAULT NULL,
  p_min_frequency      INT     DEFAULT NULL,
  p_max_frequency      INT     DEFAULT NULL,
  p_min_avg_ticket     NUMERIC DEFAULT NULL,
  p_max_avg_ticket     NUMERIC DEFAULT NULL,
  p_product_like       TEXT    DEFAULT NULL,
  p_product_not_like   TEXT    DEFAULT NULL,
  p_first_order_after  DATE    DEFAULT NULL,
  p_first_order_before DATE    DEFAULT NULL,
  p_birthday_month     INT     DEFAULT NULL,
  p_include_tag_ids    UUID[]  DEFAULT NULL,
  p_exclude_tag_ids    UUID[]  DEFAULT NULL
)
RETURNS INTEGER AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN (SELECT count(*)::int FROM audience_rows(
    p_user_id, p_segments, p_min_recency_days, p_max_recency_days,
    p_min_monetary, p_max_monetary, p_min_frequency, p_max_frequency,
    p_min_avg_ticket, p_max_avg_ticket, p_product_like, p_product_not_like,
    p_first_order_after, p_first_order_before, p_birthday_month,
    p_include_tag_ids, p_exclude_tag_ids
  ));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Paginated list for the preview table + CSV export. p_order:
-- 'spend' (default) | 'ticket' | 'recent' | 'name'. total_count via
-- window so the UI shows the full size in one round-trip. first_order_at
-- is computed only for the returned page.
CREATE OR REPLACE FUNCTION list_audience(
  p_user_id            UUID,
  p_segments           TEXT[]  DEFAULT NULL,
  p_min_recency_days   INT     DEFAULT NULL,
  p_max_recency_days   INT     DEFAULT NULL,
  p_min_monetary       NUMERIC DEFAULT NULL,
  p_max_monetary       NUMERIC DEFAULT NULL,
  p_min_frequency      INT     DEFAULT NULL,
  p_max_frequency      INT     DEFAULT NULL,
  p_min_avg_ticket     NUMERIC DEFAULT NULL,
  p_max_avg_ticket     NUMERIC DEFAULT NULL,
  p_product_like       TEXT    DEFAULT NULL,
  p_product_not_like   TEXT    DEFAULT NULL,
  p_first_order_after  DATE    DEFAULT NULL,
  p_first_order_before DATE    DEFAULT NULL,
  p_birthday_month     INT     DEFAULT NULL,
  p_include_tag_ids    UUID[]  DEFAULT NULL,
  p_exclude_tag_ids    UUID[]  DEFAULT NULL,
  p_order              TEXT    DEFAULT 'spend',
  p_limit              INT     DEFAULT 100,
  p_offset             INT     DEFAULT 0
)
RETURNS TABLE(
  contact_id      UUID,
  name            TEXT,
  phone           TEXT,
  email           TEXT,
  monetary_value  NUMERIC,
  frequency_count INT,
  recency_days    INT,
  avg_ticket      NUMERIC,
  first_order_at  TIMESTAMPTZ,
  segment         TEXT,
  total_count     BIGINT
) AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
  WITH page AS (
    SELECT a.*, count(*) OVER() AS total_count
    FROM audience_rows(
      p_user_id, p_segments, p_min_recency_days, p_max_recency_days,
      p_min_monetary, p_max_monetary, p_min_frequency, p_max_frequency,
      p_min_avg_ticket, p_max_avg_ticket, p_product_like, p_product_not_like,
      p_first_order_after, p_first_order_before, p_birthday_month,
      p_include_tag_ids, p_exclude_tag_ids
    ) a
    ORDER BY
      CASE WHEN p_order = 'name'   THEN a.name        END ASC,
      CASE WHEN p_order = 'recent' THEN a.recency_days END ASC,
      CASE WHEN p_order = 'ticket' THEN a.avg_ticket   END DESC,
      CASE WHEN p_order NOT IN ('name','recent','ticket') THEN a.monetary_value END DESC,
      a.contact_id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    p.contact_id, p.name, p.phone, p.email, p.monetary_value,
    p.frequency_count, p.recency_days, p.avg_ticket,
    (SELECT MIN(o.ordered_at) FROM orders o
       WHERE o.contact_id = p.contact_id
         AND regexp_replace(o.status, '^wc-', '') IN ('processing','completed','enviado','separacao')
    ) AS first_order_at,
    p.segment, p.total_count
  FROM page p;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Build a drip campaign from the audience, with optional sampling.
-- Provide p_sample_percent (1-100) OR p_sample_limit (absolute cap);
-- both NULL = whole audience. p_rank: 'spend'|'ticket'|'recent'|'random'.
CREATE OR REPLACE FUNCTION create_audience_campaign(
  p_user_id            UUID,
  p_name               TEXT,
  p_template_name      TEXT,
  p_template_language  TEXT,
  p_template_variables JSONB,
  p_daily_limit        INTEGER DEFAULT 2000,
  p_sample_percent     NUMERIC DEFAULT NULL,
  p_sample_limit       INT     DEFAULT NULL,
  p_rank               TEXT    DEFAULT 'spend',
  p_segments           TEXT[]  DEFAULT NULL,
  p_min_recency_days   INT     DEFAULT NULL,
  p_max_recency_days   INT     DEFAULT NULL,
  p_min_monetary       NUMERIC DEFAULT NULL,
  p_max_monetary       NUMERIC DEFAULT NULL,
  p_min_frequency      INT     DEFAULT NULL,
  p_max_frequency      INT     DEFAULT NULL,
  p_min_avg_ticket     NUMERIC DEFAULT NULL,
  p_max_avg_ticket     NUMERIC DEFAULT NULL,
  p_product_like       TEXT    DEFAULT NULL,
  p_product_not_like   TEXT    DEFAULT NULL,
  p_first_order_after  DATE    DEFAULT NULL,
  p_first_order_before DATE    DEFAULT NULL,
  p_birthday_month     INT     DEFAULT NULL,
  p_include_tag_ids    UUID[]  DEFAULT NULL,
  p_exclude_tag_ids    UUID[]  DEFAULT NULL
)
RETURNS TABLE(broadcast_id UUID, total_recipients INT) AS $$
DECLARE
  v_broadcast_id UUID;
  v_total        INT;
  v_cap          INT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT count(*)::int INTO v_total FROM audience_rows(
    p_user_id, p_segments, p_min_recency_days, p_max_recency_days,
    p_min_monetary, p_max_monetary, p_min_frequency, p_max_frequency,
    p_min_avg_ticket, p_max_avg_ticket, p_product_like, p_product_not_like,
    p_first_order_after, p_first_order_before, p_birthday_month,
    p_include_tag_ids, p_exclude_tag_ids
  );

  v_cap := COALESCE(
    p_sample_limit,
    CASE WHEN p_sample_percent IS NOT NULL
         THEN GREATEST(1, CEIL(v_total * p_sample_percent / 100.0))::int
         ELSE v_total END
  );

  INSERT INTO broadcasts (
    user_id, name, template_name, template_language, template_variables,
    status, daily_limit
  ) VALUES (
    p_user_id, p_name, p_template_name, p_template_language,
    p_template_variables, 'sending', p_daily_limit
  ) RETURNING id INTO v_broadcast_id;

  INSERT INTO broadcast_recipients (broadcast_id, contact_id, rank, status)
  SELECT v_broadcast_id, t.contact_id, t.rn, 'pending'
  FROM (
    SELECT a.contact_id,
      row_number() OVER (
        ORDER BY (
          CASE
            WHEN p_rank = 'random' THEN random()
            WHEN p_rank = 'recent' THEN (-a.recency_days)::double precision
            WHEN p_rank = 'ticket' THEN a.avg_ticket::double precision
            ELSE a.monetary_value::double precision
          END
        ) DESC, a.contact_id
      ) AS rn
    FROM audience_rows(
      p_user_id, p_segments, p_min_recency_days, p_max_recency_days,
      p_min_monetary, p_max_monetary, p_min_frequency, p_max_frequency,
      p_min_avg_ticket, p_max_avg_ticket, p_product_like, p_product_not_like,
      p_first_order_after, p_first_order_before, p_birthday_month,
      p_include_tag_ids, p_exclude_tag_ids
    ) a
  ) t
  WHERE t.rn <= v_cap;

  GET DIAGNOSTICS v_total = ROW_COUNT;
  UPDATE broadcasts SET total_recipients = v_total WHERE id = v_broadcast_id;

  broadcast_id := v_broadcast_id;
  total_recipients := v_total;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- audience_rows is reachable only through the guarded wrappers.
REVOKE ALL ON FUNCTION audience_rows(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION audience_rows(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]) TO service_role;
REVOKE ALL ON FUNCTION count_audience(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION count_audience(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION list_audience(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[], TEXT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_audience(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[], TEXT, INT, INT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION create_audience_campaign(UUID, TEXT, TEXT, TEXT, JSONB, INTEGER, NUMERIC, INT, TEXT, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_audience_campaign(UUID, TEXT, TEXT, TEXT, JSONB, INTEGER, NUMERIC, INT, TEXT, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]) TO authenticated, service_role;

COMMENT ON FUNCTION audience_rows(UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]) IS
  'Inlineable core audience filter for the Públicos builder: RFM segment, recency/monetary/frequency/avg-ticket ranges, product bought / not-bought, first-purchase cohort window, birthday month, tag include/exclude. WhatsApp-valid phones only.';
