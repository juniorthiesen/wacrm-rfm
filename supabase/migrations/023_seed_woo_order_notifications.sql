-- ============================================================
-- 023: Seed function for WooCommerce Order Status Notifications
--
-- Why a function instead of a direct INSERT:
--   Templates and Automations are per-user (RLS scoped). This migration
--   defines a helper function that the operator can run for their user:
--
--     SELECT seed_woo_order_notifications('<their-user-uuid>');
--
--   This will automatically seed the 4 templates as Draft rows,
--   and configure the corresponding active CRM automations with
--   the template variables matching the customer's purchase details.
--
-- Idempotent: re-running will update the templates, clear any
-- previous rejection reason, and recreate the automations.
-- ============================================================

CREATE OR REPLACE FUNCTION seed_woo_order_notifications(p_user_id UUID)
RETURNS TABLE(item_name TEXT, item_type TEXT, action TEXT) AS $$
DECLARE
  v_rec_auto_id UUID;
  v_paid_auto_id UUID;
  v_sep_auto_id UUID;
  v_ship_auto_id UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  -- 1. TEMPLATES SEEDING
  -- T1: Pedido Recebido / Aguardando Pagamento (PIX)
  INSERT INTO message_templates (
    user_id, name, category, language,
    body_text, status
  ) VALUES (
    p_user_id,
    'woo_order_received',
    'Utility',
    'pt_BR',
    -- Meta rejects bodies that start or end with a variable, so the
    -- PIX code needs a closing line after it.
    E'Olá, *{{1}}*! 👋\n\nRecebemos seu pedido *#{{2}}*.\nPara confirmar, utilize o Pix Copia e Cola abaixo:\n\n{{3}}\n\nAssim que o pagamento for confirmado, te avisamos por aqui. ✅',
    'Draft'
  )
  ON CONFLICT (user_id, name, language)
  DO UPDATE SET
    body_text = EXCLUDED.body_text,
    category = EXCLUDED.category,
    status = 'Draft',
    rejection_reason = NULL; -- Reset to Draft and clear errors so they can be resubmitted

  item_name := 'woo_order_received'; item_type := 'Template'; action := 'seeded (Draft)'; RETURN NEXT;

  -- T2: Aprovado / Pagamento Confirmado
  INSERT INTO message_templates (
    user_id, name, category, language,
    body_text, status
  ) VALUES (
    p_user_id,
    'woo_order_paid',
    'Utility',
    'pt_BR',
    E'Pagamento confirmado, *{{1}}*! 🎉\n\nSeu pedido *#{{2}}* foi aprovado com sucesso.\n\n*Resumo do pedido:*\n{{3}}\n\nAssim que entrar em separação, avisaremos você!',
    'Draft'
  )
  ON CONFLICT (user_id, name, language)
  DO UPDATE SET
    body_text = EXCLUDED.body_text,
    category = EXCLUDED.category,
    status = 'Draft',
    rejection_reason = NULL;

  item_name := 'woo_order_paid'; item_type := 'Template'; action := 'seeded (Draft)'; RETURN NEXT;

  -- T3: Em Separação
  INSERT INTO message_templates (
    user_id, name, category, language,
    body_text, status
  ) VALUES (
    p_user_id,
    'woo_order_in_separation',
    'Utility',
    'pt_BR',
    E'Opa! Boas notícias, *{{1}}*. 🎁\n\nSeu pedido *#{{2}}* acabou de entrar em *separação*.\nEstamos preparando tudo com muito carinho e em breve ele será enviado.',
    'Draft'
  )
  ON CONFLICT (user_id, name, language)
  DO UPDATE SET
    body_text = EXCLUDED.body_text,
    category = EXCLUDED.category,
    status = 'Draft',
    rejection_reason = NULL;

  item_name := 'woo_order_in_separation'; item_type := 'Template'; action := 'seeded (Draft)'; RETURN NEXT;

  -- T4: Enviado / Concluído
  INSERT INTO message_templates (
    user_id, name, category, language,
    body_text, status
  ) VALUES (
    p_user_id,
    'woo_order_shipped',
    'Utility',
    'pt_BR',
    -- Same bounds rule: the tracking link can't be the last token.
    E'Seu pedido *#{{1}}* foi enviado! 🚀\n\nO rastreio fica disponível após 24h do envio.\n\nCódigo de rastreio: *{{2}}*\n\nAcesse o link abaixo para rastrear:\n{{3}}\n\nQualquer dúvida, é só responder esta mensagem. 💬',
    'Draft'
  )
  ON CONFLICT (user_id, name, language)
  DO UPDATE SET
    body_text = EXCLUDED.body_text,
    category = EXCLUDED.category,
    status = 'Draft',
    rejection_reason = NULL;

  item_name := 'woo_order_shipped'; item_type := 'Template'; action := 'seeded (Draft)'; RETURN NEXT;


  -- 2. AUTOMATIONS SEEDING
  -- Clean up existing WooCommerce automations for this user to avoid duplication on re-run
  DELETE FROM automations 
  WHERE user_id = p_user_id 
    AND name IN (
      'WooCommerce - Pedido Recebido',
      'WooCommerce - Pagamento Confirmado',
      'WooCommerce - Em Separação',
      'WooCommerce - Pedido Enviado'
    );

  -- Automation 1: Pedido Recebido (Trigger: order_received)
  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'WooCommerce - Pedido Recebido',
    'Envia Pix Copia e Cola ao receber pedido pendente ou em espera',
    'order_received',
    '{}'::jsonb,
    TRUE
  ) RETURNING id INTO v_rec_auto_id;

  INSERT INTO automation_steps (
    automation_id, step_type, step_config, position
  ) VALUES (
    v_rec_auto_id,
    'send_template',
    jsonb_build_object(
      'template_name', 'woo_order_received',
      'language', 'pt_BR',
      'variables', jsonb_build_object(
        '1', '{{customer.first_name}}',
        '2', '{{order.number}}',
        '3', '{{order.pix_code}}'
      )
    ),
    0
  );

  item_name := 'WooCommerce - Pedido Recebido'; item_type := 'Automation'; action := 'created (Active)'; RETURN NEXT;

  -- Automation 2: Pagamento Confirmado (Trigger: order_paid)
  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'WooCommerce - Pagamento Confirmado',
    'Envia resumo de produtos pagos ao aprovar pagamento',
    'order_paid',
    '{}'::jsonb,
    TRUE
  ) RETURNING id INTO v_paid_auto_id;

  INSERT INTO automation_steps (
    automation_id, step_type, step_config, position
  ) VALUES (
    v_paid_auto_id,
    'send_template',
    jsonb_build_object(
      'template_name', 'woo_order_paid',
      'language', 'pt_BR',
      'variables', jsonb_build_object(
        '1', '{{customer.first_name}}',
        '2', '{{order.number}}',
        '3', '{{order.items_list}}'
      )
    ),
    0
  );

  item_name := 'WooCommerce - Pagamento Confirmado'; item_type := 'Automation'; action := 'created (Active)'; RETURN NEXT;

  -- Automation 3: Em Separação (Trigger: order_in_separation)
  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'WooCommerce - Em Separação',
    'Notifica o cliente quando o pedido entra em separação física',
    'order_in_separation',
    '{}'::jsonb,
    TRUE
  ) RETURNING id INTO v_sep_auto_id;

  INSERT INTO automation_steps (
    automation_id, step_type, step_config, position
  ) VALUES (
    v_sep_auto_id,
    'send_template',
    jsonb_build_object(
      'template_name', 'woo_order_in_separation',
      'language', 'pt_BR',
      'variables', jsonb_build_object(
        '1', '{{customer.first_name}}',
        '2', '{{order.number}}'
      )
    ),
    0
  );

  item_name := 'WooCommerce - Em Separação'; item_type := 'Automation'; action := 'created (Active)'; RETURN NEXT;

  -- Automation 4: Pedido Enviado (Trigger: order_shipped)
  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'WooCommerce - Pedido Enviado',
    'Notifica o cliente sobre o envio e envia link de rastreamento',
    'order_shipped',
    '{}'::jsonb,
    TRUE
  ) RETURNING id INTO v_ship_auto_id;

  INSERT INTO automation_steps (
    automation_id, step_type, step_config, position
  ) VALUES (
    v_ship_auto_id,
    'send_template',
    jsonb_build_object(
      'template_name', 'woo_order_shipped',
      'language', 'pt_BR',
      'variables', jsonb_build_object(
        '1', '{{order.number}}',
        '2', '{{order.tracking_code}}',
        '3', 'https://dly-lingerie.rastreamentofb.com.br'
      )
    ),
    0
  );

  item_name := 'WooCommerce - Pedido Enviado'; item_type := 'Automation'; action := 'created (Active)'; RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION seed_woo_order_notifications(UUID) IS
  'Seeds the 4 WooCommerce order status notification templates as Drafts and creates the matching active CRM automations for the given user.';
