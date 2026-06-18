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
| `order_received` | `pending`, `on-hold` | Pedido criado, aguardando pagamento (PIX/boleto) — código PIX vai pro contexto |
| `order_paid` | `processing` | Pagamento confirmado |
| `order_in_separation` | `separacao` | Pedido em preparação (status custom comum em lojas Loja5) |
| `order_shipped` | `completed`, `enviado` | Pedido despachado |
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
| `{{order.tracking_code}}` | `shipment_tracking[0].tracking_number` ou meta keys `_tracking_code`, `tracking_code`, `correios_tracking`, `_tracking_number`, `tracking_number` |
| `{{order.pix_code}}` | meta keys (na ordem): `pix_copiar_colar`, `_dados_cielo_api_pix_qrcode`, `_pix_copy_and_paste`, `woo_pix_code`, `efi_pix_copy_and_paste` — cobre Cielo, Loja5, Efí e plugins genéricos |
| `{{order.items_list}}` | Lista bullet-point de `line_items` (max 10 itens, depois trunca com "... e mais N item(s)") |
| `{{order.platform}}` | sempre `woocommerce` |

Valor ausente renderiza como string vazia (nunca `undefined`).

## Exemplo: PIX recovery em 2 mensagens

Pra reproduzir o fluxo do antigo UAZAPI (1 mensagem com texto explicativo
+ 1 mensagem só com o código pra facilitar copy/paste no WhatsApp):

1. **Cria 2 templates HSM** no Meta Business Manager (categoria Utility):

   **`pedido_pix_intro`** (variáveis: nome, número do pedido):
   ```
   Olá *{{1}}*! 👋

   Recebemos seu pedido *#{{2}}*.
   Para confirmar, utilize o Pix Copia e Cola abaixo:
   ```

   **`pedido_pix_codigo`** (variável: código PIX):
   ```
   {{1}}
   ```
   > A categoria deve ser Utility com `body` simples — Meta aprova
   > templates de "código" sem header se o uso for transacional.

2. **No painel WaCRM** → Automações → Nova:
   - **Nome:** "PIX Recovery"
   - **Trigger:** `Pedido Recebido` (cobre `pending` e `on-hold`)
   - **Steps:**
     1. **Enviar Modelo** → `pedido_pix_intro` (pt_BR)
        - Variável 1: `{{customer.first_name}}`
        - Variável 2: `{{order.number}}`
     2. **Aguardar** → 2 segundos
     3. **Enviar Modelo** → `pedido_pix_codigo` (pt_BR)
        - Variável 1: `{{order.pix_code}}`
   - **Active** → ON

3. **Salva**.

Próxima vez que um pedido cair em `pending`/`on-hold` com código PIX
no meta, o cliente recebe os 2 textos em sequência.

## Exemplo: confirmação de pagamento com lista de itens

Template `pagamento_aprovado` (Utility):
```
Pagamento confirmado, *{{1}}*! 🎉

Seu pedido *#{{2}}* foi aprovado.

*Resumo:*
{{3}}

Assim que entrar em separação, te avisamos!
```

Automação:
- Trigger: `Pagamento Aprovado`
- Step: Enviar Modelo `pagamento_aprovado`
  - `{{1}}` → `{{customer.first_name}}`
  - `{{2}}` → `{{order.number}}`
  - `{{3}}` → `{{order.items_list}}` (renderiza com bullets ▪️)

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

## Magic Login (SmartCheckout / Loja5)

Quando o cliente solicita um **link de acesso rápido** (recuperação
de senha via magic link) o tema Loja5/SmartCheckout dispara um
webhook custom. O WaCRM expõe um endpoint dedicado pra recebê-lo e
encaminhar pra uma automation com botão URL dinâmico no template.

### Endpoint

```
POST https://crm.auroralabs.com.br/api/integrations/woocommerce/magic-login
  ?user_id=<SEU_USER_ID>&token=<MESMO webhook_secret>
```

Use o **mesmo `webhook_secret`** que está em Configurações →
WooCommerce. Diferente do webhook principal do WC (que tem HMAC), este
endpoint valida o secret via query string porque o hook do tema não
assina os requests.

### Configuração no WordPress (theme/plugin)

No `functions.php` (ou onde você dispara o webhook hoje), troca a URL
de destino pelo endpoint do WaCRM:

```php
$wacrm_webhook = 'https://crm.auroralabs.com.br/api/integrations/woocommerce/magic-login'
    . '?user_id=' . SEU_USER_ID
    . '&token=' . SEU_WEBHOOK_SECRET;

wp_remote_post( $wacrm_webhook, [
    'headers' => [ 'Content-Type' => 'application/json' ],
    'body'    => wp_json_encode( [
        'url'  => $magic_url,        // ex: https://dly.com.br/wc-api/smart-checkout/login/?uid=3&magic_login=ABC
        'user' => [
            'id'         => $user_id,
            'username'   => $username,
            'email'      => $email,
            'phone'      => $phone,
            'first_name' => $first_name,
        ],
    ] ),
    'timeout'  => 5,
    'blocking' => false,
] );
```

### Cria a template HSM no Meta com botão URL dinâmico

Meta Business Manager → **WhatsApp Manager → Templates → Create**:

1. **Category:** Utility
2. **Language:** Portuguese (BR) — `pt_BR`
3. **Name:** `magic_login_access` (qualquer slug)
4. **Body:**
   ```
   Olá *{{1}}*! 👋
   
   Recebemos sua solicitação de acesso rápido na DLY.
   Toque no botão abaixo para entrar direto na sua conta (válido por 15 minutos).
   ```
5. **Buttons → Add button:**
   - Type: **URL**
   - Button text: `Acessar minha conta`
   - URL type: **Dynamic**
   - Base URL: `https://dly.com.br/wc-api/smart-checkout/login/`
   - Sample URL: cola a URL completa de um exemplo (ex:
     `https://dly.com.br/wc-api/smart-checkout/login/?uid=1&magic_login=sample`)
6. **Submit for review** → espera approved (~5-30 min)

### Cria a automação no WaCRM

1. Sincroniza templates: Configurações → Modelos → **Sincronizar**
2. **Automações → Nova:**
   - **Nome:** `Magic Login → WhatsApp`
   - **Trigger:** `Magic Login Solicitado`
   - **Active** → ON
3. **Adiciona step:** `Enviar Modelo`
   - Template: `magic_login_access` (pt_BR)
   - Variável `{{1}}`: `{{customer.first_name}}`
   - **Sufixo do botão URL:** `{{magic_login.suffix}}` ← campo novo
4. **Salva**

Próxima vez que um cliente solicitar magic link, o WP dispara o webhook,
o WaCRM cria/encontra o contato, executa a automação e o cliente recebe
o WhatsApp com botão "Acessar minha conta" — tap = login direto.

### Variáveis disponíveis no contexto magic-login

| Placeholder | Valor |
| --- | --- |
| `{{magic_login.url}}` | URL completa (ex: `https://dly.com.br/wc-api/smart-checkout/login/?uid=3&magic_login=ABC`) |
| `{{magic_login.suffix}}` | Só a query string (ex: `?uid=3&magic_login=ABC`) — use no sufixo do botão Dynamic |
| `{{magic_login.uid}}` | `3` |
| `{{magic_login.token}}` | `ABC` (valor do param `magic_login`) |
| `{{customer.first_name}}` | `Junior` |
| `{{customer.name}}` | nome completo (montado a partir de first_name + last_name) |
| `{{customer.phone}}`, `{{customer.email}}` | os do payload |

### Por que dois esquemas (HMAC no webhook principal, token query string aqui)?

O webhook principal `/woocommerce/webhook` é criado pelo WC nativo, que
assina cada POST com `x-wc-webhook-signature` (HMAC-SHA256 + secret).
O hook custom do tema (magic login) não usa essa pipeline — é um
`wp_remote_post` direto. Pra não te obrigar a escrever HMAC em PHP no
tema, esse endpoint aceita o mesmo secret na query string, validado
com `crypto.timingSafeEqual` no Node. Mesmo nível de segurança que um
HMAC pré-imagem desde que o secret não vaze.

## TODO — Fase 2 (UI)

- Builder de automation no painel mostrando os triggers `order_*`
- Step "Enviar Template" com selector visual (sync das templates já
  existe em `/api/whatsapp/templates/sync`)
- Tela em Settings pra conectar WC sem mexer em SQL
