-- ============================================================
-- 050: find_reply_pairs — set-based pairing for batch KB mining
--
-- Why:
--   The AI knowledge extractor (lib/ai/learning.ts) only ever ran on
--   one (customer question, human reply) pair at a time, picked
--   manually by an operator. To backfill the knowledge base from the
--   whole conversation history we need to find every such pair at
--   once. Doing that pairing in application code against a naive
--   PostgREST select would hit the same 1000-row cap that bit RFM
--   (migration 025) — so this does the pairing set-based in Postgres,
--   same pattern as recalculate_user_rfm / audience_rows.
--
-- Pairing rule: for every 'customer' text message, find the very next
-- message (any sender) in the same conversation. Only keep the pair if
-- that next message is a genuine human-typed reply — sender_type
-- 'agent' (never 'bot': automations/flows/broadcasts/auto-reply all
-- write 'bot'), content_type 'text', and template_name IS NULL (a
-- human can still manually send a template — that's canned text, not
-- an authored answer, so it's excluded too).
--
-- p_since is a plain cursor: pass the largest agent_created_at you
-- received back to continue past it next call. No separate watermark
-- table needed — this is an occasional/manual backfill, not a
-- recurring cron.
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
  SELECT
    conv.contact_id,
    cust.content_text,
    reply.content_text,
    reply.id,
    reply.created_at
  FROM messages cust
  JOIN conversations conv ON conv.id = cust.conversation_id
  JOIN LATERAL (
    SELECT m.id, m.content_text, m.created_at, m.sender_type,
           m.content_type, m.template_name
    FROM messages m
    WHERE m.conversation_id = cust.conversation_id
      AND m.created_at > cust.created_at
    ORDER BY m.created_at ASC
    LIMIT 1
  ) reply ON TRUE
  WHERE conv.user_id = p_user_id
    AND cust.sender_type = 'customer'
    AND cust.content_type = 'text'
    AND cust.content_text IS NOT NULL
    AND reply.sender_type = 'agent'
    AND reply.content_type = 'text'
    AND reply.template_name IS NULL
    AND reply.content_text IS NOT NULL
    AND (p_since IS NULL OR reply.created_at > p_since)
  ORDER BY reply.created_at ASC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION find_reply_pairs(UUID, TIMESTAMPTZ, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION find_reply_pairs(UUID, TIMESTAMPTZ, INT) TO authenticated, service_role;

COMMENT ON FUNCTION find_reply_pairs(UUID, TIMESTAMPTZ, INT) IS
  'Set-based (customer message -> next genuine human text reply) pairing for batch AI knowledge mining. Cursor via p_since/agent_created_at, no separate state table.';
