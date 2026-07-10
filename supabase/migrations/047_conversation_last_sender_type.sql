-- Denormalizes the last message's sender_type onto conversations so the
-- inbox list can filter out campaign/automation noise (last_message_sender_type
-- = 'bot') without an N+1 lookup into messages per row. Mirrors the existing
-- last_message_text / last_message_at denormalization pattern.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_sender_type TEXT
    CHECK (last_message_sender_type IN ('customer', 'agent', 'bot'));

-- Backfill from each conversation's most recent message.
UPDATE conversations c
SET last_message_sender_type = m.sender_type
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, sender_type
  FROM messages
  ORDER BY conversation_id, created_at DESC
) m
WHERE m.conversation_id = c.id
  AND c.last_message_sender_type IS NULL;
