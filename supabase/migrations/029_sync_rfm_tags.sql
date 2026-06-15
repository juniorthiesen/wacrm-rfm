-- ============================================================
-- 029: Project RFM segments onto contact tags
--
-- Why:
--   Broadcasts (Transmissões) target audiences by TAG, but the RFM
--   engine stores each contact's segment in contact_rfm_metrics — a
--   separate table the broadcast audience picker can't read. So there
--   was no way to "send this campaign to all Champions".
--
--   This function bridges that: it ensures one tag per RFM segment
--   exists, then keeps each contact tagged with their CURRENT segment
--   (removing the tag from anyone who moved out). After running it, the
--   broadcast tag filter can target any segment.
--
-- Reusable + idempotent: run it after each RFM recalc to refresh the
-- tags. new_lead (no purchase) is intentionally not tagged — these tags
-- are for customers who have bought.
--
--   SELECT * FROM sync_rfm_tags('<user-uuid>');
-- ============================================================

CREATE OR REPLACE FUNCTION sync_rfm_tags(p_user_id UUID)
RETURNS TABLE(segment TEXT, tag_name TEXT, contacts_tagged INT) AS $$
DECLARE
  seg RECORD;
  v_tag_id UUID;
  v_count INT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  FOR seg IN SELECT * FROM (VALUES
    ('champion',       '👑 Campeões',          '#f59e0b'),
    ('loyal',          '💚 Fiéis',             '#10b981'),
    ('new_customer',   '🌱 Novos Clientes',    '#3b82f6'),
    ('about_to_sleep', '😴 Quase Adormecidos', '#f97316'),
    ('in_risk',        '⚠️ Em Risco',          '#ef4444'),
    ('hibernating',    '❄️ Hibernando',        '#06b6d4'),
    ('lost',           '💔 Perdidos',          '#6b7280')
  ) AS m(seg_key, label, color)
  LOOP
    -- Find or create the tag for this segment.
    SELECT id INTO v_tag_id
    FROM tags
    WHERE user_id = p_user_id AND name = seg.label
    LIMIT 1;

    IF v_tag_id IS NULL THEN
      INSERT INTO tags (user_id, name, color)
      VALUES (p_user_id, seg.label, seg.color)
      RETURNING id INTO v_tag_id;
    END IF;

    -- Drop the tag from contacts no longer in this segment.
    DELETE FROM contact_tags ct
    WHERE ct.tag_id = v_tag_id
      AND NOT EXISTS (
        SELECT 1 FROM contact_rfm_metrics r
        WHERE r.contact_id = ct.contact_id
          AND r.user_id = p_user_id
          AND r.segment = seg.seg_key
      );

    -- Tag every contact currently in this segment.
    INSERT INTO contact_tags (contact_id, tag_id)
    SELECT r.contact_id, v_tag_id
    FROM contact_rfm_metrics r
    WHERE r.user_id = p_user_id AND r.segment = seg.seg_key
    ON CONFLICT (contact_id, tag_id) DO NOTHING;

    SELECT count(*)::int INTO v_count
    FROM contact_rfm_metrics r
    WHERE r.user_id = p_user_id AND r.segment = seg.seg_key;

    segment := seg.seg_key;
    tag_name := seg.label;
    contacts_tagged := v_count;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION sync_rfm_tags(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION sync_rfm_tags(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION sync_rfm_tags(UUID) IS
  'Creates one tag per RFM segment and keeps each contact tagged with their current segment, so broadcasts can target a segment by its tag. Idempotent — run after each RFM recalc.';
