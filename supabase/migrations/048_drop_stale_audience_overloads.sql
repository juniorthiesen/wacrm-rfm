-- ============================================================
-- 048: Drop stale pre-046 audience RPC overloads
--
-- Why:
--   046_audience_not_contacted_days.sql added p_not_contacted_days to
--   audience_rows / count_audience / list_audience /
--   create_audience_campaign via CREATE OR REPLACE. Since the parameter
--   list changed, Postgres didn't replace the existing functions — it
--   created a second overload for each, leaving the pre-046 signatures
--   live alongside the new ones. Any call that doesn't explicitly pass
--   p_not_contacted_days (e.g. named-arg calls from the SQL editor)
--   became ambiguous: "function ... is not unique" (seen 2026-08-30
--   trying to build a recompra campaign).
--
-- This drops the exact pre-046 signatures, leaving only the current
-- (p_not_contacted_days-aware) version of each function.
-- ============================================================

DROP FUNCTION IF EXISTS audience_rows(
  UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC,
  TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]
);

DROP FUNCTION IF EXISTS count_audience(
  UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC,
  TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[]
);

DROP FUNCTION IF EXISTS list_audience(
  UUID, TEXT[], INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC,
  TEXT, TEXT, DATE, DATE, INT, UUID[], UUID[], TEXT, INT, INT
);

DROP FUNCTION IF EXISTS create_audience_campaign(
  UUID, TEXT, TEXT, TEXT, JSONB, INTEGER, NUMERIC, INT, TEXT, TEXT[],
  INT, INT, NUMERIC, NUMERIC, INT, INT, NUMERIC, NUMERIC, TEXT, TEXT,
  DATE, DATE, INT, UUID[], UUID[]
);
