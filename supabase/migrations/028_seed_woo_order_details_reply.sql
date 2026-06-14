-- ============================================================
-- 028: Seed the "Ver detalhes do pedido" reply automation
--
-- The confirmacao_pedido template carries a Quick Reply button labeled
-- "Ver detalhes do pedido". When the customer taps it, Meta delivers
-- the tap as an inbound message whose text is the button label, which
-- (a) opens the 24h service window and (b) fires keyword_match
-- automations. This seeds the automation that answers that tap with a
-- free-form message (free, because the window is open) pointing to the
-- store account page.
--
-- Why a function (like the other Woo seeds): automations are per-user
-- (RLS). The operator runs:
--   SELECT seed_woo_order_details_reply('<their-user-uuid>');
--
-- Idempotent: re-running replaces the automation.
--
-- The match is case-insensitive exact (the engine lowercases both
-- sides), so it fires on the exact button label regardless of casing.
-- Edit the URL / copy afterwards in Automations → this automation, or
-- by re-running with a changed body here.
-- ============================================================

CREATE OR REPLACE FUNCTION seed_woo_order_details_reply(p_user_id UUID)
RETURNS TABLE(item_name TEXT, item_type TEXT, action TEXT) AS $$
DECLARE
  v_auto_id UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  -- Replace any previous version for idempotency. Cascades to its steps.
  DELETE FROM automations
  WHERE user_id = p_user_id
    AND name = 'WooCommerce - Ver detalhes do pedido';

  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'WooCommerce - Ver detalhes do pedido',
    'Responde com o link da conta da loja quando o cliente toca no botão "Ver detalhes do pedido" do template de confirmação. Texto livre (grátis) — a janela de 24h abre com o toque.',
    'keyword_match',
    jsonb_build_object(
      'keywords', jsonb_build_array('Ver detalhes do pedido'),
      'match_type', 'exact'
    ),
    TRUE
  ) RETURNING id INTO v_auto_id;

  INSERT INTO automation_steps (
    automation_id, step_type, step_config, position
  ) VALUES (
    v_auto_id,
    'send_message',
    jsonb_build_object(
      'text',
      E'Aqui você acompanha seus pedidos: https://dly.com.br/minha-conta\n\nÉ só entrar com o e-mail cadastrado na compra. 🛍️\n\nQualquer dúvida, é só responder por aqui!'
    ),
    0
  );

  item_name := 'WooCommerce - Ver detalhes do pedido';
  item_type := 'Automation';
  action := 'created (Active)';
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION seed_woo_order_details_reply(UUID) IS
  'Seeds the keyword_match automation that replies to the "Ver detalhes do pedido" template button tap with the store account link (free-form, in-window).';
