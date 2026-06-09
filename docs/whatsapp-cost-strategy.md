# Estratégia de economia — WhatsApp Cloud API

Guia prático para reduzir o custo de disparos no projeto wacrm-rfm, baseado em duas referências externas (Marcelo Távora — canal V4 Marketing Digital) consolidadas em estratégia aplicável ao nosso código.

**Fontes:**
- https://www.youtube.com/watch?v=T0mreC1k4zk — "Como usar API oficial do WhatsApp de forma gratuita"
- https://www.youtube.com/watch?v=H9AXymcVcig — "Guia definitivo da API oficial"

Transcrições foram lidas e sintetizadas em 2026-06-09. Confirme com a Meta antes de cada grande disparo — os valores e regras citados são referência e mudam.

---

## 1. Os 4 tipos de mensagem e o que custam

| Tipo | Custo BR (ref) | Aprovação Meta? | Quando é grátis |
|---|---|---|---|
| **Marketing** template | ~R$ 0,30/msg | Sim | **Nunca** — sempre pago, mesmo dentro de janela 24h |
| **Utility** template | ~R$ 0,03/msg (~10% do marketing) | Sim | **Sim, se houver janela de serviço aberta** com o contato |
| **Authentication** template | ~R$ 0,035/msg | Sim | Igual Utility |
| **Service / free-form** | **R$ 0** | Não | Sempre, desde que dentro de janela 24h |

> **Regra mental**: Marketing = sempre paga. Utility = paga se contato "frio", grátis se janela aberta. Free-form = só existe dentro de janela aberta, sempre grátis.

## 2. O que abre a janela de 24h

A "janela de serviço" abre quando a Meta recebe **qualquer interação do contato** dirigida ao nosso número:

- Mensagem de texto enviada pelo contato
- **Clique num botão Quick Reply de um template nosso** (Meta conta como mensagem do contato)
- Clique num link `wa.me/...?text=...` que pré-preenche uma mensagem e o contato confirma o envio
- Resposta a uma mensagem nossa (reply)

A janela dura 24h a partir da última interação. Cada nova interação **reseta** o contador.

## 3. As duas estratégias centrais

### 3.1. Utility-abridor + Free-form de oferta (a "sacada")

Substitui o disparo Marketing por uma cascata Utility → Service.

```
[Disparo broadcast]
  └─ UTILITY template com Quick Reply button ─── pago, ~R$ 0,03/contato
        ↓ contato clica no botão
  └─ janela 24h aberta
        ↓ automation dispara em segundos
  └─ FREE-FORM com pitch de oferta ─────────── grátis
        ↓ se contato responde
  └─ FREE-FORM follow-up ───────────────────── grátis (janela renova a cada interação)
```

Numa base de 10k contatos com 15% de taxa de clique no QR:
- **Marketing puro**: 10.000 × R$ 0,30 = **R$ 3.000**
- **Utility-abridor**: 10.000 × R$ 0,03 = R$ 300 (a oferta vai grátis para os 1.500 que clicaram)
- **Economia: 90%**

**Pega importante**: o conteúdo da Utility precisa **realmente parecer atualização de status**, não promo disfarçada. Senão Meta rejeita ou (pior) aprova e depois reclassifica como Marketing — ver seção 5.

### 3.2. Lead magnet com link pré-preenchido

Para captação inbound (não-broadcast):

```
[Vídeo, anúncio, post, e-mail, landing page]
  └─ link wa.me/55XX?text=Quero%20o%20material
        ↓ contato clica e confirma
  └─ janela 24h aberta (custo zero pra abrir)
        ↓ automation responde com o material
  └─ FREE-FORM com material + perguntas de qualificação ─── grátis
        ↓ pós-entrega
  └─ FREE-FORM com convite/oferta ──────────── grátis
```

Esse fluxo é **100% gratuito do lado WhatsApp** — paga só o tráfego que gera o clique.

## 4. Templates Utility que a Meta aprova (diretrizes)

A Meta publica padrões aceitos como Utility. Funcionam:

- Confirmação de cadastro em lista, lançamento, evento, webinar
- Confirmação de pedido / compra
- Atualização de status de envio, separação, embarque, entrega
- Resumo de conta, fatura, extrato
- Aviso de mudança em pedido (atraso, troca, devolução)
- "Seu material está pronto" / "Seu cupom foi atualizado"
- Lembrete de agendamento

**Não passam como Utility** (vão como Marketing mesmo se você submeter como Utility):

- "Promoção", "desconto", "oferta", "últimas peças" como tema central
- Convites pra eventos comerciais sem cadastro prévio
- Reativação de cliente inativo
- "Vimos que você se interessou em X" sem evento concreto que gerou isso

## 5. O risco silencioso: reclassificação Utility→Marketing

A Meta pode reclassificar um template Utility aprovado para Marketing **sem aviso prévio** (avisa por e-mail, mas é fácil passar batido). Quando isso acontece, o próximo disparo custa 10x o esperado.

**Mitigação obrigatória antes de qualquer broadcast >1k contatos:**

1. Abrir Meta Business Manager → WhatsApp Manager → Modelos de Mensagem
2. Verificar categoria atual de cada template a ser usado
3. Se mudou, decidir: reescrever a mensagem ou aceitar o custo

**No nosso projeto** (ver seção 7) isso vira: o sync `/api/whatsapp/templates/sync` já puxa a categoria atual da Meta. O frontend de Broadcasts deveria mostrar um aviso quando a categoria local do template diverge da categoria da Meta, ou bloquear o disparo grande até confirmar.

## 6. Outras regras anti-bloqueio

- **Conta nova**: limite de 250 disparos/dia. Sobe com volume + qualidade. Comece a aquecer com antecedência se você tem lançamento marcado.
- **3 marketing sem engajamento em 24h**: a 3ª não é entregue (Meta segura), não cobra. Não tente forçar — vira penalidade de qualidade do número.
- **Quality rating**: ficou "low" → limite de disparos cai. Recupera mandando menos e com mais engajamento.
- **Opt-out obrigatório**: footer "responda SAIR" ou similar em todo template Marketing. Já é convenção nos templates do projeto.

## 7. Como isso mapeia no código do wacrm-rfm

### Estado atual

| Componente | Status |
|---|---|
| `message_templates.buttons` JSONB | Existe no schema, **UI não usa**, sender desconhecido — investigar |
| Detecção de janela 24h por contato | **Não existe** — webhook não escreve um `window_open_until` |
| Free-form sender via API | Existe (`POST /api/whatsapp/send` chama `meta-api.ts` com `type: text`) |
| Submissão de template pra Meta | **Não existe** — só sync read-only |
| Suppression de "já comprou da promo" | Possível via `orders` + `line_items`, **não automatizado** |
| Frequency cap por contato | **Não existe** |

### O que precisa ser construído pra usar a estratégia

1. **Coluna `conversation_window_until TIMESTAMPTZ` em `contacts`**, atualizada por:
   - Webhook de inbound message → setar `NOW() + interval '24 hours'`
   - Recebimento de evento `interactive.button_reply` ou `interactive.list_reply` → mesma coisa
   - Cada outbound free-form bem-sucedido **não** estende a janela (só inbound estende — regra da Meta)

2. **Helper `isWindowOpen(contactId)` em `lib/whatsapp/`** — usado por sender, automations e flows pra decidir entre template vs free-form.

3. **Broadcast sender com modo "smart"**:
   - Se contato com janela aberta → manda free-form (grátis)
   - Senão → manda template (Utility de preferência, Marketing só se forçado)
   - UI do broadcast permite escolher: "Modo econômico" (utility-abridor) vs "Marketing direto"

4. **Automation pronta "QR click → free-form"**:
   - Trigger: `button_click` num template marcado como abridor
   - Action: enviar free-form com payload customizado (a "oferta")
   - Já existe o motor de automations, só falta esse tipo de trigger se ainda não suporta `button_click`.

5. **Endpoint `POST /api/whatsapp/templates/submit`** — pega um Draft local e submete pra Meta via `POST graph.facebook.com/{WABA_ID}/message_templates`. Volta como Pending. Resolve o gap de submissão manual no Business Manager.

6. **Alerta de reclassificação**: depois de cada sync, comparar categoria local vs Meta. Se mudou, marcar template com flag visual no broadcast picker.

7. **Frequency cap simples**: tabela `broadcast_sends` (já existe via `broadcast_recipients`?) consultada antes de enfileirar — se contato recebeu N templates Marketing nos últimos X dias, pula.

### Ordem sugerida de implementação

1. `conversation_window_until` em contacts + atualização no webhook (1 migration + 1 patch no webhook)
2. `isWindowOpen()` helper + teste
3. Endpoint de submissão de template
4. Migration seed dos templates DLY adaptados (utility-abridor onde aplicável)
5. Automation "QR click → free-form de oferta"
6. Sender smart no broadcast
7. UI: badge "janela aberta", aviso de reclassificação, toggle de modo econômico

## 8. Aplicação prática: campanha "Multiplique-se" DLY

Mapeamento dos 7 templates originais para o modelo econômico:

| Original | Tipo | Estratégia |
|---|---|---|
| T1 lançamento regular | Marketing | **Reformular como Utility-abridor** "Sua área tem novidade" + Quick Reply "Ver agora" → free-form com 3x99,99 |
| T2 lançamento Plus | Marketing | **Reformular como Utility-abridor** "Atualização da linha PLUS" + QR → free-form |
| T3 acesso antecipado VIP | Marketing | **Reformular como Utility-abridor** "Acesso de cliente preferencial liberado" + QR → free-form |
| T4 reforço meio | Marketing | **Reformular como Utility-abridor** "Resumo da sua wishlist" + QR → free-form |
| T5 carrinho abandonado | Marketing | **Utility legítimo** "Status do seu carrinho #X" + QR "Finalizar" → free-form (já é trigger individual) |
| T6 última chance | Marketing | **Mantém Marketing** — urgência factual de fim de campanha precisa do template. Disparar só pra quem **não** abriu janela nos 14 dias anteriores. Quem abriu janela recebe free-form (grátis). |
| T7 pós-compra | Utility | **Mantém Utility + QR** pra abrir janela e fazer cross-sell free-form depois |

**Resultado estimado** (assumindo 15% CTR no QR, base de 20k contatos):

| Cenário | Custo |
|---|---|
| 6 Marketing + 1 Utility como originalmente proposto | ~R$ 36.000 |
| Estratégia econômica (5 Utility-abridor + 1 Marketing T6 + 1 Utility T7) | ~R$ 4.200 |
| **Economia** | **~88%** |

## 9. Ferramentas externas mencionadas (referência)

Os vídeos recomendam Unichet ou ManyChat como camada acima da Meta. **Não usamos isso aqui** — o wacrm-rfm fala direto com Meta Cloud API. A vantagem da nossa stack é zero markup de ferramenta intermediária; a desvantagem é que precisamos construir as primitivas (janela, frequency cap, automations, submissão) que essas ferramentas já oferecem prontas. Esse doc é o checklist do que falta.
