-- ============================================================
-- 041: Concurrency-safe recipient claiming for the broadcast drip
--
-- The drip picked pending recipients with a plain
--   SELECT ... WHERE status='pending' ORDER BY rank LIMIT n
-- and only flipped them to 'sent' AFTER the Meta call. Two overlapping
-- drip runs (a manual trigger crossing the hourly worker, or rapid
-- manual pings) therefore grabbed the SAME pending rows and sent the
-- template to those contacts MORE THAN ONCE — exactly what happened to
-- the "Reativação - 10%" campaign (Meta billed 646 sends for 384
-- distinct recipients).
--
-- Fix: claim a batch atomically with FOR UPDATE SKIP LOCKED so two
-- concurrent runs can never select the same rows. We mark a `claimed_at`
-- timestamp (the status CHECK doesn't allow an extra 'processing' value)
-- and only hand back rows that are unclaimed or whose claim is stale
-- (>10 min, i.e. a crashed run) so nothing gets permanently stuck.
-- ============================================================

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Keep the claim scan cheap: only pending rows matter.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_claim
  ON broadcast_recipients (broadcast_id, rank)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION claim_broadcast_recipients(
  p_broadcast_id UUID,
  p_limit        INT
)
RETURNS TABLE(id UUID, contact_id UUID) AS $$
  UPDATE broadcast_recipients br
  SET claimed_at = now()
  WHERE br.id IN (
    SELECT r.id
    FROM broadcast_recipients r
    WHERE r.broadcast_id = p_broadcast_id
      AND r.status = 'pending'
      AND (r.claimed_at IS NULL OR r.claimed_at < now() - INTERVAL '10 minutes')
    ORDER BY r.rank ASC NULLS LAST
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING br.id, br.contact_id;
$$ LANGUAGE sql;

REVOKE ALL ON FUNCTION claim_broadcast_recipients(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_broadcast_recipients(UUID, INT) TO service_role;

COMMENT ON FUNCTION claim_broadcast_recipients(UUID, INT) IS
  'Atomically claims up to p_limit pending recipients of a broadcast (FOR UPDATE SKIP LOCKED + claimed_at marker) so concurrent drip runs never send to the same contact twice. Stale claims (>10 min) are reclaimable.';
