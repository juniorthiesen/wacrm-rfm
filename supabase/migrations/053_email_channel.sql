-- ============================================================
-- 053: Email channel foundation (phase 0 + 1 of the email/régua work)
--
-- Why:
--   WaCRM was WhatsApp-only. The reactivation "régua" (and cart/welcome
--   flows) need e-mail: ~R$ 0.00x per send vs ~R$ 0.30 for a WhatsApp
--   marketing template. See docs/handoff-email-channel.md.
--
-- What this adds (all additive; nothing existing is dropped or rewritten):
--   1. contacts.phone becomes nullable, so a footer-signup contact that
--      only has an e-mail can exist. There was never a UNIQUE on phone
--      (only an index), so no data change is needed.
--   2. A NON-unique index on (user_id, lower(email)). Uniqueness is
--      deliberately NOT enforced here: the Woo import can already hold
--      duplicate e-mails and a UNIQUE index would fail to build. De-dupe
--      first, then upgrade to UNIQUE in a later migration.
--   3. email_config      — per-tenant sender settings + encrypted keys.
--   4. email_suppressions — durable "never e-mail this address" list,
--      keyed by (user_id, email) rather than contact_id because a
--      signup may not be a contact yet.
--   5. email_messages    — one row per send attempt (audit log, daily
--      limit, marketing frequency cap, reporting).
--
-- Rollout notes:
--   * Safe to apply before the code ships: nothing reads these tables
--     until the e-mail code is deployed.
--   * contacts.phone nullable: WhatsApp code paths must guard against a
--     null phone (done in the same change set on the TS side).
--   * RLS follows the existing per-user pattern (auth.uid() = user_id).
--     The send path runs with the service role and bypasses RLS.
-- ============================================================

-- ── 1. contacts: phone optional ─────────────────────────────
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

COMMENT ON COLUMN contacts.phone IS
  'WhatsApp number. NULL for e-mail-only contacts (e.g. footer newsletter signups). WhatsApp sends must skip contacts without a phone.';

-- ── 2. contacts: e-mail lookup index (non-unique on purpose) ─
CREATE INDEX IF NOT EXISTS idx_contacts_user_email_lower
  ON contacts (user_id, lower(email))
  WHERE email IS NOT NULL AND email <> '';

-- ── 3. email_config ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'resend' CHECK (provider IN ('resend')),
  -- AES-256-GCM via src/lib/whatsapp/encryption.ts (same key as WhatsApp tokens).
  api_key_encrypted TEXT,
  -- Svix signing secret ("whsec_...") for the provider webhook, encrypted.
  webhook_secret_encrypted TEXT,
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  reply_to TEXT,
  -- Max e-mails sent per local day (America/Sao_Paulo) across all automations.
  -- Start low while the sending domain warms up.
  daily_limit INTEGER NOT NULL DEFAULT 150 CHECK (daily_limit >= 0),
  -- Minimum days between two MARKETING e-mails to the same address,
  -- summed over every automation/campaign. 0 disables the cap.
  marketing_min_gap_days INTEGER NOT NULL DEFAULT 3 CHECK (marketing_min_gap_days >= 0),
  -- Visual identity used by src/lib/email/layout.ts:
  -- { "logo_url": "...", "accent": "#087f58", "ink": "#111111", "footer_note": "..." }
  brand JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE email_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own email config" ON email_config;
CREATE POLICY "Users can manage own email config"
  ON email_config FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON email_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON email_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 4. email_suppressions ───────────────────────────────────
CREATE TABLE IF NOT EXISTS email_suppressions (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Always stored lower-cased and trimmed.
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'manual')),
  -- link | one_click | provider_webhook | admin
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, email)
);

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own email suppressions" ON email_suppressions;
CREATE POLICY "Users can manage own email suppressions"
  ON email_suppressions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── 5. email_messages ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  automation_id UUID REFERENCES automations(id) ON DELETE SET NULL,
  -- Free-form tag for reporting, e.g. 'reativacao_d97'.
  campaign_key TEXT,
  to_email TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'marketing' CHECK (category IN ('marketing', 'transactional')),
  subject TEXT NOT NULL,
  -- queued → sent → delivered | bounced | complained
  -- failed     = provider/transport error
  -- suppressed = address is on email_suppressions
  -- skipped    = blocked by a limit (daily cap / marketing frequency cap)
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'skipped')),
  skip_reason TEXT,
  provider_message_id TEXT,
  error TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Listing / reporting per tenant.
CREATE INDEX IF NOT EXISTS idx_email_messages_user_created
  ON email_messages (user_id, created_at DESC);

-- Marketing frequency cap: "last marketing send to this address".
-- to_email is ALWAYS stored lower-cased by src/lib/email/send.ts, and the
-- query compares it with = (no lower()), so a plain column index is the one
-- the planner can use.
CREATE INDEX IF NOT EXISTS idx_email_messages_user_to_sent
  ON email_messages (user_id, to_email, sent_at DESC)
  WHERE sent_at IS NOT NULL;

-- Daily marketing cap: "marketing mails sent since local midnight".
CREATE INDEX IF NOT EXISTS idx_email_messages_user_category_sent
  ON email_messages (user_id, category, sent_at DESC)
  WHERE sent_at IS NOT NULL;

-- Webhook correlation (provider events arrive keyed by the provider's id).
CREATE INDEX IF NOT EXISTS idx_email_messages_provider_id
  ON email_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_messages_automation
  ON email_messages (automation_id, created_at DESC)
  WHERE automation_id IS NOT NULL;

ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own email messages" ON email_messages;
CREATE POLICY "Users can manage own email messages"
  ON email_messages FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
