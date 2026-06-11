-- ============================================================
-- 022: Seed function for DLY "Multiplique-se" promo campaign
--
-- Why a function instead of a direct INSERT:
--   message_templates is per-user (RLS scoped). A migration can't
--   know which user owns a given installation. Wrapping the seed
--   in a function lets the operator call:
--
--     SELECT seed_promo_dly_multiplique_se('<their-user-uuid>');
--
--   from the Supabase SQL editor, getting 7 Draft templates ready
--   to submit to Meta via POST /api/whatsapp/templates/submit.
--
-- Strategy applied (see docs/whatsapp-cost-strategy.md):
--   - T1-T4 reformulated as UTILITY-abridor with Quick Reply
--     buttons. Click opens the 24h window so the actual promo
--     content goes via free-form (free) in a follow-up
--     automation.
--   - T5 (carrinho abandonado) and T7 (pós-compra) are natural
--     UTILITY content already.
--   - T6 (última chance) stays MARKETING — urgency factual
--     content can't pass Meta as Utility.
--   - Variable Prefix Fix: Meta forbids templates from starting
--     with a variable. T4 and T6 have been updated to start with
--     greeting text ("Olá, {{1}}!") instead of the raw variable "{{1}}".
--
-- The function is idempotent: re-running will update templates
-- and reset their status to Draft to allow resubmission.
-- ============================================================

-- Make (user_id, name, language) unique so the ON CONFLICT clause
-- below works AND so the sync endpoint can stop matching by hand.
-- Only added if not already present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_user_name_lang
  ON message_templates(user_id, name, language);

CREATE OR REPLACE FUNCTION seed_promo_dly_multiplique_se(p_user_id UUID)
RETURNS TABLE(template_name TEXT, action TEXT) AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  -- T1 — Lançamento regular (UTILITY-abridor)
  -- The "promo content" goes via free-form after the click.
  INSERT INTO message_templates (
    user_id, name, category, language,
    header_type, header_content,
    body_text, body_example, footer_text, buttons, status
  ) VALUES (
    p_user_id,
    'promo_multiplique_lancamento_regular',
    'Utility',
    'pt_BR',
    'image',
    'https://dly.com.br/promo/header-multiplique.jpg',
    'Oi, {{1}}! Sua área de cliente DLY foi atualizada — sua seleção da semana já está disponível para visualizar. Acesso liberado até {{2}}.',
    '{"body_text": [["Mariana", "23/06"]]}'::jsonb,
    'DLY · responda SAIR para descadastrar',
    '[
      {"type":"QUICK_REPLY","text":"Ver minha seleção"},
      {"type":"QUICK_REPLY","text":"Quero ajuda do tamanho"}
    ]'::jsonb,
    'Draft'
  ) ON CONFLICT (user_id, name, language) DO UPDATE SET
    category = EXCLUDED.category,
    header_type = EXCLUDED.header_type,
    header_content = EXCLUDED.header_content,
    body_text = EXCLUDED.body_text,
    body_example = EXCLUDED.body_example,
    footer_text = EXCLUDED.footer_text,
    buttons = EXCLUDED.buttons,
    status = 'Draft',
    rejection_reason = NULL;
  
  template_name := 'promo_multiplique_lancamento_regular'; action := 'seeded'; RETURN NEXT;

  -- T2 — Lançamento PLUS (UTILITY-abridor)
  INSERT INTO message_templates (
    user_id, name, category, language,
    header_type, header_content,
    body_text, body_example, footer_text, buttons, status
  ) VALUES (
    p_user_id,
    'promo_multiplique_lancamento_plus',
    'Utility',
    'pt_BR',
    'image',
    'https://dly.com.br/promo/header-plus.jpg',
    'Oi, {{1}}! Sua área PLUS na DLY foi atualizada — novidades da linha do 46 ao 56 já liberadas para você. Disponível até {{2}}.',
    '{"body_text": [["Carla", "23/06"]]}'::jsonb,
    'DLY · responda SAIR para descadastrar',
    '[
      {"type":"QUICK_REPLY","text":"Ver linha PLUS"},
      {"type":"QUICK_REPLY","text":"Quero ajuda do tamanho"}
    ]'::jsonb,
    'Draft'
  ) ON CONFLICT (user_id, name, language) DO UPDATE SET
    category = EXCLUDED.category,
    header_type = EXCLUDED.header_type,
    header_content = EXCLUDED.header_content,
    body_text = EXCLUDED.body_text,
    body_example = EXCLUDED.body_example,
    footer_text = EXCLUDED.footer_text,
    buttons = EXCLUDED.buttons,
    status = 'Draft',
    rejection_reason = NULL;
  
  template_name := 'promo_multiplique_lancamento_plus'; action := 'seeded'; RETURN NEXT;

  -- T3 — Acesso antecipado VIP (UTILITY-abridor)
  INSERT INTO message_templates (
    user_id, name, category, language,
    body_text, body_example, footer_text, buttons, status
  ) VALUES (
    p_user_id,
    'promo_multiplique_acesso_antecipado',
    'Utility',
    'pt_BR',
    'Oi, {{1}}! Como cliente preferencial, sua prévia exclusiva da DLY já foi liberada — acesso antecipado de {{2}}h sobre o lançamento público.',
    '{"body_text": [["Mariana", "12"]]}'::jsonb,
    'DLY · responda SAIR para descadastrar',
    '[
      {"type":"QUICK_REPLY","text":"Acessar agora"}
    ]'::jsonb,
    'Draft'
  ) ON CONFLICT (user_id, name, language) DO UPDATE SET
    category = EXCLUDED.category,
    body_text = EXCLUDED.body_text,
    body_example = EXCLUDED.body_example,
    footer_text = EXCLUDED.footer_text,
    buttons = EXCLUDED.buttons,
    status = 'Draft',
    rejection_reason = NULL;
  
  template_name := 'promo_multiplique_acesso_antecipado'; action := 'seeded'; RETURN NEXT;

  -- T4 — Reforço meio campanha (UTILITY-abridor)
  -- Fixed: starts with "Oi, {{1}}!" instead of raw "{{1}}" to prevent Meta rejection.
  INSERT INTO message_templates (
    user_id, name, category, language,
    body_text, body_example, footer_text, buttons, status
  ) VALUES (
    p_user_id,
    'promo_multiplique_reforco_meio',
    'Utility',
    'pt_BR',
    'Oi, {{1}}! Uma atualização da sua seleção DLY: faltam {{2}} dias da janela aberta. Posso te enviar os 3 modelos mais buscados desta semana?',
    '{"body_text": [["Mariana", "7"]]}'::jsonb,
    'DLY · responda SAIR para descadastrar',
    '[
      {"type":"QUICK_REPLY","text":"Sim, mandar"},
      {"type":"QUICK_REPLY","text":"Tirar dúvida"}
    ]'::jsonb,
    'Draft'
  ) ON CONFLICT (user_id, name, language) DO UPDATE SET
    category = EXCLUDED.category,
    body_text = EXCLUDED.body_text,
    body_example = EXCLUDED.body_example,
    footer_text = EXCLUDED.footer_text,
    buttons = EXCLUDED.buttons,
    status = 'Draft',
    rejection_reason = NULL;
  
  template_name := 'promo_multiplique_reforco_meio'; action := 'seeded'; RETURN NEXT;

  -- T5 — Carrinho abandonado (UTILITY legítimo)
  INSERT INTO message_templates (
    user_id, name, category, language,
    body_text, body_example, footer_text, buttons, status
  ) VALUES (
    p_user_id,
    'promo_multiplique_carrinho_abandonado',
    'Utility',
    'pt_BR',
    'Oi, {{1}}! Status do seu carrinho DLY: {{2}} reservado por mais {{3}}. Troca grátis se o tamanho não servir.',
    '{"body_text": [["Mariana", "3 peças código 407", "2 dias"]]}'::jsonb,
    'DLY · responda SAIR para descadastrar',
    '[
      {"type":"QUICK_REPLY","text":"Finalizar pedido"},
      {"type":"QUICK_REPLY","text":"Tirar dúvida"}
    ]'::jsonb,
    'Draft'
  ) ON CONFLICT (user_id, name, language) DO UPDATE SET
    category = EXCLUDED.category,
    body_text = EXCLUDED.body_text,
    body_example = EXCLUDED.body_example,
    footer_text = EXCLUDED.footer_text,
    buttons = EXCLUDED.buttons,
    status = 'Draft',
    rejection_reason = NULL;
  
  template_name := 'promo_multiplique_carrinho_abandonado'; action := 'seeded'; RETURN NEXT;

  -- T6 — Última chance (mantém MARKETING)
  -- Fixed: starts with "Olá, {{1}}!" instead of raw "{{1}}" to prevent Meta rejection.
  INSERT INTO message_templates (
    user_id, name, category, language,
    body_text, body_example, footer_text, buttons, status
  ) VALUES (
    p_user_id,
    'promo_multiplique_ultima_chance',
    'Marketing',
    'pt_BR',
    'Olá, {{1}}! É hoje. A campanha "Multiplique-se" da DLY acaba {{2}}. Amanhã volta o preço cheio — sem prorrogação. Códigos regulares: 404, 407, 331, 423, 401. PLUS: 900, 901, 909.',
    '{"body_text": [["Mariana", "à meia-noite"]]}'::jsonb,
    'DLY · responda SAIR para descadastrar',
    '[
      {"type":"URL","text":"Garantir agora","url":"https://dly.com.br/promo/multiplique?utm_source=whatsapp&utm_medium=broadcast&utm_campaign=promo_dly_jun26_regular&utm_content=t6_ultima_chance"}
    ]'::jsonb,
    'Draft'
  ) ON CONFLICT (user_id, name, language) DO UPDATE SET
    category = EXCLUDED.category,
    body_text = EXCLUDED.body_text,
    body_example = EXCLUDED.body_example,
    footer_text = EXCLUDED.footer_text,
    buttons = EXCLUDED.buttons,
    status = 'Draft',
    rejection_reason = NULL;
  
  template_name := 'promo_multiplique_ultima_chance'; action := 'seeded'; RETURN NEXT;

  -- T7 — Pós-compra (UTILITY + QR pra abrir janela pro cross-sell)
  INSERT INTO message_templates (
    user_id, name, category, language,
    body_text, body_example, footer_text, buttons, status
  ) VALUES (
    p_user_id,
    'promo_multiplique_pos_compra_cross',
    'Utility',
    'pt_BR',
    'Pedido confirmado, {{1}}! Seu kit "Multiplique-se" (pedido #{{2}}) já está em separação. Previsão de envio: {{3}}.',
    '{"body_text": [["Mariana", "847291", "amanhã"]]}'::jsonb,
    'DLY · responda SAIR para descadastrar',
    '[
      {"type":"QUICK_REPLY","text":"Acompanhar pedido"},
      {"type":"QUICK_REPLY","text":"Ver outras peças"}
    ]'::jsonb,
    'Draft'
  ) ON CONFLICT (user_id, name, language) DO UPDATE SET
    category = EXCLUDED.category,
    body_text = EXCLUDED.body_text,
    body_example = EXCLUDED.body_example,
    footer_text = EXCLUDED.footer_text,
    buttons = EXCLUDED.buttons,
    status = 'Draft',
    rejection_reason = NULL;
  
  template_name := 'promo_multiplique_pos_compra_cross'; action := 'seeded'; RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION seed_promo_dly_multiplique_se(UUID) IS
  'Seeds the 7 DLY Multiplique-se templates as Draft rows for the given user, resetting their status to Draft on execution.';
