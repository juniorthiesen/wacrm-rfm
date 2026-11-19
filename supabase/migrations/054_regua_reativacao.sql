-- ============================================================
-- 054: Régua de reativação (phase 2 of docs/handoff-email-channel.md)
--
-- Adds what a "N days without buying" sequence needs that did not exist:
--   1. automation_enrollments — who entered which automation, when, in which
--      cohort (treatment | control) and which coupon they received. UNIQUE on
--      (automation_id, email): a person enters a régua ONCE, even if the CRM
--      holds several contacts with the same e-mail (Woo imports do).
--   2. recency_candidates()        — contacts that are in the recency window,
--      have a usable e-mail, did not opt out, are not suppressed and are not
--      yet enrolled. De-duplicated by e-mail, most recent first.
--   3. recency_candidates_count()  — same filter, count only (dry run).
--   4. regua_report()              — treatment vs control: enrolled, converted,
--      orders, revenue within a window after enrollment.
--   5. An index so the report can match orders by e-mail.
--
-- All additive. Depends on 049 (contacts.opted_out) and 053 (email_suppressions).
-- The three functions take a tenant id as a parameter, so they are NOT
-- callable by anon/authenticated users (they would bypass RLS): only the
-- service role (cron + API routes) may execute them.
-- ============================================================

-- ── 1. enrollments ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automation_enrollments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- lower-cased + trimmed; the identity of the person for this automation
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  -- control = enrolled for measurement but NEVER contacted
  cohort TEXT NOT NULL CHECK (cohort IN ('treatment', 'control')),
  recency_days INTEGER,
  coupon_code TEXT,
  coupon_created_at TIMESTAMPTZ,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (automation_id, email)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_automation_time
  ON automation_enrollments (automation_id, enrolled_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollments_user
  ON automation_enrollments (user_id);

ALTER TABLE automation_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own enrollments" ON automation_enrollments;
CREATE POLICY "Users can view own enrollments"
  ON automation_enrollments FOR SELECT
  USING (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policy on purpose: only the service role writes.

-- ── 2. candidates ───────────────────────────────────────────
DROP FUNCTION IF EXISTS recency_candidates(UUID, UUID, INT, INT, INT);
CREATE FUNCTION recency_candidates(
  p_user_id       UUID,
  p_automation_id UUID,
  p_min_days      INT,
  p_max_days      INT,
  p_limit         INT
)
RETURNS TABLE (contact_id UUID, contact_name TEXT, contact_email TEXT, recency_days INT)
LANGUAGE sql STABLE AS $$
  SELECT picked.contact_id, picked.contact_name, picked.contact_email, picked.recency_days
  FROM (
    SELECT DISTINCT ON (lower(btrim(c.email)))
      c.id                  AS contact_id,
      c.name                AS contact_name,
      lower(btrim(c.email)) AS contact_email,
      m.recency_days        AS recency_days
    FROM contact_rfm_metrics m
    JOIN contacts c ON c.id = m.contact_id
    WHERE m.user_id = p_user_id
      AND c.user_id = p_user_id
      AND m.recency_days BETWEEN p_min_days AND p_max_days
      AND c.email IS NOT NULL
      AND btrim(c.email) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      AND c.opted_out = FALSE
      AND NOT EXISTS (
        SELECT 1 FROM email_suppressions s
        WHERE s.user_id = p_user_id AND s.email = lower(btrim(c.email))
      )
      AND NOT EXISTS (
        SELECT 1 FROM automation_enrollments e
        WHERE e.automation_id = p_automation_id AND e.email = lower(btrim(c.email))
      )
      -- The RFM snapshot is recalculated once a day, so recency_days can be stale:
      -- never pick someone with a paid order inside the window, even if the
      -- snapshot still says "lapsed" (a customer who bought this morning must
      -- not receive "we miss you").
      AND NOT EXISTS (
        SELECT 1 FROM orders o
        WHERE o.user_id = p_user_id
          AND (o.contact_id = c.id OR lower(o.customer_email) = lower(btrim(c.email)))
          AND regexp_replace(o.status, '^wc-', '') IN ('processing', 'completed', 'enviado', 'separacao')
          AND o.ordered_at > now() - make_interval(days => p_min_days)
      )
    ORDER BY lower(btrim(c.email)), m.recency_days ASC
  ) picked
  ORDER BY picked.recency_days ASC, picked.contact_email
  LIMIT p_limit
$$;

-- ── 3. candidate count (dry run) ────────────────────────────
DROP FUNCTION IF EXISTS recency_candidates_count(UUID, UUID, INT, INT);
CREATE FUNCTION recency_candidates_count(
  p_user_id       UUID,
  p_automation_id UUID,
  p_min_days      INT,
  p_max_days      INT
)
RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT count(DISTINCT lower(btrim(c.email)))
  FROM contact_rfm_metrics m
  JOIN contacts c ON c.id = m.contact_id
  WHERE m.user_id = p_user_id
    AND c.user_id = p_user_id
    AND m.recency_days BETWEEN p_min_days AND p_max_days
    AND c.email IS NOT NULL
    AND btrim(c.email) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    AND c.opted_out = FALSE
    AND NOT EXISTS (
      SELECT 1 FROM email_suppressions s
      WHERE s.user_id = p_user_id AND s.email = lower(btrim(c.email))
    )
    AND NOT EXISTS (
      SELECT 1 FROM automation_enrollments e
      WHERE e.automation_id = p_automation_id AND e.email = lower(btrim(c.email))
    )
    -- same stale-snapshot guard as recency_candidates()
    AND NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.user_id = p_user_id
        AND (o.contact_id = c.id OR lower(o.customer_email) = lower(btrim(c.email)))
        AND regexp_replace(o.status, '^wc-', '') IN ('processing', 'completed', 'enviado', 'separacao')
        AND o.ordered_at > now() - make_interval(days => p_min_days)
    )
$$;

-- ── 4. report: treatment vs control ─────────────────────────
-- A purchase counts when it is a paid order (same status set as the RFM,
-- migration 030) placed AFTER enrollment and within p_window_days. Orders are
-- matched by contact OR by e-mail (the same person can have several contacts).
-- `matured` = enrollments whose window has fully elapsed: until it equals
-- `enrolled`, conversion is still accruing and should be read as a floor.
DROP FUNCTION IF EXISTS regua_report(UUID, INT);
CREATE FUNCTION regua_report(p_automation_id UUID, p_window_days INT)
RETURNS TABLE (
  cohort       TEXT,
  enrolled     BIGINT,
  matured      BIGINT,
  converted    BIGINT,
  orders_count BIGINT,
  revenue      NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    e.cohort,
    count(*)                                                               AS enrolled,
    count(*) FILTER (WHERE e.enrolled_at + make_interval(days => p_window_days) <= now()) AS matured,
    count(*) FILTER (WHERE s.orders_count > 0)                             AS converted,
    coalesce(sum(s.orders_count), 0)::BIGINT                               AS orders_count,
    coalesce(sum(s.revenue), 0)                                            AS revenue
  FROM automation_enrollments e
  LEFT JOIN LATERAL (
    SELECT count(*) AS orders_count, coalesce(sum(o.total_amount), 0) AS revenue
    FROM orders o
    WHERE o.user_id = e.user_id
      AND (o.contact_id = e.contact_id OR lower(o.customer_email) = e.email)
      AND regexp_replace(o.status, '^wc-', '') IN ('processing', 'completed', 'enviado', 'separacao')
      AND o.ordered_at >  e.enrolled_at
      AND o.ordered_at <= e.enrolled_at + make_interval(days => p_window_days)
  ) s ON TRUE
  WHERE e.automation_id = p_automation_id
  GROUP BY e.cohort
$$;

-- ── 5. index for the e-mail match in the report ─────────────
CREATE INDEX IF NOT EXISTS idx_orders_user_email_lower
  ON orders (user_id, lower(customer_email))
  WHERE customer_email IS NOT NULL;

-- ── permissions: service role only ──────────────────────────
REVOKE ALL ON FUNCTION recency_candidates(UUID, UUID, INT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION recency_candidates_count(UUID, UUID, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION regua_report(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION recency_candidates(UUID, UUID, INT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION recency_candidates_count(UUID, UUID, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION regua_report(UUID, INT) TO service_role;
