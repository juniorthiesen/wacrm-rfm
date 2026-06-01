# Runbook — Integração WooCommerce em produção

Guia rápido pra diagnosticar e resolver os problemas mais comuns
quando a integração WC → WhatsApp não comporta como esperado.

Domínio de produção: `https://crm.auroralabs.com.br`

## Onde olhar primeiro

| Sintoma | Primeiro lugar |
| --- | --- |
| Cliente não recebeu mensagem após pedido | Vercel Logs do webhook |
| Mensagem chegou mas com texto errado | Supabase → `automation_logs` |
| Webhook devolvendo erro pra WC | Vercel Logs do webhook |
| Templates falhando com #132001 | Supabase → `message_templates` (coluna `language`) |
| Broadcast com contadores travados em 0 | Supabase → migração 003 aplicada? |

## 1. Logs do webhook (Vercel)

Vercel Dashboard → projeto `wacrm` → **Logs** → filtro pelo path
`/api/integrations/woocommerce/webhook`.

Status codes esperados:

- `200` — Recebido, processado, dispatch da automation OK
- `401 Missing signature` — WC pingando ao salvar webhook (benigno, normal)
- `401 Webhook secret not configured` — `integration_configs.webhook_secret` está NULL. **Bloqueia tudo até resolver.**
- `401 Invalid signature` — Secret no Supabase ≠ secret no WP. Re-sincronizar.
- `404 Configuration not found` — Não existe linha em `integration_configs` pra esse `user_id`. Operador esqueceu de salvar.
- `400 Integration inactive` — Linha existe mas `status='inactive'`. Operador ativar no painel.
- `429 Too Many Requests` — Estourou o rate limit (120/min). Suspeitar de loop no WC ou plugin com retry agressivo.
- `500` — Erro interno, ler stack no log.

## 2. Histórico de automations (Supabase)

```sql
-- últimas 20 execuções de automation
SELECT
  al.created_at,
  al.trigger_event,
  al.status,
  al.steps_executed,
  al.error_message,
  a.name
FROM automation_logs al
JOIN automations a ON a.id = al.automation_id
ORDER BY al.created_at DESC
LIMIT 20;
```

`status` esperado:
- `success` — todos os steps rodaram
- `partial` — algum step falhou no meio, ver `error_message`
- `error` — falhou logo no início, ver `error_message`
- `skipped` — automation existe mas condition / filter não bateu

## 3. Mensagens enviadas no inbox (Supabase)

```sql
-- últimas mensagens outbound de template
SELECT
  m.created_at,
  m.template_name,
  m.status,
  m.message_id AS meta_id,
  c.phone
FROM messages m
JOIN conversations conv ON conv.id = m.conversation_id
JOIN contacts c ON c.id = conv.contact_id
WHERE m.sender_type = 'agent' AND m.content_type = 'template'
ORDER BY m.created_at DESC
LIMIT 20;
```

`status` esperado: `sent` → `delivered` → `read`. Se ficar travado em
`sending`, Meta nunca devolveu o `message_id` (erro de API).
Se aparecer `failed`, ver Vercel logs do mesmo timestamp.

## 4. Top-3 erros que aparecem em produção

### (#132001) Template name does not exist in the translation

**Significa:** Template existe na Meta, mas não no `language_code`
que mandamos.

**Diagnóstico:**
```sql
SELECT id, name, language, status FROM message_templates
WHERE status='Approved' AND (language IS NULL OR language='');
```
Se voltar linhas → coluna `language` está vazia → fix:
```sql
UPDATE message_templates SET language='pt_BR' WHERE id='<id>';
```
Ou re-sincronizar tudo via UI: Settings → Templates → Sincronizar.

### Signature verification failed

**Significa:** O secret salvo no `integration_configs.webhook_secret`
não bate com o `Secret` configurado no webhook do WordPress.

**Fix rápido (sem perder histórico):**
1. Painel WaCRM → Settings → WooCommerce → "Regenerar secret"
2. Copiar o novo valor exibido
3. WP Admin → WooCommerce → Settings → Advanced → Webhooks → editar
   o webhook → colar no campo Secret → Save

### Contact phone not found / contact_id null em `orders`

**Significa:** O pedido WC veio sem `billing.phone` e sem `billing.email`,
ou veio com phone em formato que `normalizePhone` não reconhece.

**Diagnóstico:**
```sql
SELECT external_order_id, customer_phone, customer_email, ordered_at
FROM orders
WHERE platform='woocommerce' AND contact_id IS NULL
ORDER BY ordered_at DESC LIMIT 10;
```

Se `customer_phone` está vazio → cliente não preencheu no checkout
(comum em pedidos teste). Sem phone, automation roda mas Meta send
falha porque não há destinatário.

Se `customer_phone` tem valor mas `contact_id` é NULL → fluxo de
match phone→contact falhou. Olhar `phone-normalization.ts` pro
formato real.

## 5. Saúde geral do sistema (sanity checks)

```sql
-- WhatsApp config existe e foi tocado recentemente?
SELECT user_id, phone_number_id, updated_at
FROM whatsapp_config;

-- Webhook WC ativo?
SELECT user_id, store_url, status,
       webhook_secret IS NOT NULL AS has_secret
FROM integration_configs
WHERE platform='woocommerce';

-- Templates aprovados disponíveis?
SELECT user_id, COUNT(*) AS approved_templates
FROM message_templates
WHERE status='Approved'
GROUP BY user_id;
```

## 6. Quando me chamar (Claude / dev)

- Erro 500 recorrente no webhook que não mapeia em nenhum dos casos acima
- Volume de webhooks subiu 10x sem explicação (suspeitar de loop ou ataque)
- Mensagens chegando duplicadas pro mesmo evento (idempotência quebrou)
- Migrations pendentes detectadas pelo check em CLAUDE.md
- Qualquer mudança na estrutura de payload da Meta ou WooCommerce
