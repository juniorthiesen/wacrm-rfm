-- ============================================================
-- 021: Conversation window + template fields for Meta submission
--
-- Adds the foundation for the Utility-abridor cost strategy
-- (see docs/whatsapp-cost-strategy.md):
--
-- 1. contacts.conversation_window_until — when the current 24h
--    free-form window closes. Set on every inbound (text or
--    button tap). NULL means no window has ever opened, or the
--    last one expired.
--
-- 2. message_templates extensions needed to submit to Meta:
--    - body_example: sample values for body {{1}} {{2}} ...
--    - meta_template_id: id Meta returns on POST /message_templates
--    - last_synced_at: tracks Utility→Marketing reclassification
--    - rejection_reason: human-readable reason when Meta rejects
-- ============================================================

-- 1. Conversation window
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS conversation_window_until TIMESTAMPTZ;

COMMENT ON COLUMN contacts.conversation_window_until IS
  'When the current Meta 24h free-form window closes. Updated by the webhook on any inbound. NULL = no open window.';

-- Partial index so the "who has an open window right now?" query
-- (used by the broadcast smart sender) stays fast as the contacts
-- table grows. Includes user_id so per-user scans use it.
CREATE INDEX IF NOT EXISTS idx_contacts_window_open
  ON contacts(user_id, conversation_window_until)
  WHERE conversation_window_until IS NOT NULL;

-- 2. message_templates extensions
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS body_example JSONB,
  ADD COLUMN IF NOT EXISTS meta_template_id TEXT,
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

COMMENT ON COLUMN message_templates.body_example IS
  'Sample values for body variables, e.g. {"body_text": [["Mariana", "23/06"]]}. Required by Meta on submission.';
COMMENT ON COLUMN message_templates.meta_template_id IS
  'Id Meta returns when we POST the template for approval. NULL = never submitted.';
COMMENT ON COLUMN message_templates.last_synced_at IS
  'Last time we pulled this template from Meta. Used to surface Utility→Marketing reclassification.';
COMMENT ON COLUMN message_templates.rejection_reason IS
  'Human-readable rejection reason from Meta. Cleared on next successful submit.';

-- 3. Lookup index for the smart sender — finding the latest
--    customer-sent message id when building a free-form reply.
--    Already covered by messages indexes? Check before adding:
CREATE INDEX IF NOT EXISTS idx_messages_conversation_customer_recent
  ON messages(conversation_id, sender_type, created_at DESC)
  WHERE sender_type = 'customer';
