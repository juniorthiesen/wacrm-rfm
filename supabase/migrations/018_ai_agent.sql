-- ============================================================
-- 018_ai_agent.sql — AI Agent (Copiloto)
--
-- Fase 1 (MVP): foundation only.
--   - One configurable agent per user (workspace single-tenant).
--   - Encrypted provider API key (OpenRouter first; provider column
--     lets us add OpenAI/Anthropic/Gemini later without a new table).
--   - Knowledge base entries with pgvector embeddings (1536 dims —
--     matches OpenAI text-embedding-3-small and Gemini embedding-001
--     when truncated; both flow through OpenRouter today).
--   - Learning queue for facts extracted from human-handled
--     conversations, requires explicit approval before promotion.
--   - Run log for debugging/cost tracking.
--
-- Idempotent — IF NOT EXISTS on everything, DROP IF EXISTS before
-- (re)creating policies/triggers. Same convention as 001/006/015.
-- ============================================================

-- pgvector ships with Supabase. Enable in the `extensions` schema (the
-- Supabase-default location) if it isn't already.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- ============================================================
-- AI_AGENTS
--
-- One row per user for now. We intentionally don't enforce
-- UNIQUE(user_id) — leaving the door open for "rascunho" / per-channel
-- agents later — but the UI surfaces a single active one via
-- `is_active`.
--
-- `provider`     — 'openrouter' for now. Add 'openai'/'anthropic'/
--                  'gemini' later without a schema change.
-- `model`        — provider-namespaced id (e.g. 'openai/gpt-4o-mini',
--                  'anthropic/claude-3.5-haiku'). Free-form string;
--                  we don't enumerate models in the DB so new ones
--                  are usable the moment OpenRouter exposes them.
-- `temperature`  — 0..2 (OpenRouter accepts the OpenAI range).
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Agente IA',
  provider TEXT NOT NULL DEFAULT 'openrouter'
    CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'gemini')),
  model TEXT NOT NULL DEFAULT 'openai/gpt-4o-mini',
  system_prompt TEXT NOT NULL DEFAULT '',
  temperature NUMERIC(3, 2) NOT NULL DEFAULT 0.30
    CHECK (temperature >= 0 AND temperature <= 2),
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_user ON ai_agents(user_id);

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own AI agents" ON ai_agents;
CREATE POLICY "Users can manage own AI agents" ON ai_agents FOR ALL
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON ai_agents;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- AI_PROVIDER_KEYS
--
-- Separate table from ai_agents because (1) keys are workspace-wide
-- credentials reusable across multiple agents, (2) they have a
-- different security posture — we never SELECT the encrypted column
-- back to the browser, and the panel only checks `has_key`.
--
-- `encrypted_key` — output of lib/whatsapp/encryption.encrypt()
--                   (AES-256-GCM `iv:ct:tag`). Reuses ENCRYPTION_KEY.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_provider_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL
    CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'gemini')),
  encrypted_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

ALTER TABLE ai_provider_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own provider keys" ON ai_provider_keys;
CREATE POLICY "Users can manage own provider keys" ON ai_provider_keys FOR ALL
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON ai_provider_keys;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_provider_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- AI_KNOWLEDGE_ENTRIES
--
-- Curated knowledge base. Vector column is nullable so a row can be
-- inserted before embeddings finish computing (async path); the
-- retrieval query filters `embedding IS NOT NULL`.
--
-- `source` — provenance, useful for UI badges and for excluding
--            certain sources from retrieval later.
-- `status` — 'active' is searchable, 'archived' is kept for audit.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_knowledge_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'learned', 'document', 'url')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  embedding extensions.vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_kb_user ON ai_knowledge_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_kb_agent ON ai_knowledge_entries(agent_id);
-- IVFFlat index for cosine similarity. `lists` tuned for small KBs;
-- bump when the table grows past ~10k rows. Wrapped in a DO block
-- because IVFFlat requires the column to have data to build well —
-- on an empty table this still succeeds, the index just doesn't help
-- until vectors exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_ai_kb_embedding'
  ) THEN
    CREATE INDEX idx_ai_kb_embedding
      ON ai_knowledge_entries
      USING ivfflat (embedding extensions.vector_cosine_ops)
      WITH (lists = 100);
  END IF;
END$$;

ALTER TABLE ai_knowledge_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own KB entries" ON ai_knowledge_entries;
CREATE POLICY "Users can manage own KB entries" ON ai_knowledge_entries FOR ALL
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON ai_knowledge_entries;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- AI_LEARNING_QUEUE
--
-- Candidates extracted from agent-handled conversations (typically
-- after a human reply that taught the bot something new). The user
-- approves or rejects; on approval, a row is created in
-- ai_knowledge_entries with source='learned'.
--
-- We deliberately don't reference messages.id here — message storage
-- shapes vary across the codebase and we'd rather denormalise the
-- snippet than couple to it. Add a FK later if the message schema
-- stabilises.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_learning_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  source_excerpt TEXT,
  suggested_title TEXT NOT NULL,
  suggested_content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  knowledge_entry_id UUID REFERENCES ai_knowledge_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_learning_queue_user_status
  ON ai_learning_queue(user_id, status, created_at DESC);

ALTER TABLE ai_learning_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own learning queue" ON ai_learning_queue;
CREATE POLICY "Users can manage own learning queue" ON ai_learning_queue FOR ALL
  USING (auth.uid() = user_id);

-- ============================================================
-- AI_AGENT_RUNS
--
-- Per-invocation audit log. Keeps token counts and latency so we can
-- expose cost dashboards later. `input`/`output` are stored as plain
-- text — these are conversation snippets the user already has access
-- to elsewhere, no extra sensitivity.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'success'
    CHECK (status IN ('success', 'error')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_user_created
  ON ai_agent_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_agent
  ON ai_agent_runs(agent_id, created_at DESC);

ALTER TABLE ai_agent_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own AI runs" ON ai_agent_runs;
CREATE POLICY "Users can view own AI runs" ON ai_agent_runs FOR ALL
  USING (auth.uid() = user_id);
