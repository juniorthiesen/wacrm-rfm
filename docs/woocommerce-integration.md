# Integração WooCommerce + Mensagens Transacionais

Como conectar uma loja WooCommerce ao WaCRM e disparar templates
HSM aprovadas pela Meta automaticamente em cada mudança de status
do pedido.

## Como funciona

```
Cliente fecha pedido
        │
        ▼
WooCommerce muda status (pending → processing → completed)
        │
        ▼
WC dispara webhook → POST /api/integrations/woocommerce/webhook
        │
        ▼
WaCRM valida HMAC, salva contato + order, detecta status change
        │
        ▼
runAutomationsForTrigger('order_paid', { order, customer })
        │
        ▼
Automação ativa com trigger 'order_paid' executa
        │
        ▼
Step `send_template` chama Meta API com a template aprovada
        │
        ▼
Cliente recebe WhatsApp com nome + número do pedido + valor
```

Cada **transição** de status dispara um trigger. Re-envios do mesmo
status (WC manda webhook em qualquer edição da order) **não disparam
nada** — o engine compara `status` novo com o anterior antes de
chamar o trigger.

## Triggers disponíveis

| Trigger WaCRM | Status WooCommerce | Quando |
| --- | --- | --- |
| `order_received` | `pending` | Pedido criado, aguardando pagamento |
| `order_paid` | `processing` | Pagamento confirmado |
| `order_shipped` | `completed` | Pedido despachado / concluído |
| `order_cancelled` | `cancelled` | Pedido cancelado |
| `order_refunded` | `refunded` | Reembolso emitido |
| `order_failed` | `failed` | Pagamento falhou |

Statuses customizados (de plugins) não disparam trigger — adicione no
`statusToTrigger` em `src/app/api/integrations/woocommerce/webhook/route.ts`
se precisar.

## Configuração — passo a passo

### 1. Cria a integração no Supabase

Hoje, sem UI no painel ainda (Fase 2), você cria a linha direto via
SQL Editor:

```sql
insert into integration_configs (user_id, platform, status, webhook_secret)
values (
  '<SEU_USER_ID_DO_AUTH>',
  'woocommerce',
  'active',
  '<UM_SECRET_QUALQUER_GERE_AGORA>'   -- mesmo valor vai no WC
)
returning *;
```

> Pega seu `user_id` em **Authentication → Users** no Supabase.

### 2. Configura o webhook no WooCommerce

WordPress → **WooCommerce → Settings → Advanced → Webhooks** → **Add webhook**:

| Campo | Valor |
| --- | --- |
| Name | WaCRM |
| Status | Active |
| Topic | `Order updated` (cobre todos os status changes) |
| Delivery URL | `https://crm.auroralabs.com.br/api/integrations/woocommerce/webhook?user_id=<SEU_USER_ID>` |
| Secret | o mesmo valor que você pôs em `webhook_secret` no passo 1 |
| API Version | `WP REST API Integration v3` |

Salva → **Save webhook**.

> Pra também receber a criação do pedido, adiciona um segundo webhook
> com Topic `Order created`.

### 3. Cria as automações

Hoje (Fase 1, sem UI) você cria via SQL. Exemplo: enviar template
`pagamento_aprovado` quando o pedido for pago.

```sql
-- 3.1 cria a automation
insert into automations (user_id, name, trigger_type, trigger_config, is_active)
values (
  '<SEU_USER_ID>',
  'Pagamento Aprovado → WhatsApp',
  'order_paid',
  '{}'::jsonb,
  true
)
returning id;
-- copia o id retornado pra usar abaixo

-- 3.2 cria o step send_template
insert into automation_steps (automation_id, step_type, step_config, position)
values (
  '<AUTOMATION_ID_DO_PASSO_ANTERIOR>',
  'send_template',
  '{
    "template_name": "pagamento_aprovado",
    "language": "pt_BR",
    "variables": {
      "1": "{{customer.name}}",
      "2": "{{order.number}}",
      "3": "{{order.total}}"
    }
  }'::jsonb,
  0
);
```

Repete pros outros triggers (`order_received`, `order_shipped`, etc.)
com a template apropriada.

## Variáveis disponíveis no contexto

Você pode usar essas dentro das `variables` do step (em qualquer
ordem, com qualquer placeholder posicional):

| Placeholder | De onde vem |
| --- | --- |
| `{{customer.name}}` | `billing.first_name + last_name` ou contact existente |
| `{{customer.first_name}}` | `billing.first_name` |
| `{{customer.last_name}}` | `billing.last_name` |
| `{{customer.phone}}` | `billing.phone` normalizado |
| `{{customer.email}}` | `billing.email` |
| `{{order.number}}` | `payload.number` (ou `payload.id` se number ausente) |
| `{{order.total}}` | `payload.total` parseado como float |
| `{{order.currency}}` | `payload.currency` (default `BRL`) |
| `{{order.status}}` | status novo, igual ao trigger |
| `{{order.tracking_code}}` | `shipment_tracking[0].tracking_number` ou `meta_data._tracking_number` |
| `{{order.platform}}` | sempre `woocommerce` |

Valor ausente renderiza como string vazia (nunca `undefined`).

## Testes rápidos

### Verifica que o webhook está recebendo

Cria uma order de teste no WC → muda status no WC Admin (Pending →
Processing) → na Vercel:

```
Logs → Functions → /api/integrations/woocommerce/webhook
```

Deve mostrar 200 OK. Se 401, o `webhook_secret` no `integration_configs`
não casa com o `Secret` configurado no WC.

### Verifica que o trigger disparou

Supabase → **Table Editor → automation_logs** — deve aparecer linha
com `trigger_event = 'order_paid'` (ou o que for), `status = 'success'`
ou `'partial'`.

### Verifica que a template foi enviada

Supabase → **Table Editor → messages** — deve aparecer mensagem
outbound com `message_type = 'template'` recente, com o
`whatsapp_message_id` retornado pela Meta.

E mais importante: o cliente recebe no WhatsApp. 🎯

## Limites e gotchas

- **WC re-envia webhook em qualquer edição da order** (mudança de nota
  interna, alteração de produto). O engine só dispara automation se
  `status` for diferente do anterior — mas isso depende de a row já
  existir no banco. Se você dropar a tabela `orders`, o próximo
  upsert vai "ver" o status atual como "novo" e disparar trigger.
- **Templates HSM precisam estar aprovadas no Meta**. Status `APPROVED`,
  categoria `Utility` (não Marketing), e o `language_code` precisa
  ser exato (`pt_BR`, não `pt-BR` ou `pt`).
- **Janela de 24h não se aplica** a templates HSM aprovadas — você
  pode mandar a qualquer momento.
- **Custo**: cada template Utility é cobrada por conversa (24h)
  iniciada. Aproximadamente R$ 0,08–0,15 por conversa no Brasil
  (consulta tabela atual da Meta).

## TODO — Fase 2 (UI)

- Builder de automation no painel mostrando os triggers `order_*`
- Step "Enviar Template" com selector visual (sync das templates já
  existe em `/api/whatsapp/templates/sync`)
- Tela em Settings pra conectar WC sem mexer em SQL
