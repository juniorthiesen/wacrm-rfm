-- ============================================================
-- Migration presence check
--
-- This project applies migrations by hand in the Supabase SQL editor
-- (there is no schema_migrations tracking table), so it's easy to lose
-- track of which ones landed in production. Paste this whole script
-- into the SQL editor and run it: each migration reports ✅ OK or
-- ❌ MISSING based on whether its key object exists.
--
-- A ❌ means that migration's .sql in supabase/migrations/ has not been
-- applied — open the matching file and run it (all are idempotent).
--
-- Keep this in sync when adding a migration: append one row below.
-- ============================================================

SELECT
  migration,
  CASE WHEN present THEN '✅ OK' ELSE '❌ MISSING' END AS status
FROM (
  VALUES
    ('001 initial schema',
      to_regclass('public.contacts') IS NOT NULL),
    ('002 pipelines enhancements',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='deals' AND column_name='assigned_to')),
    ('003 broadcast recipient wamid',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='broadcast_recipients' AND column_name='whatsapp_message_id')),
    ('004 contact delete set null',
      EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname='broadcast_recipients_contact_id_fkey' AND confdeltype='n')),
    ('005 broadcast counts incremental',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='recompute_broadcast_counts')),
    ('006 automations',
      to_regclass('public.automations') IS NOT NULL),
    ('007 automations increment counter',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='increment_automation_execution_count')),
    ('008 profile avatars storage',
      EXISTS (SELECT 1 FROM storage.buckets WHERE id='avatars')),
    ('009 message actions',
      to_regclass('public.message_reactions') IS NOT NULL),
    ('010 flows',
      to_regclass('public.flows') IS NOT NULL),
    ('011 profile beta features',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='profiles' AND column_name='beta_features')),
    ('012 flows increment counter',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='increment_flow_execution_count')),
    ('013 whatsapp_config phone_number_id unique',
      EXISTS (SELECT 1 FROM pg_constraint WHERE conname='whatsapp_config_phone_number_id_key')),
    ('014 attribution',
      to_regclass('public.meta_ads_config') IS NOT NULL),
    ('015 ecommerce integrations',
      to_regclass('public.integration_configs') IS NOT NULL),
    ('016 orders line_items',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='orders' AND column_name='line_items')),
    ('017 integration sync_state',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='integration_configs' AND column_name='sync_state')),
    ('018 ai agent',
      to_regclass('public.ai_agents') IS NOT NULL),
    ('019 ai knowledge search',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='match_ai_knowledge')),
    ('020 ai auto reply',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='ai_agents' AND column_name='auto_reply_enabled')),
    ('021 conversation window',
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='contacts' AND column_name='conversation_window_until')),
    ('022 seed promo dly',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='seed_promo_dly_multiplique_se')),
    ('023 seed woo order notifications',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='seed_woo_order_notifications')),
    ('024 rename template cascade',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='rename_message_template')),
    ('025 rfm recalc function',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='recalculate_user_rfm')),
    ('026 find contact by phone',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='find_contact_id_by_phone')),
    ('027 rfm insights function',
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='rfm_insights'))
) AS t(migration, present)
ORDER BY migration;
