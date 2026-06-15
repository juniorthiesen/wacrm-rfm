-- ============================================================
-- 031: Snapshot-based broadcast drip
--
-- Why:
--   Large segmented campaigns (e.g. 6k "Em Risco + Quase Adormecidos")
--   must respect Meta's daily business-initiated limit (2k/24h) AND
--   stay stable while the nightly RFM recalc reshuffles segments. A
--   live OFFSET over contact_rfm_metrics breaks on every recalc.
--
--   Fix: freeze the audience once into broadcast_recipients (a
--   snapshot of contact_ids, ranked by value), then a cron drains it
--   in daily-limited batches. Once snapshotted, the RFM cron can run
--   freely — the campaign reads its own frozen list, not the segments.
--
-- This migration:
--   - broadcasts.daily_limit: max conversations to start per 24h.
--   - broadcast_recipients.rank: stable send order (value desc), so
--     the drip is deterministic regardless of insert timing.
--   - create_segment_campaign(): builds the broadcast + snapshots the
--     segment's contacts as pending recipients in one call.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS daily_limit INTEGER NOT NULL DEFAULT 2000;

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS rank INTEGER;

-- Index for the drip's hot query: next pending recipients of a campaign
-- in rank order.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_drip
  ON broadcast_recipients (broadcast_id, rank)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION create_segment_campaign(
  p_user_id            UUID,
  p_name               TEXT,
  p_template_name      TEXT,
  p_template_language  TEXT,
  p_template_variables JSONB,
  p_segments           TEXT[],
  p_daily_limit        INTEGER DEFAULT 2000
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

  -- Snapshot the segment's reachable contacts, ranked by spend so the
  -- highest-value customers go out first.
  INSERT INTO broadcast_recipients (broadcast_id, contact_id, rank, status)
  SELECT v_broadcast_id, t.contact_id, t.rk, 'pending'
  FROM (
    SELECT
      r.contact_id,
      row_number() OVER (ORDER BY r.monetary_value DESC, r.contact_id) AS rk
    FROM contact_rfm_metrics r
    JOIN contacts c ON c.id = r.contact_id
    WHERE r.user_id = p_user_id
      AND r.segment = ANY(p_segments)
      AND c.phone NOT LIKE 'wooc_%'           -- skip email placeholders
      AND c.phone ~ '^[0-9]{12,13}$'          -- BR phone with country code
  ) t;

  GET DIAGNOSTICS v_total = ROW_COUNT;
  UPDATE broadcasts SET total_recipients = v_total WHERE id = v_broadcast_id;

  broadcast_id := v_broadcast_id;
  total_recipients := v_total;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION create_segment_campaign(UUID, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_segment_campaign(UUID, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER)
  TO authenticated, service_role;

COMMENT ON FUNCTION create_segment_campaign(UUID, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER) IS
  'Creates a broadcast and snapshots an RFM segment audience into broadcast_recipients (pending, ranked by spend). The drip cron drains it in daily-limited batches, immune to later RFM recalcs.';
