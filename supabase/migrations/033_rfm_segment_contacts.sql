-- ============================================================
-- 033: List the contacts of an RFM segment (drill-down)
--
-- Powers the RFM page's segment explorer: click a segment, see its
-- customers (name/phone/email + their R/F/M figures), search, paginate
-- and export. count(*) OVER() returns the unfiltered total alongside
-- the page so the UI can show "page X of Y" in one round-trip.
-- ============================================================

CREATE OR REPLACE FUNCTION rfm_segment_contacts(
  p_user_id UUID,
  p_segment TEXT,
  p_search  TEXT DEFAULT NULL,
  p_limit   INT  DEFAULT 50,
  p_offset  INT  DEFAULT 0
)
RETURNS TABLE(
  id              UUID,
  name            TEXT,
  phone           TEXT,
  email           TEXT,
  monetary_value  NUMERIC,
  recency_days    INT,
  frequency_count INT,
  total_count     BIGINT
) AS $$
  SELECT
    c.id,
    c.name,
    c.phone,
    c.email,
    r.monetary_value,
    r.recency_days,
    r.frequency_count,
    count(*) OVER() AS total_count
  FROM contact_rfm_metrics r
  JOIN contacts c ON c.id = r.contact_id
  WHERE r.user_id = p_user_id
    AND r.segment = p_segment
    AND (
      p_search IS NULL OR p_search = '' OR
      c.name  ILIKE '%' || p_search || '%' OR
      c.phone ILIKE '%' || p_search || '%' OR
      c.email ILIKE '%' || p_search || '%'
    )
  ORDER BY r.monetary_value DESC, c.id
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION rfm_segment_contacts(UUID, TEXT, TEXT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rfm_segment_contacts(UUID, TEXT, TEXT, INT, INT) TO authenticated, service_role;

COMMENT ON FUNCTION rfm_segment_contacts(UUID, TEXT, TEXT, INT, INT) IS
  'Paginated contacts of an RFM segment with their R/F/M figures and a window total_count, for the RFM page segment drill-down and CSV export.';
