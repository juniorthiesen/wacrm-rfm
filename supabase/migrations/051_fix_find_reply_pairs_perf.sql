-- ============================================================
-- 051: Fix find_reply_pairs performance (504 in production)
--
-- Why:
--   050's implementation used a correlated LATERAL subquery per
--   customer-message row ("find the next message in this conversation")
--   with no supporting composite index. On a real production history
--   this degrades badly — effectively a per-row scan of messages in
--   the same conversation for every candidate row — and the batch
--   mining endpoint (/api/ai/learning-queue/mine-batch) hit a 504
--   FUNCTION_INVOCATION_TIMEOUT on its very first call (2026-09-01).
--
--   LEAD() computes "the next row's value" for every row in ONE sorted
--   pass per partition (conversation_id) instead of one subquery per
--   row — the standard, efficient idiom for this exact access pattern.
--
-- CREATE OR REPLACE with the EXACT same signature as 050 so this
-- replaces it in place rather than creating a second overload (that
-- exact mistake — adding a param without matching the old signature —
-- is what caused the ambiguous-function bug fixed in 048).
-- ============================================================

CREATE OR REPLACE FUNCTION find_reply_pairs(
  p_user_id UUID,
  p_since   TIMESTAMPTZ DEFAULT NULL,
  p_limit   INT DEFAULT 50
)
RETURNS TABLE(
  contact_id       UUID,
  customer_text    TEXT,
  agent_text       TEXT,
  agent_message_id UUID,
  agent_created_at TIMESTAMPTZ
) AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  WITH ranked AS (
    SELECT
      m.conversation_id,
      m.sender_type,
      m.content_type,
      m.content_text,
      m.created_at,
      LEAD(m.sender_type)   OVER w AS next_sender_type,
      LEAD(m.content_type)  OVER w AS next_content_type,
      LEAD(m.content_text)  OVER w AS next_content_text,
      LEAD(m.template_name) OVER w AS next_template_name,
      LEAD(m.id)            OVER w AS next_id,
      LEAD(m.created_at)    OVER w AS next_created_at
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    WHERE conv.user_id = p_user_id
    WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at)
  )
  SELECT
    conv.contact_id,
    r.content_text,
    r.next_content_text,
    r.next_id,
    r.next_created_at
  FROM ranked r
  JOIN conversations conv ON conv.id = r.conversation_id
  WHERE r.sender_type = 'customer'
    AND r.content_type = 'text'
    AND r.content_text IS NOT NULL
    AND r.next_sender_type = 'agent'
    AND r.next_content_type = 'text'
    AND r.next_template_name IS NULL
    AND r.next_content_text IS NOT NULL
    AND (p_since IS NULL OR r.next_created_at > p_since)
  ORDER BY r.next_created_at ASC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Supports both the window-function scan above and any other query
-- that needs "messages in a conversation in time order" — cheap to
-- add, only helps.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

REVOKE ALL ON FUNCTION find_reply_pairs(UUID, TIMESTAMPTZ, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION find_reply_pairs(UUID, TIMESTAMPTZ, INT) TO authenticated, service_role;
