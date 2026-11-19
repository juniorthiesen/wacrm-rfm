-- ============================================================
-- 055: Carrinhos abandonados vindos do plugin de checkout do Woo
-- (WC Smart Checkout / módulo "Rishi"). Ver docs/handoff-email-channel.md, seção 16.
--
-- O plugin envia um POST JSON a cada 10 min com os carrinhos cuja situação mudou
-- (abandoned → recovered / converted / dismissed). Esta tabela guarda um registro
-- por carrinho do plugin para:
--   • idempotência: o mesmo carrinho reenviado (retry do plugin) nunca inicia a
--     sequência de e-mails duas vezes;
--   • uma sequência por pessoa por vez: um segundo carrinho do mesmo e-mail dentro
--     da janela de proteção é registrado mas não inicia outra sequência;
--   • medir recuperação (recovered/converted) no relatório.
--
-- Aditiva. Só o service role escreve (webhook); o dono lê pelas políticas de RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS abandoned_carts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- id do carrinho no plugin (rishi_abandoned_carts.id), como texto
  external_id TEXT NOT NULL CHECK (external_id <> ''),
  -- minúsculo e sem espaços; NULL quando o cliente só informou telefone
  email TEXT CHECK (email IS NULL OR (email = lower(btrim(email)) AND email <> '')),
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'abandoned'
    CHECK (status IN ('abandoned', 'recovered', 'converted', 'dismissed')),
  cart_url TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  reached_checkout BOOLEAN NOT NULL DEFAULT FALSE,
  -- quando a sequência de e-mails/WhatsApp foi disparada para este carrinho
  sequence_started_at TIMESTAMPTZ,
  -- por que NÃO foi disparada (ex.: 'recent_sequence'), para auditoria
  skip_reason TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_abandoned_carts_user_email_started
  ON abandoned_carts (user_id, email, sequence_started_at DESC)
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_user_seen
  ON abandoned_carts (user_id, first_seen_at DESC);

ALTER TABLE abandoned_carts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own abandoned carts" ON abandoned_carts;
CREATE POLICY "Users can view own abandoned carts"
  ON abandoned_carts FOR SELECT
  USING (auth.uid() = user_id);
-- Sem política de INSERT/UPDATE/DELETE de propósito: só o service role escreve.
