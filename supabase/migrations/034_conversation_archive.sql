-- ============================================================
-- 034: Archive (hide) conversations
--
-- Adds conversations.archived_at so agents can hide a thread from the
-- inbox without deleting its history. NULL = active; a timestamp =
-- archived (filtered out of the default list). A new inbound message
-- clears it (see the WhatsApp webhook) so a customer coming back
-- resurfaces the thread. "Delete" remains a separate hard delete from
-- the UI for spam/test threads.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Partial index for the default list query (active threads of a user).
CREATE INDEX IF NOT EXISTS idx_conversations_active
  ON conversations (user_id, last_message_at DESC)
  WHERE archived_at IS NULL;
