-- ============================================================
-- 019_ai_knowledge_search.sql — Similarity search RPC
--
-- Postgres function used by lib/ai/embeddings.ts to retrieve the top-K
-- knowledge entries closest to a query embedding (cosine distance).
--
-- Why an RPC instead of a raw query from the JS client:
--   The Supabase JS client serialises vectors as strings reliably,
--   but the `<=>` operator and ORDER BY tuning are easier to keep
--   correct in SQL. A SECURITY INVOKER function still runs under the
--   caller's role, so RLS on ai_knowledge_entries continues to apply.
--
-- Safety:
--   - SECURITY INVOKER: function executes with the caller's privileges.
--   - Explicit `user_id = auth.uid()` check in addition to RLS — belt
--     and suspenders. If a future refactor accidentally weakens RLS
--     on the table, this filter still scopes results per user.
--   - `SET search_path = public, extensions` — keeps the cast to
--     `extensions.vector` resolvable without leaking other schemas
--     into the search path.
-- ============================================================

CREATE OR REPLACE FUNCTION match_ai_knowledge(
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
    -- Cosine similarity = 1 - cosine distance. <=> is pgvector's
    -- cosine-distance operator; lower distance ⇒ higher similarity.
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM ai_knowledge_entries e
  WHERE e.user_id = auth.uid()
    AND e.status = 'active'
    AND e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Allow authenticated users to call the function. RLS + the explicit
-- user_id filter inside the body do the actual access control.
REVOKE ALL ON FUNCTION match_ai_knowledge(extensions.vector(1536), int, float)
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION match_ai_knowledge(extensions.vector(1536), int, float)
  TO authenticated;
