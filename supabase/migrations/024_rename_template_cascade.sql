-- ============================================================
-- 024: Atomic template rename with automation-step cascade
--
-- Why:
--   A template's name lives in two places: the message_templates
--   row itself AND every automation step with
--   step_type='send_template' (step_config->>'template_name').
--   Renaming only the template silently breaks those automations —
--   the next order would fail at send time with Meta error #132001
--   "Template name does not exist in the translation".
--
--   Renames happen when Meta locks a template name: deleting a
--   template makes its name unavailable while the deletion
--   propagates, and deleting an APPROVED template locks the name
--   for 30 days. The Template Manager offers "rename to _vN and
--   resubmit" in that flow; this function makes the rename atomic.
--
-- SECURITY INVOKER on purpose: the caller's RLS policies apply, so
-- a user can only rename their own templates and only steps of
-- their own automations are touched.
-- ============================================================

CREATE OR REPLACE FUNCTION rename_message_template(
  p_template_id UUID,
  p_new_name TEXT
)
RETURNS TABLE(old_name TEXT, new_name TEXT, automations_updated INT) AS $$
DECLARE
  v_old_name TEXT;
  v_language TEXT;
  v_user_id UUID;
  v_status TEXT;
  v_steps INT;
BEGIN
  -- Postgres caps regex repetition bounds at 255, so '{1,512}' is a
  -- runtime error ("invalid repetition count(s)") — check the length
  -- separately instead.
  IF p_new_name !~ '^[a-z0-9_]+$' OR length(p_new_name) > 512 THEN
    RAISE EXCEPTION 'invalid_name'
      USING HINT = 'Template names must be lowercase letters, digits and underscores (max 512 chars).';
  END IF;

  SELECT t.name, t.language, t.user_id, t.status
    INTO v_old_name, v_language, v_user_id, v_status
  FROM message_templates t
  WHERE t.id = p_template_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'template_not_found';
  END IF;

  -- Renaming a Pending/Approved row would desync it from the version
  -- Meta already holds under the old name. Only pre-submission states
  -- may be renamed (mirrors the submit endpoint's rule).
  IF v_status NOT IN ('Draft', 'Rejected') THEN
    RAISE EXCEPTION 'template_not_renameable'
      USING HINT = 'Only Draft or Rejected templates can be renamed.';
  END IF;

  IF v_old_name = p_new_name THEN
    RAISE EXCEPTION 'same_name';
  END IF;

  UPDATE message_templates t
  SET name = p_new_name
  WHERE t.id = p_template_id;
  -- The unique index idx_message_templates_user_name_lang (022)
  -- makes a duplicate target name fail loudly here (SQLSTATE 23505),
  -- rolling back the whole rename.

  -- Cascade into automation steps that send this template. Language
  -- must match too: the same name can exist in several languages and
  -- only this row's language is being renamed. Steps without an
  -- explicit language default to the template's own.
  UPDATE automation_steps s
  SET step_config = jsonb_set(s.step_config, '{template_name}', to_jsonb(p_new_name))
  FROM automations a
  WHERE a.id = s.automation_id
    AND a.user_id = v_user_id
    AND s.step_type = 'send_template'
    AND s.step_config->>'template_name' = v_old_name
    AND COALESCE(s.step_config->>'language', v_language) = v_language;
  GET DIAGNOSTICS v_steps = ROW_COUNT;

  old_name := v_old_name;
  new_name := p_new_name;
  automations_updated := v_steps;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- RLS already guards the data (SECURITY INVOKER), but there is no
-- reason for anonymous sessions to probe the function at all.
REVOKE ALL ON FUNCTION rename_message_template(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rename_message_template(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION rename_message_template(UUID, TEXT) IS
  'Renames a Draft/Rejected template and cascades the new name into every send_template automation step that referenced the old one. SECURITY INVOKER — caller RLS applies.';
