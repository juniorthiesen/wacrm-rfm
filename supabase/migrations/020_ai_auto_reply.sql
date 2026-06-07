-- ============================================================
-- 020_ai_auto_reply.sql — AI auto-reply (Phase 5)
--
-- Adds opt-in auto-reply to ai_agents and an append-only log we use
-- to enforce the daily cap and to debug "why did/didn't the bot
-- reply?" later.
--
-- All idempotent — re-runnable, ALTER TABLE … ADD COLUMN IF NOT
-- EXISTS, DROP POLICY IF EXISTS before CREATE.
-- ============================================================

-- ─── ai_agents: auto-reply settings ─────────────────────────────
ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS auto_reply_threshold NUMERIC(4, 3) NOT NULL DEFAULT 0.55
  CHECK (auto_reply_threshold >= 0 AND auto_reply_threshold <= 1);

-- Best-effort circuit breaker. Even if the threshold is mis-tuned,
-- the worst case is N replies, not unlimited spend.
ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS auto_reply_daily_cap INTEGER NOT NULL DEFAULT 50
  CHECK (auto_reply_daily_cap >= 0 AND auto_reply_daily_cap <= 1000);

-- ─── ai_auto_reply_log ──────────────────────────────────────────
-- One row per auto-reply *decision*. `sent_message_id` is null when
-- the agent declined (threshold not met, daily cap hit, run error,
-- etc.) so we can answer "why didn't it reply?" without trawling
-- ai_agent_runs.
--
-- Service-role only — webhook writes; no user-facing INSERT path.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_auto_reply_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID,
  inbound_text TEXT NOT NULL,
  best_similarity NUMERIC(5, 4),
  outcome TEXT NOT NULL
    CHECK (outcome IN (
      'sent',
      'skipped_disabled',
      'skipped_low_confidence',
      'skipped_cap',
      'skipped_no_kb',
      'skipped_empty_output',
      'error'
    )),
  run_id UUID REFERENCES ai_agent_runs(id) ON DELETE SET NULL,
  sent_message_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_auto_reply_log_user_created
  ON ai_auto_reply_log(user_id, created_at DESC);
-- Hot-path index for the daily-cap check: count sent rows in the
-- current day for a given agent. Partial keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_ai_auto_reply_log_sent_today
  ON ai_auto_reply_log(agent_id, created_at)
  WHERE outcome = 'sent';

ALTER TABLE ai_auto_reply_log ENABLE ROW LEVEL SECURITY;
-- Users can READ their own log rows (useful for a future UI), but
-- inserts only happen via service-role from the webhook.
DROP POLICY IF EXISTS "Users can view own auto-reply log" ON ai_auto_reply_log;
CREATE POLICY "Users can view own auto-reply log" ON ai_auto_reply_log FOR SELECT
  USING (auth.uid() = user_id);

-- ─── match_ai_knowledge_admin ───────────────────────────────────
-- Service-role-callable variant of match_ai_knowledge. Same cosine
-- search, but takes user_id explicitly because the webhook runs
-- without a Supabase auth session (so `auth.uid()` would be NULL).
--
-- Locked down: SECURITY INVOKER + GRANT to service_role only. Anon
-- and authenticated roles cannot call this — they must keep using
-- the auth.uid()-scoped match_ai_knowledge.
-- ============================================================
CREATE OR REPLACE FUNCTION match_ai_knowledge_admin(
  caller_user_id uuid,
  query_embedding extensions.vector(1536),
  match_count int DEFAULT 5,
  match_threshold float DEFAULT 0.0
)
RETURNS TABLE (
  id uuid,
  title text,
  content text,
  source text,
  similarity float
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.title,
    e.content,
    e.source,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM ai_knowledge_entries e
  WHERE e.user_id = caller_user_id
    AND e.status = 'active'
    AND e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

REVOKE ALL ON FUNCTION match_ai_knowledge_admin(uuid, extensions.vector(1536), int, float)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION match_ai_knowledge_admin(uuid, extensions.vector(1536), int, float)
  FROM authenticated;
GRANT EXECUTE
  ON FUNCTION match_ai_knowledge_admin(uuid, extensions.vector(1536), int, float)
  TO service_role;
