-- ============================================================
-- 037: Seed function for the "carrinho abandonado" recovery kit.
--
-- No schema changes — the `cart_abandoned` trigger type and the
-- WooCommerce webhook handler (handleCartAbandoned) already exist.
-- This only seeds the operator-facing artifacts:
--
--   * 1 template (Marketing, pt_BR) inserted as Draft so the operator
--     submits it to Meta from the Templates page.
--   * 1 active automation wired to the cart_abandoned trigger.
--
-- The cart-abandoned context (built in the webhook) exposes:
--   cart.checkout_url, cart.checkout_url_suffix, cart.coupon_code,
--   cart.total, cart.product_names
--   customer.first_name, customer.last_name, customer.name,
--   customer.phone, customer.email
--
-- The template uses {{1}} = customer.first_name and
-- {{2}} = cart.product_names. The dynamic-URL button reuses the
-- magic-login shape: the body URL is "<base>{{1}}" and the suffix
-- (cart.checkout_url_suffix) is injected at send time via the step's
-- button_url_param. The coupon is intentionally NOT in the body — it
-- is optional in FunnelKit payloads, so per the "empty value"
-- principle it belongs in a separate template that fires only when a
-- coupon exists, not in the always-on reminder.
--
-- Idempotent — re-running updates the body, resets the Draft, and
-- recreates the automation.
-- ============================================================

CREATE OR REPLACE FUNCTION seed_cart_abandoned(p_user_id UUID)
RETURNS TABLE(item_name TEXT, item_type TEXT, action TEXT) AS $$
DECLARE
  v_cart_auto_id UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  -- ------------------------------------------------------------
  -- 1. TEMPLATE (Marketing, dynamic URL button back to checkout)
  -- ------------------------------------------------------------
  INSERT INTO message_templates (
    user_id, name, category, language, body_text, status, buttons, body_example
  ) VALUES (
    p_user_id,
    'carrinho_abandonado',
    'Marketing',
    'pt_BR',
    E'DLY 🛍️ — Oi, *{{1}}*! Esqueceu de finalizar? 👀\n\nSeparamos o que você deixou no carrinho:\n{{2}}\n\nAinda dá tempo de garantir 💜 Toque no botão abaixo pra concluir sua compra com toda a segurança.',
    'Draft',
    -- NOTE: the URL base is provisional. Confirm the real abandoned-cart
    -- checkout URL base before submitting to Meta (mirrors magic_login).
    jsonb_build_array(
      jsonb_build_object(
        'type', 'URL',
        'text', 'Finalizar compra 🛒',
        'url',  'https://dly.com.br/{{1}}'
      )
    ),
    jsonb_build_object(
      'body_text',
      jsonb_build_array(
        jsonb_build_array('Maria', 'Conjunto Renda Preta, Calcinha Cintura Alta')
      )
    )
  )
  ON CONFLICT (user_id, name, language) DO UPDATE SET
    body_text    = EXCLUDED.body_text,
    category     = EXCLUDED.category,
    buttons      = EXCLUDED.buttons,
    body_example = EXCLUDED.body_example,
    status       = 'Draft',
    rejection_reason = NULL;

  item_name := 'carrinho_abandonado';
  item_type := 'Template';
  action    := 'seeded (Draft)';
  RETURN NEXT;

  -- ------------------------------------------------------------
  -- 2. AUTOMATION (clean slate to avoid duplicates on re-run)
  -- ------------------------------------------------------------
  DELETE FROM automations
  WHERE user_id = p_user_id
    AND name = 'Carrinho Abandonado - Recuperação';

  INSERT INTO automations (
    user_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    'Carrinho Abandonado - Recuperação',
    'Recupera carrinhos abandonados (FunnelKit/BuildwooFunnels) com link direto pro checkout.',
    'cart_abandoned',
    '{}'::jsonb,
    TRUE
  ) RETURNING id INTO v_cart_auto_id;

  INSERT INTO automation_steps (
    automation_id, step_type, step_config, position
  ) VALUES (
    v_cart_auto_id,
    'send_template',
    jsonb_build_object(
      'template_name', 'carrinho_abandonado',
      'language', 'pt_BR',
      'variables', jsonb_build_object(
        '1', '{{customer.first_name}}',
        '2', '{{cart.product_names}}'
      ),
      'button_url_param', '{{cart.checkout_url_suffix}}'
    ),
    0
  );

  item_name := 'Carrinho Abandonado - Recuperação';
  item_type := 'Automation';
  action    := 'created (Active)';
  RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION seed_cart_abandoned(UUID) IS
  'Seeds 1 Draft template (carrinho_abandonado) and 1 active automation wired to the cart_abandoned trigger.';
