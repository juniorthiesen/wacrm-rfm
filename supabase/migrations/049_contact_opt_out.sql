-- ============================================================
-- 049: Contact opt-out (WhatsApp "SAIR" keyword)
--
-- Why:
--   Templates carry an opt-out footer ("responda SAIR para
--   descadastrar"), and an automation now tags + flags contacts who
--   reply with that keyword (see seed_optout_keyword below). Until now
--   there was no durable, global record of that — exclusion only
--   happened if the operator remembered to add the tag to
--   `excludeTagIds` / `p_exclude_tag_ids` on every future campaign, and
--   even that couldn't protect a campaign whose `broadcast_recipients`
--   were already snapshotted before the contact opted out.
--
--   This adds a real `contacts.opted_out` flag, bakes it into the
--   audience builder (audience_rows) so it can never be forgotten, and
--   the drip route (src/app/api/broadcasts/drip/route.ts) separately
--   skips any already-queued recipient who opted out after their
--   campaign was created.
--
-- IMPORTANT: this CREATE OR REPLACEs the exact post-046 signatures
-- (the ones including p_not_contacted_days). 046 itself added that
-- param without dropping the pre-046 signatures first, which left two
-- live overloads of each function and made every call ambiguous
-- (fixed once already in 048). Keep the full param list here identical
-- to 046's or the same bug reappears.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN contacts.opted_out IS
  'Set by the "SAIR" keyword automation (or manually). Excluded from audience_rows and skipped by the broadcast drip even if already queued in an in-flight campaign.';

-- ── audience_rows ────────────────────────────────────────────────────────────
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
  p_exclude_tag_ids    UUID[]  DEFAULT NULL,
  p_not_contacted_days INT     DEFAULT NULL
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
    AND c.opted_out = FALSE
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
    AND (p_first_order_after IS NULL OR NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.contact_id = r.contact_id
        AND regexp_replace(o.status, '^wc-', '') IN ('processing','completed','enviado','separacao')
        AND o.ordered_at < p_first_order_after
    ))
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
    ))
    AND (p_not_contacted_days IS NULL OR NOT EXISTS (
      SELECT 1
      FROM broadcast_recipients br
      JOIN broadcasts b ON b.id = br.broadcast_id
      WHERE br.contact_id = r.contact_id
        AND b.user_id = p_user_id
        AND br.sent_at >= NOW() - (p_not_contacted_days || ' days')::INTERVAL
    ));
$$ LANGUAGE sql STABLE;

-- ── count_audience ────────────────────────────────────────────────────────────
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
  p_exclude_tag_ids    UUID[]  DEFAULT NULL,
  p_not_contacted_days INT     DEFAULT NULL
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
    p_include_tag_ids, p_exclude_tag_ids, p_not_contacted_days
  ));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ── list_audience ─────────────────────────────────────────────────────────────
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
  p_not_contacted_days INT     DEFAULT NULL,
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
      p_include_tag_ids, p_exclude_tag_ids, p_not_contacted_days
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

-- ── create_audience_campaign ──────────────────────────────────────────────────
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
  p_exclude_tag_ids    UUID[]  DEFAULT NULL,
  p_not_contacted_days INT     DEFAULT NULL
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
    p_include_tag_ids, p_exclude_tag_ids, p_not_contacted_days
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
      p_include_tag_ids, p_exclude_tag_ids, p_not_contacted_days
    ) a
  ) t
  WHERE t.rn <= v_cap;

  GET DIAGNOSTICS v_total = ROW_COUNT;
  UPDATE broadcasts SET total_recipients = v_total WHERE id = v_broadcast_id;

  RETURN QUERY SELECT v_broadcast_id, v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Seed: "SAIR" keyword automation
--
--   SELECT * FROM seed_optout_keyword('<user-uuid>');
--
-- Tags the contact (for visibility/manual review in the UI) AND sets
-- contacts.opted_out = true (the actual enforcement mechanism, checked
-- by audience_rows above and by the drip route at send-time). Fires on
-- ANY inbound message containing "sair" (case-insensitive, contains —
-- catches "SAIR", "Sair", "quero sair", etc.), matching the opt-out
-- footer already used on Marketing templates ("responda SAIR para
-- descadastrar").
-- ============================================================

CREATE OR REPLACE FUNCTION seed_optout_keyword(p_user_id UUID)
RETURNS TABLE(item_name TEXT, item_type TEXT, action TEXT) AS $$
DECLARE
  v_tag_id UUID;
  v_auto_id UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  SELECT id INTO v_tag_id FROM tags
  WHERE user_id = p_user_id AND name = '🚫 Descadastrado (SAIR)'
  LIMIT 1;

  IF v_tag_id IS NULL THEN
    INSERT INTO tags (user_id, name, color)
    VALUES (p_user_id, '🚫 Descadastrado (SAIR)', '#6b7280')
    RETURNING id INTO v_tag_id;
  END IF;

  item_name := '🚫 Descadastrado (SAIR)';
  item_type := 'Tag';
  action := 'seeded';
  RETURN NEXT;

  DELETE FROM automations
  WHERE user_id = p_user_id AND name = 'Opt-out - SAIR';

  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'Opt-out - SAIR',
    'Contato que responde SAIR é marcado como descadastrado e some de futuras campanhas.',
    'keyword_match',
    jsonb_build_object(
      'keywords', jsonb_build_array('sair'),
      'match_type', 'contains',
      'case_sensitive', false
    ),
    TRUE
  ) RETURNING id INTO v_auto_id;

  INSERT INTO automation_steps (automation_id, step_type, step_config, position)
  VALUES
    (v_auto_id, 'add_tag', jsonb_build_object('tag_id', v_tag_id), 0),
    (v_auto_id, 'update_contact_field',
      jsonb_build_object('field', 'opted_out', 'value', true), 1);

  item_name := 'Opt-out - SAIR';
  item_type := 'Automation';
  action := 'created (Active)';
  RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION seed_optout_keyword(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION seed_optout_keyword(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION seed_optout_keyword(UUID) IS
  'Seeds the tag + active keyword_match automation that marks a contact opted_out=true when they reply "sair". Idempotent.';
