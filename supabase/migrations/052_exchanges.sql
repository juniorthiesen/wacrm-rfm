-- ============================================================
-- 052: Reverse Logistics & Exchanges Management (Trocas)
-- Stores customer exchange requests and Correios reverse tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS exchanges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  status TEXT NOT NULL DEFAULT 'codigo_gerado' CHECK (status IN ('solicitado', 'codigo_gerado', 'em_transito', 'recebido', 'concluido', 'cancelado')),
  service_code TEXT DEFAULT '04669', -- PAC Reverso
  tracking_code TEXT, -- QD...BR
  e_ticket_code TEXT, -- Codigo de postagem na agencia
  expires_at DATE,
  items JSONB DEFAULT '[]'::jsonb,
  reason TEXT,
  sender_address JSONB DEFAULT '{}'::jsonb,
  recipient_address JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exchanges_user_contact ON exchanges(user_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_customer_phone ON exchanges(customer_phone);
CREATE INDEX IF NOT EXISTS idx_exchanges_order_number ON exchanges(order_number);

ALTER TABLE exchanges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own exchanges" ON exchanges;
CREATE POLICY "Users can manage own exchanges"
  ON exchanges FOR ALL USING (auth.uid() = user_id OR auth.uid() IS NULL);
