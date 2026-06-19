-- ============================================================
-- 036: Birthday-month tracking column + seed function for the
--      "birthday + magic-login" HSM template kit.
--
-- Adds:
--   contacts.last_birthday_month_greeting — dedupe marker for the
--                                            once-per-year month
--                                            greeting (mirrors
--                                            last_birthday_greeting
--                                            from 035).
--   birthday_month_contacts_today()        — RPC the cron uses to
--                                            find contacts whose
--                                            birth month is the
--                                            current month AND who
--                                            haven't already received
--                                            the month message this
--                                            calendar year.
--   seed_birthday_and_magic_login(uuid)    — same shape as 023:
--                                            inserts 3 templates as
--                                            Draft (so the operator
--                                            can submit them to Meta
--                                            for approval from the
--                                            Templates page) and
--                                            wires the 3 corresponding
--                                            automations as Active.
--
-- Idempotent — re-running updates bodies, resets Drafts, and recreates
-- the automations. Safe to invoke any time the template copy needs to
-- be reseeded.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS last_birthday_month_greeting DATE;

-- The monthly scan filters by birth month; reuse 035's expression
-- index (already covers month + day).

CREATE OR REPLACE FUNCTION birthday_month_contacts_today(
  p_user_id UUID,
  p_today DATE,
  p_limit INT DEFAULT 500
)
RETURNS TABLE(contact_id UUID, contact_name TEXT, contact_phone TEXT) AS $$
BEGIN
  -- Same defense-in-depth as birthday_contacts_today: authenticated
  -- callers can only read their own; service-role (auth.uid() IS NULL)
  -- is allowed.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.phone
  FROM contacts c
  WHERE c.user_id = p_user_id
    AND c.birthday IS NOT NULL
    AND EXTRACT(MONTH FROM c.birthday) = EXTRACT(MONTH FROM p_today)
    AND (
      c.last_birthday_month_greeting IS NULL
      OR EXTRACT(YEAR FROM c.last_birthday_month_greeting)
         < EXTRACT(YEAR FROM p_today)
    )
  ORDER BY c.id
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION birthday_month_contacts_today(UUID, DATE, INT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION birthday_month_contacts_today(UUID, DATE, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION birthday_month_contacts_today(UUID, DATE, INT) IS
  'Returns a tenant''s contacts whose birth month matches p_today and who have not yet received a birthday-month greeting in the current calendar year.';


-- ============================================================
-- seed_birthday_and_magic_login(p_user_id UUID)
--
-- Mirrors 023's seed_woo_order_notifications:
--   * 3 templates inserted as Draft so the operator submits them to
--     Meta from the Templates page (Meta requires per-template
--     approval — we can't side-step it).
--   * 3 active automations wired to the new triggers.
--
-- Templates created (all language pt_BR):
--   * magic_login_access      — Utility, has dynamic URL button
--   * aniversario_mes_cupom   — Marketing, uses {{customer.first_name}}
--                               + {{vars.coupon_code}} so the operator
--                               edits one place to rotate coupons
--   * aniversario_dia         — Marketing, simple greeting
-- ============================================================

CREATE OR REPLACE FUNCTION seed_birthday_and_magic_login(p_user_id UUID)
RETURNS TABLE(item_name TEXT, item_type TEXT, action TEXT) AS $$
DECLARE
  v_magic_auto_id   UUID;
  v_bmonth_auto_id  UUID;
  v_bday_auto_id    UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  -- ------------------------------------------------------------
  -- 1. TEMPLATES
  -- ------------------------------------------------------------

  -- T1: Magic Login (Utility, with dynamic URL button — the button
  -- is configured at submission time in Meta Business Manager; the
  -- body must NOT include the URL inline).
  INSERT INTO message_templates (
    user_id, name, category, language, body_text, status
  ) VALUES (
    p_user_id,
    'magic_login_access',
    'Utility',
    'pt_BR',
    E'Olá, *{{1}}*! 👋\n\nRecebemos sua solicitação de acesso rápido.\nToque no botão abaixo para entrar direto na sua conta (válido por 15 minutos).'
  , 'Draft')
  ON CONFLICT (user_id, name, language) DO UPDATE SET
    body_text = EXCLUDED.body_text,
    category  = EXCLUDED.category,
    status    = 'Draft',
    rejection_reason = NULL;

  item_name := 'magic_login_access';
  item_type := 'Template';
  action    := 'seeded (Draft)';
  RETURN NEXT;

  -- T2: Aniversário do Mês com Cupom (Marketing). Coupon is a vars-
  -- bound variable so the operator can edit the value in one place
  -- in the automation without re-approving the template.
  INSERT INTO message_templates (
    user_id, name, category, language, body_text, status
  ) VALUES (
    p_user_id,
    'aniversario_mes_cupom',
    'Marketing',
    'pt_BR',
    E'🎂 Esse mês é seu, *{{1}}*!\n\nPra comemorar com a gente, separamos um presente especial:\n\n*Cupom:* {{2}} — válido só durante seu mês de aniversário.\n\nAproveita 🎁'
  , 'Draft')
  ON CONFLICT (user_id, name, language) DO UPDATE SET
    body_text = EXCLUDED.body_text,
    category  = EXCLUDED.category,
    status    = 'Draft',
    rejection_reason = NULL;

  item_name := 'aniversario_mes_cupom';
  item_type := 'Template';
  action    := 'seeded (Draft)';
  RETURN NEXT;

  -- T3: Aniversário do Dia (Marketing). Simple greeting, no coupon.
  INSERT INTO message_templates (
    user_id, name, category, language, body_text, status
  ) VALUES (
    p_user_id,
    'aniversario_dia',
    'Marketing',
    'pt_BR',
    E'🎉 Feliz aniversário, *{{1}}*!\n\nQue esse dia seja cheio de alegria, conquistas e amor.\n\nEquipe DLY 🤍'
  , 'Draft')
  ON CONFLICT (user_id, name, language) DO UPDATE SET
    body_text = EXCLUDED.body_text,
    category  = EXCLUDED.category,
    status    = 'Draft',
    rejection_reason = NULL;

  item_name := 'aniversario_dia';
  item_type := 'Template';
  action    := 'seeded (Draft)';
  RETURN NEXT;

  -- ------------------------------------------------------------
  -- 2. AUTOMATIONS (clean slate to avoid duplicates on re-run)
  -- ------------------------------------------------------------
  DELETE FROM automations
  WHERE user_id = p_user_id
    AND name IN (
      'Magic Login - Acesso Rápido',
      'Aniversário - Mês com Cupom',
      'Aniversário - Dia (Parabéns)'
    );

  -- A1: Magic Login → trigger customer_magic_login_requested
  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'Magic Login - Acesso Rápido',
    'Envia link mágico de acesso rápido com botão URL dinâmico (SmartCheckout / Loja5).',
    'customer_magic_login_requested',
    '{}'::jsonb,
    TRUE
  ) RETURNING id INTO v_magic_auto_id;

  INSERT INTO automation_steps (
    automation_id, step_type, step_config, position
  ) VALUES (
    v_magic_auto_id,
    'send_template',
    jsonb_build_object(
      'template_name', 'magic_login_access',
      'language', 'pt_BR',
      'variables', jsonb_build_object(
        '1', '{{customer.first_name}}'
      ),
      'button_url_param', '{{magic_login.suffix}}'
    ),
    0
  );

  item_name := 'Magic Login - Acesso Rápido';
  item_type := 'Automation';
  action    := 'created (Active)';
  RETURN NEXT;

  -- A2: Aniversário do Mês com Cupom → trigger birthday_month
  -- Coupon comes from vars so the operator updates only the
  -- automation step config, not the (approved) template.
  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'Aniversário - Mês com Cupom',
    'Mensagem no início do mês de aniversário com cupom especial.',
    'birthday_month',
    '{}'::jsonb,
    TRUE
  ) RETURNING id INTO v_bmonth_auto_id;

  INSERT INTO automation_steps (
    automation_id, step_type, step_config, position
  ) VALUES (
    v_bmonth_auto_id,
    'send_template',
    jsonb_build_object(
      'template_name', 'aniversario_mes_cupom',
      'language', 'pt_BR',
      'variables', jsonb_build_object(
        '1', '{{customer.first_name}}',
        -- Edit this value in the Automation Builder to rotate the
        -- coupon without going through Meta's template review again.
        '2', 'ANIVER10'
      )
    ),
    0
  );

  item_name := 'Aniversário - Mês com Cupom';
  item_type := 'Automation';
  action    := 'created (Active)';
  RETURN NEXT;

  -- A3: Aniversário do Dia → trigger birthday (existing in 035)
  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'Aniversário - Dia (Parabéns)',
    'Mensagem de parabéns no dia do aniversário do cliente.',
    'birthday',
    '{}'::jsonb,
    TRUE
  ) RETURNING id INTO v_bday_auto_id;

  INSERT INTO automation_steps (
    automation_id, step_type, step_config, position
  ) VALUES (
    v_bday_auto_id,
    'send_template',
    jsonb_build_object(
      'template_name', 'aniversario_dia',
      'language', 'pt_BR',
      'variables', jsonb_build_object(
        '1', '{{customer.first_name}}'
      )
    ),
    0
  );

  item_name := 'Aniversário - Dia (Parabéns)';
  item_type := 'Automation';
  action    := 'created (Active)';
  RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION seed_birthday_and_magic_login(UUID) IS
  'Seeds 3 Draft templates (magic_login_access, aniversario_mes_cupom, aniversario_dia) and creates 3 active automations wired to customer_magic_login_requested, birthday_month and birthday respectively.';
