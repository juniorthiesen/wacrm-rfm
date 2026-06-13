-- ============================================================
-- 026: Indexed phone matching for inbound contact resolution
--
-- Why:
--   The WhatsApp webhook's findOrCreateContact loaded every contact
--   for the tenant with a plain select (capped at 1000 rows by
--   PostgREST) and matched phones in memory with phonesMatch(). Once a
--   tenant passed 1000 contacts — e.g. after a multi-year WooCommerce
--   backfill — the webhook stopped seeing the existing contact for an
--   inbound message and created a duplicate (a WhatsApp-profile contact
--   beside the WooCommerce one), splitting the conversation thread: the
--   sent template stayed on one contact, the customer's reply landed on
--   the other.
--
--   This function reproduces phonesMatch's "last 8 digits" rule set-
--   based in Postgres, against ALL contacts, backed by a functional
--   index so it stays an index lookup at any table size. Returns the
--   oldest matching contact so repeated calls converge on the original
--   row rather than a later duplicate.
-- ============================================================

-- Functional index on the normalized last 8 digits of phone. Matches
-- the expression used in the function below so the lookup is indexed.
CREATE INDEX IF NOT EXISTS idx_contacts_phone_last8
  ON contacts (user_id, (right(regexp_replace(phone, '\D', '', 'g'), 8)));

CREATE OR REPLACE FUNCTION find_contact_id_by_phone(p_user_id UUID, p_phone TEXT)
RETURNS UUID AS $$
  SELECT id
  FROM contacts
  WHERE user_id = p_user_id
    -- Guard: ignore inputs with fewer than 8 digits so a short/garbage
    -- number can't right-match an unrelated contact.
    AND length(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g')) >= 8
    AND right(regexp_replace(phone, '\D', '', 'g'), 8)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 8)
  ORDER BY created_at ASC
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION find_contact_id_by_phone(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION find_contact_id_by_phone(UUID, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION find_contact_id_by_phone(UUID, TEXT) IS
  'Returns the oldest contact for the tenant whose phone matches p_phone on the last 8 digits (mirrors phonesMatch). Indexed by idx_contacts_phone_last8. Replaces an in-app scan that capped at 1000 contacts and created duplicate contacts past that.';
