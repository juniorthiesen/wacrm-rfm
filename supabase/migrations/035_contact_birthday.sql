-- ============================================================
-- 035: Contact birthday + daily "birthday" automation trigger
--
-- Why:
--   Stores want to greet customers on their birthday. The data arrives
--   from the WooCommerce checkout (billing / meta_data), but there was
--   nowhere structured to keep it and nothing to fire on the day.
--
-- What this adds:
--   contacts.birthday              — the date of birth (year is stored
--                                    when known but never used for
--                                    matching; the cron compares month +
--                                    day only).
--   contacts.last_birthday_greeting — dedupe marker so the daily cron
--                                    greets each contact at most once per
--                                    year, even if it runs multiple times
--                                    a day (Vercel Cron + external pinger).
--   birthday_contacts_today()      — returns today's not-yet-greeted
--                                    birthday contacts for a tenant. The
--                                    cron then claims each row with a
--                                    conditional UPDATE before dispatching,
--                                    so an overlapping run never double-
--                                    sends and a timeout never burns a
--                                    birthday (unsent rows stay unclaimed).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS birthday DATE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_birthday_greeting DATE;

-- The daily scan filters by (month, day); index that expression so it
-- doesn't degrade to a full table scan as the contact base grows.
CREATE INDEX IF NOT EXISTS idx_contacts_birthday_md
  ON contacts (
    user_id,
    (EXTRACT(MONTH FROM birthday)),
    (EXTRACT(DAY FROM birthday))
  )
  WHERE birthday IS NOT NULL;

CREATE OR REPLACE FUNCTION birthday_contacts_today(
  p_user_id UUID,
  p_today DATE,
  p_limit INT DEFAULT 500
)
RETURNS TABLE(contact_id UUID, contact_name TEXT, contact_phone TEXT) AS $$
BEGIN
  -- Defense in depth: an authenticated caller may only read their own.
  -- The cron uses the service role (auth.uid() IS NULL) and is allowed.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.phone
  FROM contacts c
  WHERE c.user_id = p_user_id
    AND c.birthday IS NOT NULL
    AND EXTRACT(MONTH FROM c.birthday) = EXTRACT(MONTH FROM p_today)
    AND EXTRACT(DAY FROM c.birthday) = EXTRACT(DAY FROM p_today)
    AND (
      c.last_birthday_greeting IS NULL
      OR c.last_birthday_greeting < p_today
    )
  ORDER BY c.id
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION birthday_contacts_today(UUID, DATE, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION birthday_contacts_today(UUID, DATE, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION birthday_contacts_today(UUID, DATE, INT) IS
  'Returns a tenant''s birthday contacts for p_today (matched on month+day) that have not yet been greeted today. The caller claims each row before sending so the greeting fires at most once.';
