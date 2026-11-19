# Handoff: canal de e-mail + régua de reativação no WaCRM

> Documento vivo. Atualize a seção **7. Log de progresso** e os checkboxes da seção **5** a cada marco.
> O `HANDOFF.md` da raiz é de outra tarefa (jun/2026, pause/resume de campanhas); este aqui é o da frente "canal de e-mail".

**Início:** 2026-11-19 · **Branch:** `feat/email-channel` (local, a partir de `main`; **nada commitado, nada enviado ao GitHub, nenhuma migração aplicada em produção**)

---

## 1. Objetivo e por que existe

Dono: Junior (DLY Lingerie). Decisão dele em 2026-11-19: o WaCRM passa a ser o **lugar único das réguas de relacionamento** (e-mail + WhatsApp), com as mesmas regras servindo hoje o site Woo (dly.com.br) e, no futuro, o site Next.js (repo `D:\pagina do produto - dly`, loja em `kit.dly.com.br`). Depois, a ideia é **empacotar e vender** o CRM para outras lojas.

Ordem combinada: primeiro provar o retorno na DLY (com grupo de controle), só então virar produto multi-cliente.

O que o WaCRM **já tem** (não reescrever): RFM e recência (`contact_rfm_metrics`, migrações 025–039), construtor de públicos (`audience_rows`, 040/045/046), campanhas com envio gradual (`/api/broadcasts/drip`, claim com `FOR UPDATE SKIP LOCKED`, 041), automações com passos de espera/condição (`src/lib/automations/engine.ts`), integração Woo (pedidos, webhook, sync), `contacts.opted_out` (049, hoje só da palavra "SAIR" no WhatsApp).

O que **faltava** e é o escopo desta frente:

| Lacuna | Evidência |
|---|---|
| Não existe canal de e-mail | nenhum remetente de e-mail em `src/`; só WhatsApp (`lib/whatsapp`, `lib/automations/meta-send.ts`) |
| `contacts.phone` é `NOT NULL` | `supabase/migrations/001_initial_schema.sql`; cadastros só com e-mail (rodapé do site) não cabem |
| Descadastro/consentimento só para WhatsApp | `opted_out` é global e vem da palavra SAIR |
| Sem limite de frequência entre automações | nada impede 2 mensagens de marketing no mesmo dia |
| Multi-cliente é "um usuário = um cliente" | toda tabela tem `user_id` + RLS por `auth.uid()`; não há organização/equipe |
| Cron de campanhas roda num VPS de terceiro | `workers/broadcast-drip-cron` chama `/api/broadcasts/drip` a cada 5 min a partir do servidor do Woo; `vercel.json` só tem 2 crons diários |
| Código específico da DLY misturado | `src/app/troca`, `src/lib/correios`, seeds `022_seed_promo_dly_multiplique_se`, referências a dly.com.br em várias rotas |

---

## 2. Dados que sustentam a prioridade (AutomateWoo, DLY, 2025-03 → 2026-08-26)

O AutomateWoo (plugin pesado do Woo) foi desativado em 26/08/2026; o banco do Woo ainda guarda os logs. Resultado por fluxo (conversão atribuída por clique, **piso, não teto**; PROMO de setembro estava com medição desligada):

| Fluxo | Clientes que receberam | Pedidos | Receita | Conversão |
|---|---|---|---|---|
| Carrinho abandonado (12 h) | 3.807 | 125 | R$ 27,7 mil | **3,3%** |
| volta20 (180–1.200 dias sem comprar, cupom `VOLTEI20` R$ 20, "48 h") | 27.042 | 54 | R$ 12,4 mil | 0,20% |
| Envio manual | 28.169 | 34 | R$ 6,8 mil | 0,12% |
| Compra única (90–180 d, "3 por R$ 99") | 10.678 | 17 | R$ 3,1 mil | 0,16% |
| 90 d + pijama | 4.422 | 7 | R$ 1,9 mil | 0,16% |
| BLACK | 27.762 | 2 | R$ 0,3 mil | 0,007% |

Leituras: carrinho abandonado é o que mais vende; reativação vende pouco por e-mail, mas é barata; quem compra, compra em ~5 dias; **disparos amplos não valem**.

Problemas do legado que a nova régua **não pode repetir**:
1. Cupom `VOLTEI20` dizia "válido 48 h" mas nunca expirou, sem mínimo, sem limite por pessoa (ainda usado).
2. Sem descadastro de verdade: 1 descadastro em 109 mil clientes (e-mails eram HTML cru, sem link de saída). Risco de spam e LGPD.
3. Sem grupo de controle, a atribuição era só por clique.

Audiência hoje na DLY (clientes únicos por tempo desde a última compra paga): <90 d: 1.301 · 90–179 d: 1.595 · 180–364 d: 4.058 · 1–2 anos: 7.331 · >2 anos: 15.948 (13.884 deles com 1 pedido só). **Decisão:** não disparar para >2 anos; começar pelas faixas 90–364 dias (5.653 pessoas), poucas por dia, por causa de reputação do domínio.

Custo de canal (`docs/whatsapp-cost-strategy.md`): WhatsApp marketing ≈ R$ 0,30/msg; e-mail ≈ centavos. Régua = e-mail; WhatsApp só para segmentos de maior valor.

---

## 3. Régua de reativação proposta (Fase 2, ainda NÃO construída)

Entra quem passou 90 dias sem comprar; sai ao comprar, descadastrar ou terminar a sequência.

| Dia | E-mail | Oferta |
|---|---|---|
| 90 | "Sentimos sua falta": novidades e kits | sem cupom |
| 97 | idem, com cupom R$ 20 (mínimo R$ 100, como o `volta20` atual) | **único por pessoa, 72 h, restrito ao e-mail** |
| 111 | última chance | cupom do dia 97 ainda válido |
| depois | 1 lembrete a cada 90 dias, no máximo 2 | |
| 1 ano sem reação | para de enviar | |

Obrigatório: modo de **ensaio** (conta quem entraria, sem enviar), **grupo de controle de 10%**, limite diário por conta, **uma mensagem de marketing por cliente a cada X dias somando todas as automações**, descadastro de um clique.

---

## 4. Decisões de arquitetura (tomadas)

- **Provedor de e-mail: Resend** (o site Next já usa, `src/lib/server/email.ts` no repo da loja). Chamar a API por `fetch`, sem SDK, para não somar dependência. Interface `EmailProvider` para trocar por SES depois.
- **Canal como abstração**: e-mail e WhatsApp compartilham contato, consentimento e limite de frequência; cada canal tem seu remetente.
- **Supressão por e-mail, não só por contato**: tabela própria (`email_suppressions`) chaveada por `(user_id, email)`, porque o cadastro do rodapé nem sempre vira contato.
- **Cupom e "primeira compra" vivem na loja**: o WaCRM pede ao conector da loja (Woo hoje, Next depois) para criar/validar. No Woo isso já está implementado no snippet 164 (ver seção 8).
- **Sem big-bang**: cada fluxo do Woo é movido para o WaCRM em paralelo e só é desligado no Woo depois de provar resultado igual ou melhor.
- **Nada em produção sem aval**: migrações do WaCRM são aplicadas à mão (PowerShell + Management API do Supabase + Credential Manager, ver `HANDOFF.md` raiz). **Escrever o arquivo `.sql` e parar**; quem aplica é o Junior (ou peça autorização explícita).

---

## 5. Plano e status

Legenda: `[x]` feito · `[~]` em andamento · `[ ]` a fazer

### Fase 0 — Fundação
- [x] 0.1 Migração `supabase/migrations/053_email_channel.sql` **escrita, NÃO aplicada**: `contacts.phone` nullable + índice (não único) por e-mail; `email_config`; `email_suppressions`; `email_messages`. Unicidade por e-mail ficou para depois (pode haver e-mails duplicados vindos do Woo; deduplicar antes de criar índice único)
- [x] 0.2 `Contact.phone` agora é `string | null` em `src/types/index.ts`
- [x] 0.3 Typecheck apontou 6 pontos de UI (corrigidos). **Auditoria de runtime feita**: todos os caminhos de envio de WhatsApp já recusam contato sem telefone (`automations/meta-send.ts`, `flows/meta-send.ts` ×2, `whatsapp/send/route.ts`, `broadcasts/drip` e o público de `audience_rows`, que só devolve telefones válidos); a mensagem de erro de `automations/meta-send.ts` ("contact not found for this user") é enganosa para esse caso, mas o comportamento é seguro. A UI de criar contato ainda exige telefone (`contacts.phoneRequired`); contatos só-e-mail por enquanto só nascem por integração
- [ ] 0.4 (adiado de propósito) `audience_rows` excluir suprimidos de e-mail: a checagem **autoritativa** é feita no envio (`sendEmail`); excluir no público é só otimização e exige migração com `DROP` das assinaturas antigas (ver 048/049). Fazer junto da Fase 2

### Fase 1 — Canal de e-mail
- [x] 1.1 `src/lib/email/provider.ts` (interface `EmailProvider`) + `resend.ts` (fetch, `Idempotency-Key`, timeout 20 s) + `store.ts` (interface de persistência `EmailStore` + implementação Supabase)
- [x] 1.2 `src/lib/email/layout.ts`: layout do design system DLY (faixa preta, logo, cabeçalho, itens com total, caixa de cupom, botão verde, nota, rodapé preto com "Cancelar inscrição"), `renderVars` (`{{first_name|linda}}`), escape de HTML e URLs só http(s)
- [x] 1.3 `unsubscribe.ts` (token HMAC sem expiração) + rota pública `src/app/api/public/unsubscribe/route.ts` (GET mostra confirmação **sem** descadastrar; POST descadastra, serve também o um-clique RFC 8058) + cabeçalhos `List-Unsubscribe`/`List-Unsubscribe-Post` em `send.ts`
- [x] 1.4 `limits.ts`: teto diário de marketing (dia local America/Sao_Paulo) + intervalo mínimo por endereço somando todas as automações; transacional nunca é limitado
- [x] 1.5 `webhook.ts` + rota pública `src/app/api/webhooks/resend/route.ts` (assinatura Svix com tolerância de 5 min, segredo por conta ou `RESEND_WEBHOOK_SECRET`); bounce permanente e reclamação suprimem o endereço; status nunca regride
- [x] 1.6 Passo `send_email` no motor de automações: `SendEmailStepConfig` + `'send_email'` em `src/types/index.ts`; `case 'send_email'` em `src/lib/automations/engine.ts` (monta o e-mail com `src/lib/email/step.ts`, envia por `sendEmail`; contato sem e-mail, endereço suprimido e limite atingido viram **"skipped" sem falhar a automação**; canal não configurado e erro do provedor **falham o passo**); `validate.ts` valida o passo; editor visual (`automation-builder.tsx`) com formulário completo; rótulos em `translations.ts` (en + pt-BR). `interpolate()` do motor ganhou o formato com texto reserva `{{customer.first_name|linda}}` (retrocompatível). Não precisou de migração: `automation_steps.step_type` é TEXT sem CHECK
- [x] 1.6b Configuração: `src/lib/email/config.ts` (validação pura + `toPublicConfig` que nunca devolve segredos), `GET/PUT /api/email/config` (sessão do usuário, RLS; chave do Resend e segredo do webhook criptografados com `encrypt()`, só escrita), `POST /api/email/test` (envia só para o e-mail do próprio usuário logado, transacional, 5/min), painel `src/components/settings/email-panel.tsx` na aba **E-mail** de Configurações (texto fixo em pt-BR, como o painel do WooCommerce)
- [x] 1.7 Testes (vitest): `unsubscribe`, `layout`, `limits`, `send` (orquestração completa com banco em memória), `webhook`
- [x] 1.8 Verificação final desta etapa: `npm run typecheck` 0 erros · `eslint` limpo em **todos os arquivos que mexi** · `npm run test` **331/331** (261 antigos + 70 novos) · `npm run build` (com as variáveis falsas da CI) passou e gerou `/api/email/config`, `/api/email/test`, `/api/public/unsubscribe` e `/api/webhooks/resend`.
  Nota: `npx eslint src/app/api/public` acusa 10 erros `no-explicit-any` em `src/app/api/public/exchange/**`: **pré-existentes** (arquivos não tocados), não são desta frente

### Fase 2+ (depois de 0 e 1 aprovadas)
- [x] 2 Régua de reativação **implementada no código (2026-11-19), não aplicada em produção, nenhum envio real**. Detalhes, como ligar e limitações na **seção 14**. Peças: gatilho `recency_reached`, inscrição única com coorte (tratamento/controle) e teto diário, ensaio, relatório tratamento × controle, condição `purchased_since_enrollment`, modelo pronto "Régua de reativação (90+ dias sem comprar)", migração `054_regua_reativacao.sql`
- [~] 3 Conector de loja: **só `createCoupon` e só Woo** (`src/lib/commerce/connector.ts`, `woo-coupons.ts`, passo `create_coupon`). Faltam `validateFirstPurchase`, `getOrdersSince` e o adaptador do site novo (depende de 5c/5d)
- [~] 4 Mover carrinho abandonado, boas-vindas do rodapé e régua do Woo para o WaCRM (em paralelo). **Carrinho abandonado: código pronto (seção 16)**, falta ligar (migração 055, segredo de cron, webhook no plugin, pausar o Rishi). Faltam boas-vindas do rodapé e a régua do Woo
- [ ] 5 **INTEGRAÇÃO OBRIGATÓRIA com o site novo (`D:\pagina do produto - dly-trabalho`), decidida pelo Junior em 2026-11-19: "precisamos fazer essa integração".** Hoje os dois projetos **não conversam** (revisão na **seção 13**, com as lacunas e a ordem mínima). Subtarefas, em ordem:
  - [ ] 5a Migração do `platform` (`orders` e `integration_configs`) + endpoint de eventos assinado no WaCRM (`POST /api/integrations/dly-site/events`), com mapeamento de status (`shipped → enviado`), centavos → reais e deduplicação de histórico legado
  - [ ] 5b Site emite `order.paid/shipped/refunded` e `checkout.abandoned` (empurra eventos; **não** usar o segredo de admin do site)
  - [ ] 5c Site: cupom com `customer_email`, `per_customer_limit`, `first_order_only` + e-mail do cliente em `resolveCartCoupon` (`/api/coupons/validate`, `/api/payment/pix`, `/api/payment/card`, `/api/shipping/quote`)
  - [ ] 5d Site: endpoint de criar cupom com **token de escopo mínimo** + aplicar cupom por link (`?cupom=`)
  - [ ] 5e Site: formulário de cadastro + campo de consentimento + `POST /api/public/subscribe` no WaCRM
  - [ ] 5f Site: restauração de carrinho por link (token) para o e-mail de abandono
  - Fases 2 e 3 rodam pelo **conector do Woo** enquanto o Woo estiver no ar; o conector do site entra quando 5c/5d existirem
- [ ] 6 Produto: organização/equipe, cobrança, onboarding, isolar o que é da DLY

---

## 6. Como trabalhar neste repo (regras que importam)

- Next.js **16**: a documentação local está em `node_modules/next/dist/docs/` e o `AGENTS.md` manda lê-la antes de escrever código; APIs diferem do que se conhece.
- Comandos: `npm run typecheck`, `npm run lint`, `npm run test` (vitest, `environment: node`, testes ao lado do código), `npm run build`. A CI roda lint → typecheck → test → build com variáveis falsas (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ENCRYPTION_KEY`, `META_APP_SECRET`); o `vitest.config.ts` espelha isso. Não crie leitura `process.env.X!` no topo de módulo que quebre os testes sem essas variáveis.
- Dois clientes Supabase: anon (RLS) em `src/lib/supabase/{client,server}.ts`; service-role em `src/lib/automations/admin-client.ts` e `src/lib/flows/admin-client.ts` (só no servidor).
- Segredos guardados criptografados com `src/lib/whatsapp/encryption.ts` (`encrypt`/`decrypt`, AES-256-GCM, chave `ENCRYPTION_KEY`). Reuse para a chave do Resend.
- Rotas protegidas: ao criar rota nova no topo, ajuste `protectedPaths` em `src/middleware.ts`. **Rotas públicas** (descadastro, webhook do Resend) precisam ficar **fora** da proteção.
- Migrações: números sequenciais em `supabase/migrations/` (a última existente é `052_exchanges`). Em funções com parâmetros novos, **`DROP` das assinaturas antigas** antes de `CREATE OR REPLACE`, senão fica overload ambíguo (aconteceu na 046 → corrigido na 048).
- `.env*` não são versionados (só `.example`). **Nunca** coloque segredo em arquivo versionado nem neste documento.
- Rate limit em memória (`src/lib/rate-limit.ts`): serve para instância única.

---

## 7. Log de progresso

- **2026-11-19** — Análise concluída (dados do AutomateWoo, estado do WaCRM, plano em fases). Branch `feat/email-channel` criada. Este documento criado.
- **2026-11-19** — Fase 0 + núcleo da Fase 1 implementados (sem aplicar nada em produção). Linha de base antes de mexer: typecheck 0 erros, 261 testes. Depois: typecheck 0 erros, 312 testes, lint limpo.
  Arquivos novos: `supabase/migrations/053_email_channel.sql` · `src/lib/email/{types,provider,resend,store,unsubscribe,limits,layout,send,webhook,test-utils}.ts` · testes `src/lib/email/{unsubscribe,layout,limits,send,webhook}.test.ts` · rotas `src/app/api/public/unsubscribe/route.ts` e `src/app/api/webhooks/resend/route.ts`.
  Alterados: `src/types/index.ts` (`Contact.phone: string | null`) e 6 componentes/hook com proteção de telefone nulo (`step3-personalize.tsx`, `use-broadcast-sending.ts`, `contact-detail-view.tsx`, `contact-sidebar.tsx`, `message-thread.tsx`, `deal-card.tsx`).
  Pendente imediato (na época): passo `send_email` no motor (1.6), tela de configuração (1.6b), auditoria de runtime do telefone nulo (0.3), `npm run build`.
- **2026-11-19 (mesma sessão, ainda depois)** — **Fase 2 implementada no código** (seção 14). Decisão do Junior: registrar a integração com o site novo como pendência obrigatória (tarefas 5a–5f) e seguir para a Fase 2 usando o conector do Woo. Verificação: typecheck 0 · lint limpo nos arquivos tocados · **366 testes** (eram 331) · `npm run build` ok com `/api/automations/recency-cron`, `/api/automations/[id]/dry-run`, `/api/automations/[id]/report`. **Nada commitado, nada aplicado em produção, nenhum e-mail enviado, nenhum cupom criado.** A SQL das **053 e 054 foi executada e validada num Postgres descartável em memória (PGlite)**, ver o item seguinte do log. Ainda **não foi aplicada em nenhum banco real**.
- **2026-11-19 (revisão do diff, com 3 correções)** — Revisão completa do diff (18 arquivos alterados, ~5 mil linhas novas, nenhum segredo, nada commitado). Achados e correções:
  1. **(alto) Pessoas "queimadas" sem aviso.** O motor **registra o erro de um passo no log da automação e não lança exceção**, então o `runErrors` do cron quase nunca dispara. Ativar a régua com o canal de e-mail inativo (ou o Woo sem escrita) inscrevia até `daily_cap` pessoas por dia cujo primeiro passo falhava em silêncio, e elas nunca mais eram inscritas. **Correção:** `src/lib/automations/regua-preflight.ts` + `evaluateRegueReadiness()` em `regua.ts`: o cron **não inscreve ninguém** enquanto houver bloqueio (canal inativo, `NEXT_PUBLIC_SITE_URL` ausente, sem integração com a loja para o passo de cupom); o ensaio mostra os bloqueios em vermelho.
  2. **(alto) O limite diário de e-mail "comia" os e-mails da régua.** Em regime, cada coorte soma e-mails em dias diferentes (D0 + D7 + D14 ≈ 3× o teto por dia) e um e-mail acima do limite vira `skipped` **sem nova tentativa**. **Correção:** o teto efetivo da régua = `min(daily_cap, floor(daily_limit_de_email / nº_de_e-mails_de_marketing_da_sequência))` (ex.: limite 150 com 3 e-mails → 50 pessoas/dia). Vale para o cron e para o ensaio (que mostra o teto configurado e o efetivo). Outras automações que usem o mesmo canal consomem o mesmo limite: dimensionar o limite para o conjunto.
  3. **(médio) RFM defasado.** O RFM é recalculado 1×/dia, então quem comprou hoje cedo ainda podia estar "parado" e receber "sentimos sua falta". **Correção:** `recency_candidates()` e `recency_candidates_count()` agora **excluem quem tem pedido pago dentro da janela** (por contato ou e-mail), mesmo com o snapshot defasado (SQL + teste novo em `scripts/sql-check/test-sql.mjs`).
  Também: o relatório (`/report`) e o painel passaram a mostrar as **execuções da sequência por status** (sucesso/falha) lidas de `automation_logs`, porque é o único lugar onde uma falha do motor aparece.
  **Ainda NÃO resolvido (conhecido):** (a) passo que falha no meio da sequência (ex.: Woo fora do ar no D7) **não é reexecutado**: a pessoa fica inscrita e a sequência morre para ela; (b) e-mail `skipped` por limite diário ou intervalo mínimo **não é reenfileirado**; (c) o webhook do Resend responde diferente para mensagem desconhecida (200) e assinatura inválida (401), um oráculo mínimo de existência de ids (ids não são adivinháveis); (d) segredos de cron são comparados com `===` (igual aos crons existentes); (e) `store_url` do Woo vem da configuração do cliente e é usado em `fetch` (risco de SSRF ao virar multi-cliente; o código de sincronização existente tem o mesmo padrão). Itens (a) e (b) merecem uma "fila de nova tentativa" antes de rodar com volume.
  Verificação depois das correções: typecheck 0 · lint limpo nos arquivos da frente · **373 testes** · SQL em PGlite **47/47** · build ok.
- **2026-11-19 (fila de nova tentativa)** — Construída a fila de nova tentativa (seção 15): `retry.ts`, `RetryStep` no motor, status `retrying` no log, flag `ambiguous` em `sendEmail`, correção do status final do log (`partial`/`failed`/`settleRunStatus`) e `engine.retry.test.ts` (9 testes). As dívidas (a) e (b) acima estão resolvidas. Verificação: typecheck 0 · eslint limpo · **391 testes** · `npm run build` ok. Nada commitado, nada aplicado em banco real.
- **2026-11-19 (plugin de checkout: carrinho abandonado + link mágico + crons no VPS)** — Seção 16. Rota `POST /api/integrations/woocommerce/carts` (webhook do módulo Rishi, que envia JSON em lote a cada 10 min), migração 055, modelo "Carrinho abandonado (e-mail, 3 lembretes)", `respect_min_gap`, link mágico por e-mail, crons do VPS em `scripts/deploy/vps-cron/`. 416 testes, SQL 56/56, build ok. **Achados:** o pinger do drip no VPS recebe **401 desde 31/08** (segredo desalinhado com a Vercel); a única chave Woo com escrita é a do **Bling** (criar uma "wacrm" própria). Nada commitado, nada aplicado, plugin e VPS **não** alterados.
- **2026-11-19 (validação da SQL)** — Montado o esquema inteiro (migrações 001–054) em PGlite com stubs do Supabase: **51/54 aplicam**; as 3 que falham (**018, 019, 020**, IA) falham só porque o PGlite não tem a extensão `vector`, sem relação com 053/054. **053 e 054 aplicam sem erro.** Teste funcional `scripts/sql-check/test-sql.mjs`: **45/45 verificações** (telefone opcional, CHECKs, janela de recência, dedupe por e-mail, opt-out/supressão/e-mail inválido, contato só-e-mail, isolamento entre clientes, inscrição única + `ON CONFLICT DO NOTHING` retornando 0 linhas, relatório tratamento × controle incl. pedidos não pagos/anteriores/fora da janela e casamento por e-mail, permissões só `service_role`, RLS). Desempenho com 20 mil contatos / 20 mil pedidos / 8 mil inscritos: ~100–140 ms por função (PGlite/WASM). Achado útil: **não existe `CHECK` em `automations.trigger_type`**, então o gatilho novo `recency_reached` não precisa de migração. Ainda a confirmar no Supabase real: RLS/permissões com os papéis verdadeiros e `ALTER PUBLICATION`/storage (stubs no teste).
- **2026-11-19 (mesma sessão, depois)** — **Fase 0 e Fase 1 concluídas no código.** Feitos 0.3 (auditoria: seguro), 1.6 (passo `send_email` + validação + editor), 1.6b (API + painel de configuração + teste). Arquivos novos desta rodada: `src/lib/email/{step,config}.ts` + `step.test.ts` + `config.test.ts` · `src/app/api/email/{config,test}/route.ts` · `src/components/settings/email-panel.tsx`. Alterados: `engine.ts`, `validate.ts`, `validate.test.ts`, `automation-builder.tsx`, `translations.ts`, `types/index.ts`, `settings/page.tsx`. Typecheck 0, lint limpo (arquivos tocados), 331 testes, build ok. **Nada commitado, nada aplicado em produção.** Próximo: aplicar a migração 053 e ligar o canal (seção 10), depois a Fase 2 (seção 12).

---

## 8. Contexto do lado Woo (dly.com.br), para não duplicar nem quebrar

Servidor: VPS `191.101.78.101`, WP em `/home/dly/htdocs/dly.com.br`, comandos via `sudo -u dly wp --path=...`. Código customizado fica em **snippets** do plugin Code Snippets (tabela `wp_snippets`).

Ativo hoje no Woo:
- **Snippet 163** `Carrinho abandonado - e-mails no padrão DLY`: variáveis `{dly_items}` e `{dly_oi}` para o e-mail de carrinho do módulo Rishi (WC Smart Checkout).
- **Rishi (módulo de carrinhos abandonados)**: sequência de 3 e-mails (1 h, 24 h, 72 h), com cupom dinâmico de 5% na 3ª; ligada em 2026-11-19. O plugin antigo (Cart Abandonment Recovery) teve só o template 1 desativado (`is_activated=0`).
- **Snippet 164** `Newsletter do rodapé - cupom de boas-vindas 5%`: formulário do rodapé (Contact Form 7 #142) cria cupom `BEMVINDA5-XXXXXX` (5%, 1 uso, restrito ao e-mail, 30 dias, **só primeira compra**) e manda e-mail no design system; lista em `wp_dly_newsletter`; botão do e-mail aplica o cupom sozinho (`?dly_cupom=`).
- **AutomateWoo**: desativado desde 26/08/2026 (10 fluxos ainda marcados como publicados e 552 itens na fila; **não reativar**, voltaria a disparar tudo).
- Cupom público `bemvinda` (5%, mínimo R$ 249, sem validade) existe e é muito usado (591 pedidos): considerar alinhar com o cupom de boas-vindas do rodapé.
- Cron do sistema no VPS: `/etc/cron.d/dly-wp-cron` (a cada minuto) e `/usr/local/bin/wacrm-drip-cron.sh` (chama `/api/broadcasts/drip` do WaCRM a cada 5 min). O segundo script tem um segredo em texto simples; **não copie para lugar nenhum**.
- Notificações de pedido por WhatsApp (webhooks "Pedido aprovado/enviado/criado PIX") eram do AutomateWoo e pararam em 26/08. **Pendente confirmar** se outro caminho cobre.

Memória do projeto da loja: `C:\Users\junio\.claude\projects\D--pagina-do-produto---dly\memory\` (notas `project_carrinho_abandonado_rishi.md`, `project_newsletter_rodape.md`).

---

## 9. Perguntas em aberto

1. Janela de frequência padrão entre mensagens de marketing (sugestão: 3 dias entre quaisquer duas, 7 dias para a mesma automação).
2. Cupom da régua: R$ 20 com mínimo R$ 100 (histórico) ou percentual?
3. Modelo de "organização" (multi-cliente): fazer já na Fase 0 ou só na Fase 6? Hoje a recomendação é só na Fase 6, **desde que** nenhuma tabela nova da Fase 0/1 assuma que `user_id` é o dono final (use `user_id` como hoje, mas isole o acesso em um único helper para trocar depois).
4. Domínio de envio do Resend (SPF/DKIM de `dly.com.br`) ainda não verificado.

---

## 10. Checklist para colocar no ar (nada disto foi feito)

1. **Revisar o diff** (`git diff main`, mais os arquivos novos) e decidir como commitar. A branch é `feat/email-channel`, local. Nada foi commitado.
2. **Aplicar `supabase/migrations/053_email_channel.sql` em produção** (mesmo processo das migrações anteriores, ver `HANDOFF.md` raiz: PowerShell + Management API; **o Junior aplica ou autoriza**). É aditiva e segura antes do deploy do código; `contacts.phone` passa a aceitar NULL.
3. **Variáveis de ambiente no servidor (Vercel)**: `NEXT_PUBLIC_SITE_URL` (URL pública do CRM; **obrigatória** para e-mail de marketing, é a base do link de descadastro). Opcionais: `EMAIL_UNSUBSCRIBE_SECRET` (se ausente, deriva de `ENCRYPTION_KEY`; trocar invalida links já enviados) e `RESEND_WEBHOOK_SECRET` (fallback do segredo do webhook).
4. **Resend**: criar conta/chave de API e **verificar o domínio de envio**. ATENÇÃO: `dly.com.br` já envia e-mail do Woo por SMTP (WP Mail SMTP, remetente `ecom@dly.com.br`). Ao acrescentar o Resend, o registro **SPF precisa incluir os dois provedores** (um único TXT `v=spf1 ...`; dois registros SPF quebram ambos) e o DKIM do Resend entra como CNAMEs próprios. Considere um **subdomínio** (ex.: `m.dly.com.br`) só para o CRM, para não arriscar o e-mail transacional do Woo.
5. **Cadastrar o webhook no Resend** apontando para `https://<crm>/api/webhooks/resend`, eventos delivered/bounced/complained/opened/clicked; copiar o segredo `whsec_...`.
6. **Configurações → E-mail** no CRM: colar a chave e o segredo, remetente, **limite diário baixo (ex.: 50–150) enquanto o domínio esquenta**, logo/cores, ativar, clicar em **Enviar e-mail de teste** e conferir caixa de entrada + cabeçalhos.
7. Só então criar automações com o passo **Enviar E-mail**.

---

## 11. Limitações conhecidas / dívidas

- **Sem tela para ver `email_messages` e `email_suppressions`** (listar envios, bloqueados, descadastros, reativar manualmente). Hoje só por SQL. Fazer antes de usar em volume.
- **Contato só-e-mail**: o banco aceita, a UI de criar contato ainda exige telefone. Cadastro do rodapé do site precisará de uma rota pública (`POST /api/public/subscribe`, Fase 4).
- **`audience_rows` não exclui suprimidos de e-mail** (adiado, ver 0.4). A checagem autoritativa é no envio, então é seguro; o público só fica maior do que o efetivamente enviado.
- **Teto diário e intervalo por endereço não são atômicos**: dois envios simultâneos para o mesmo endereço podem passar pela checagem ao mesmo tempo. Aceitável no volume atual; usar a chave de idempotência/lock por e-mail se isso virar problema.
- **Unicidade de e-mail em `contacts`** não imposta (pode haver duplicados do Woo). Deduplicar e então criar índice único.
- **Descadastro** só do tipo "marketing" por endereço (não por automação/lista). Suficiente por ora.
- **Sem rastreamento de abertura/clique próprio**: depende dos eventos do Resend (`opened`, `clicked`); pixel/links rastreados precisam estar ligados no painel do Resend.
- **Texto do painel de e-mail é fixo em pt-BR** (não passa por `translations.ts`), como o painel do WooCommerce. Se o produto for multilíngue, migrar.
- **Idempotência de reenvio**: `sendEmail` cria a linha em `email_messages` e usa o id dela como `Idempotency-Key`, mas o motor de automações **não reenvia sozinho** um passo que falhou com `retryable: true`; hoje a falha só aparece no log da automação.

---

## 12. Desenho sugerido para a Fase 2 (régua de reativação) — IMPLEMENTADO, ver seção 14 (com ajustes)

Objetivo: executar a régua da seção 3 sobre quem está há 90+ dias sem comprar, com **ensaio** e **grupo de controle**.

O que já existe e deve ser reaproveitado: `contact_rfm_metrics.recency_days`; `audience_rows(p_min_recency_days, p_max_recency_days, p_not_contacted_days, ...)` (migrações 040/045/046; já exclui `opted_out`); passos `wait`/`condition` e o novo `send_email`; `sendEmail` (suprime, limita, registra).

O que falta (proposta):
1. **Tabela `automation_enrollments`** `(automation_id, contact_id, enrolled_at, cohort 'treatment'|'control', UNIQUE(automation_id, contact_id))`: garante que cada pessoa entra **uma vez** por régua e guarda o grupo. Controle (10%, sorteio estável por hash do `contact_id`) é inscrito mas **não recebe nada**; serve para medir o ganho real.
2. **Cron diário** (`/api/automations/enroll-cron`, em `vercel.json`, protegido por `AUTOMATION_CRON_SECRET` como o cron de espera): para cada automação "por recência", busca candidatos com `audience_rows` na janela configurada, **limita por dia** (começar em ~150), inscreve e dispara `executeAutomation` para o grupo de tratamento. Janela da DLY: 90–364 dias primeiro; 1–2 anos depois; **não disparar >2 anos**.
3. **Gatilho novo** `recency_reached` (ou reaproveitar `time_based`, ver `trigger-meta.ts`/`engine.ts`; hoje `time_based` não carrega a regra de recência) com config `{ min_days, max_days, daily_cap, control_percent }`.
4. **Cupom por pessoa**: passo `create_coupon` que chama o **conector da loja** (Fase 3) e devolve o código em `context.vars.coupon_code`, usado em `{{vars.coupon_code}}` no passo `send_email` (já suportado: caixa de cupom aparece só quando a variável não é vazia). No Woo: `POST /wp-json/wc/v3/coupons` (credenciais já guardadas em `integration_configs`; ver `src/lib/commerce/woocommerce-client.ts`), com validade, limite 1 uso, restrição ao e-mail e regra de primeira compra/mínimo. **Não repetir o erro do `VOLTEI20`** (cupom sem validade, sem limite por pessoa).
5. **Relatório**: por coorte (tratamento × controle) e por etapa (`campaign_key`), pedidos pagos em até 7 dias após a inscrição (`orders.ordered_at`, `orders.contact_id`), receita, ticket e descadastros/reclamações. É isto que valida (ou não) a régua antes de pensar em produto.
6. **Ensaio**: endpoint/ação que só **conta e lista** quem entraria hoje, sem enviar nada, para o Junior aprovar antes de ligar.

Referência de qualidade do legado (AutomateWoo): reativação ≈ 0,2% de conversão por cliente atingido (≈ R$ 0,46 por cliente); carrinho abandonado ≈ 3,3%. Se o grupo de controle mostrar ganho menor que o custo, **não** escalar.

---

## 14. Fase 2 implementada: régua de reativação (2026-11-19)

### O que existe
| Peça | Onde |
|---|---|
| Migração (**não aplicada em produção; SQL validada em PGlite, 45 verificações**, ver `scripts/sql-check/`) | `supabase/migrations/054_regua_reativacao.sql`: tabela `automation_enrollments` (UNIQUE `(automation_id, email)`), funções `recency_candidates`, `recency_candidates_count`, `regua_report` (só `service_role`; `REVOKE` de `PUBLIC/anon/authenticated`), índice `idx_orders_user_email_lower` |
| Regras puras + persistência | `src/lib/automations/regua.ts` (+ `regua.test.ts`): `parseRecencyConfig`, `assignCohort` (hash estável de automação+e-mail), `planRecencyEnrollment`, `executeRecencyEnrollment`, `summarizeRegueReport`, `RegueStore`/`supabaseRegueStore` |
| Cron diário de inscrição | `src/app/api/automations/recency-cron/route.ts` (GET, `Authorization: Bearer CRON_SECRET` ou `x-cron-secret`) |
| Ensaio (não grava nada) | `POST /api/automations/[id]/dry-run` |
| Relatório | `GET /api/automations/[id]/report?days=7` |
| Painel no editor | `src/components/automations/recency-panel.tsx` (aparece ao editar uma automação com gatilho "Dias sem comprar") |
| Gatilho / condição / passo novos | `recency_reached`, condição `purchased_since_enrollment`, passo `create_coupon` (tipos, `engine.ts`, `validate.ts`, `trigger-meta.ts`, editor, i18n) |
| Conector de loja | `src/lib/commerce/connector.ts` (`StoreConnector`, `loadStoreConnector`, `generateCouponCode`) + `woo-coupons.ts` (POST `/wp-json/wc/v3/coupons`) |
| Modelo pronto | `reativacao_90_dias` em `src/lib/automations/templates.ts` (aparece na lista de modelos de Automações; nasce **inativo**) |
| Cron de espera | `src/app/api/automations/cron/route.ts` agora aceita o segredo do Vercel e **esvazia a fila em lotes** (antes: só `x-cron-secret` e 50 por chamada) |
| Agendamento | `vercel.json`: `recency-cron` 12:00 UTC e `automations/cron` 12:30 UTC (o RFM já roda 06:00 UTC) |

### Como funciona
1. O cron escolhe, por automação ativa de gatilho `recency_reached`, quem está na janela de recência (`contact_rfm_metrics.recency_days` entre `min_days` e `max_days`), com e-mail válido, sem `opted_out`, fora de `email_suppressions` e ainda não inscrito, **deduplicado por e-mail**, os mais recentes primeiro.
2. Respeita o **teto diário** (`daily_cap` menos os já inscritos hoje no dia local de São Paulo; o controle conta no teto).
3. Cada pessoa recebe uma coorte: **controle** (`control_percent`%, padrão 10) é inscrita e medida mas **nunca contatada**; **tratamento** roda a automação. A inscrição é gravada **antes** de rodar (uma queda nunca faz alguém receber a sequência duas vezes); se o tempo (48 s) acaba, quem não foi alcançado não é inscrito e fica para o dia seguinte.
4. Contexto inicial da execução: `customer.{name,first_name,email}` e `vars.enrolled_at` (usado pela condição de compra).
5. O relatório compara tratamento × controle: pedidos **pagos** (`processing/completed/enviado/separacao`, com ou sem `wc-`) feitos **depois** da inscrição e dentro de N dias, casando por contato **ou** e-mail; devolve conversão, receita, efeito estimado (pontos percentuais, compras e R$ a mais) e avisos (sem controle, controle < 100, janela ainda aberta).

### Ajuste em relação ao desenho original (seção 3)
A cadência passou a ser **relativa à inscrição**, não a dias absolutos de inatividade, e o cupom ficou coerente com a data do último lembrete: **D0** e-mail sem cupom → **D7** (se não comprou) cria cupom + e-mail com o cupom → **D14** (se ainda não comprou) "seu cupom vence em 3 dias". O cupom vale **10 dias** (R$ 20, mínimo R$ 100, uso único, preso ao e-mail). Motivo: o desenho antigo dizia "72 h" e depois "ainda válido no dia 111", o que não fechava.

### Como ligar (nada disto foi feito)
1. A SQL já passou no PGlite (`scripts/sql-check/`, ver README). Aplicar a **053 e a 054** primeiro num **projeto Supabase de teste/branch** (confirma RLS e permissões com os papéis reais) e conferir `SELECT * FROM recency_candidates_count(...)` com um tenant real; depois em produção (processo da seção 10).
2. A **chave do WooCommerce** em `integration_configs` precisa de **leitura e escrita** (hoje serve só para sincronizar pedidos). Sem escrita, o passo `create_coupon` falha.
3. Variável **`CRON_SECRET`** (ou `AUTOMATION_CRON_SECRET`) definida no servidor. O Vercel passa a chamar os dois crons com `Bearer`. **Atenção ao plano do Vercel**: o plano Hobby só permite 2 crons diários; `vercel.json` agora tem **4**. Se for Hobby, usar o pinger externo (como o do `/api/broadcasts/drip` no VPS) ou reduzir.
4. Garantir que o **RFM está calculado** (cron 06:00 UTC ou `/api/rfm/recalculate`); sem ele, ninguém é elegível.
5. Criar a automação pelo modelo **Régua de reativação (90+ dias sem comprar)** (nasce inativa). Conferir/ajustar os textos e links (hoje apontam para `https://dly.com.br/`).
6. Abrir a automação e rodar o **Ensaio**: ele lista elegíveis, quantos entrariam hoje (tratamento/controle), amostra mascarada e **avisos de pré-voo** (canal de e-mail inativo, `NEXT_PUBLIC_SITE_URL`, limite diário de e-mail menor que o teto, falta de integração com a loja, ninguém elegível, sem controle).
7. Ativar com **teto baixo no primeiro dia** (ex.: 20–50), olhar `email_messages`/relatório, e só então subir.
8. Janela inicial sugerida: **90–364 dias** (5.653 pessoas na DLY); 1–2 anos depois; **>2 anos não**.
9. Ler o **relatório** só depois de a janela (7 dias) fechar para as primeiras coortes; com controle < 100 pessoas a diferença ainda pode ser acaso.

### Limitações / dívidas conhecidas
- **Fila de nova tentativa: IMPLEMENTADA (2026-11-19, ver seção 15).** O cron **nunca inscreve** enquanto o pré-voo tiver bloqueios (`regua-preflight.ts`) e reduz o teto ao que o limite diário de e-mail comporta.
- **`create_coupon` só no Woo.** O site novo precisa de 5c/5d (cupom por e-mail/cliente e endpoint de criação) antes de virar um segundo `StoreConnector`.
- **A regra "só primeira compra" do cupom de boas-vindas (snippet 164 do Woo) NÃO é aplicada** nos cupons desta régua (são para quem já comprou). Eles têm as restrições nativas do Woo: 1 uso, 1 por cliente, uso individual, e-mail, validade, mínimo.
- A condição `purchased_since_enrollment` casa pedidos **só por `contact_id`** (o relatório casa por contato **ou** e-mail). Se o mesmo cliente tiver outro contato com o mesmo e-mail, a compra pode não interromper a sequência; o relatório conta certo. Melhorar casando também por `customer_email`.
- **Granularidade diária das esperas e das novas tentativas**: com o cron de espera 1×/dia (Vercel), uma espera de 7 dias vence "dentro de 24 h" e o backoff de 1 h de uma nova tentativa na prática vira "na próxima rodada" (e as de 4/12/24 h também só andam 1×/dia). Para precisão maior, um pinger a cada 5–15 min no `/api/automations/cron`.
- **Cupom não é cancelado** se a pessoa comprar antes de usá-lo (expira sozinho em 10 dias). Aceitável; poderia ser desativado via API do Woo.
- **Sem tela de lista de inscritos** (quem entrou, em qual coorte, com qual cupom): só no relatório agregado e por SQL em `automation_enrollments`.
- Os textos do modelo e a regra de cupom (R$ 20 / R$ 100 / 10 dias) são **da DLY**: ao virar produto, mover para configuração por cliente.
- O hash de coorte usa `automation_id:e-mail`: duplicar a automação **embaralha** os grupos (esperado).

---

## 15. Fila de nova tentativa (2026-11-19)

Fecha as dívidas (a) e (b) da "revisão do diff": passo que falha de forma transitória no meio da sequência, e e-mail `skipped` por limite.

### Como funciona
- `src/lib/automations/retry.ts`: `RetryStep(message, kind)` + `planRetry(kind, attempt, now)`.
  - `error` (falha transitória): espera **1 h, 4 h, 12 h, 24 h**, no máximo **4** novas tentativas.
  - `limit` (e-mail adiado por limite diário ou intervalo mínimo): tenta de novo **depois da próxima meia-noite de São Paulo + 10 min**, no máximo **6** vezes (cerca de 6 dias).
- O passo lança `RetryStep` no `engine.ts` (`send_email` e `create_coupon`). No `catch` de `executeStepsFrom`, o motor **estaciona** uma linha em `automation_pending_executions` com `next_step_position = step.position` (o **mesmo** passo), mesmo `parent_step_id`/`branch` e o contexto salvo; o cron `/api/automations/cron` retoma de lá.
- Contador por passo em `context.vars._retry_<stepId>`. Esgotou: o passo falha de verdade ("… esgotou as N novas tentativas") e aparece no log como falha.
- O resultado no log ganha o status **`retrying`** (relógio âmbar em `automations/[id]/logs`), com o horário da próxima tentativa.
- **Não são reenviados** (decisão deliberada): e-mail **ambíguo** (timeout/sem status HTTP ou 2xx sem id: pode ter sido enviado → erro simples "sem confirmação do provedor"), suprimido, falha permanente (4xx não 429), `invalid_email`. O Resend recebe `idempotencyKey = id da linha`, mas uma nova tentativa cria nova linha, por isso não se reenvia no caso ambíguo.
- `create_coupon`: falha ao carregar o conector ou ao criar vira nova tentativa; o cupom já criado fica na variável do contexto e **não é recriado** ao retomar outro passo.

### Ajustes de status do log (corrigidos junto)
- `executeStepsFrom` agora devolve `true` se algo ficou estacionado (Wait ou nova tentativa) num ramo; o escopo raiz marca a execução como **`partial`** em vez de `success`.
- `appendResults`: se qualquer passo, mesmo dentro de um ramo, falhou, a execução **não** vira `success` (antes o raiz sobrescrevia a falha do ramo).
- Ao retomar um escopo **aninhado**, `settleRunStatus(logId)` fecha o log (`success`/`failed`) quando não resta nenhuma linha pendente da mesma execução.

### Testes
`src/lib/automations/engine.retry.test.ts` (9 testes, banco Supabase falso em memória): limite diário estaciona o e-mail no dia seguinte e mantém o cupom; esgotamento após 6; falha do cupom e conector ausente reenfileirados; ambíguo, suprimido e falha permanente **não** reenfileirados; quem já comprou termina sem cupom nem e-mail. Total: **391 testes**, typecheck 0, eslint limpo, `npm run build` ok.

### Limitações
- Granularidade depende da frequência do cron de espera (ver seção 14).
- Um `Wait` dentro de um ramo continua usando o mesmo mecanismo; o fechamento do log agora passa por `settleRunStatus`.
- Não há reenvio manual por tela (só olhando `automation_pending_executions`/logs); `runs` do relatório pode mostrar `partial` enquanto há tentativas pendentes.

---

## 16. Integração com o plugin de checkout do Woo: carrinho abandonado e link mágico (2026-11-19)

Pedido do Junior: "começa a integrar… o plugin do checkout tem como colocar um webhook… carrinho abandonado, link mágico… podemos rodar as crons no servidor do site… a chave tem no D:". Esta rodada usa o **Woo (dly.com.br), que é o que está no ar hoje**; o site novo continua nas tarefas 5a–5f.

### O que o plugin faz (lido no servidor, somente leitura)
Plugin **WC Smart Checkout**, módulo "Rishi" (`wc-smart-checkout/modules/abandoned-carts`). `Webhook/Sender.php` faz um **POST JSON a cada 10 min** com um **array** de carrinhos cuja situação mudou. Sem cabeçalho de assinatura: a autenticação só pode ir na URL. Campos por carrinho: `id`, `email`, `phone`, `first_name`, `last_name`, `cart_contents[{name,price,quantity,product_url,image_url}]`, `cart_total`, `currency`, **`cart_url` (link de recuperação: restaura o carrinho e preenche o checkout)**, `cart_token`, `checkout_url`, `cart_status` (`abandoned|recovered|converted|dismissed`), `reached_checkout`, `store_url`, `time`. Considera "abandonado" após **15 min** sem atividade (`ABANDONED_AFTER_MINUTES`). Resposta não-2xx = o plugin reenvia o lote.
A URL do webhook fica na opção `rishi_abandoned_carts_webhook_url` (tela do plugin). **Hoje não está apontada para o WaCRM.**

### O que foi construído (código; nada em produção)
| Peça | Onde |
|---|---|
| Migração `055_abandoned_carts.sql` (tabela, `UNIQUE(user_id, external_id)`, RLS só leitura do dono; **validada em PGlite, 9 verificações novas, 56/56 no total**) | `supabase/migrations/` + `scripts/sql-check/test-sql.mjs` |
| Rota do webhook `POST /api/integrations/woocommerce/carts?user_id=<uuid>&token=<webhook_secret>` (mesmo segredo da integração Woo, comparação em tempo constante, rate limit, 500 em falha parcial porque tudo é idempotente) | `src/app/api/integrations/woocommerce/carts/route.ts` |
| Leitura/validação do payload (e-mail ou telefone basta; URL só http(s) **e do host da loja**; máx. 200 por lote) | `src/lib/commerce/carts.ts` (+ teste) |
| Regras: idempotência por carrinho, **uma sequência por e-mail a cada 4 dias**, grava antes de disparar, `recovered/converted/dismissed` só atualizam | `src/lib/commerce/cart-ingestion.ts` (+ teste) |
| Contexto da automação: `cart.recovery_url` (e `cart.checkout_url` = o mesmo link, para os modelos de WhatsApp que já existem), `cart.items_list`, `cart.total`, `cart.product_names`, `customer.*`, `vars.enrolled_at` (a condição "comprou depois" encerra a sequência) | `buildCartContext` |
| Modelo **Carrinho abandonado (e-mail, 3 lembretes)**: espera 45 min → e-mail 1 (~1 h) → 23 h → e-mail 2 (~24 h) → 48 h → cupom 5 % por 7 dias + e-mail 3 (~72 h); cada passo só segue se a pessoa não comprou | `templates.ts` (`carrinho_abandonado_email`) |
| `respect_min_gap: false` no passo de e-mail: a sequência foi pedida pelo cliente, senão o intervalo de 3 dias bloquearia o 2º e o 3º e-mail; **o teto diário e a lista de supressão continuam valendo** | `SendEmailStepConfig`, `SendEmailInput.ignoreMinGap`, `send.ts` |
| **Link mágico por e-mail**: o handler do webhook de login agora aceita contato só com e-mail (antes exigia telefone); modelo **Link mágico de acesso (e-mail)** (transacional, `{{magic_login.url}}`) | `webhook/route.ts` (`handleMagicLogin`), `templates.ts` (`link_magico_email`) |
| Crons no servidor do site: `wacrm-cron.sh` + `/etc/cron.d/wacrm` (`automations/cron` a cada 5 min, `recency-cron` 12:00 UTC); `vercel.json` voltou a ter só RFM e aniversário | `scripts/deploy/vps-cron/` |

Verificação: typecheck 0 · eslint limpo (arquivos tocados) · **416 testes** (eram 391) · SQL 56/56 · `npm run build` ok (rota `/api/integrations/woocommerce/carts` gerada).

### Achados no servidor (somente leitura) que mudam o plano
1. **O pinger do `/api/broadcasts/drip` no VPS está recebendo 401 desde ~31/08/2026** (42 mil linhas no `/var/log/wacrm-drip.log`; último 200 em 31/08). O segredo do script do VPS **não bate** com o que a Vercel tem hoje. Ou seja, **envio de campanhas por drip não anda há ~2,5 meses**, e os crons novos teriam o mesmo problema. É preciso alinhar o segredo (Vercel `AUTOMATION_CRON_SECRET`/`CRON_SECRET` = `/etc/wacrm-cron.env`) antes de qualquer coisa.
2. **Chaves do Woo na pasta `D:\CHAVES_CONSOLIDADAS`** (conferido pelos 7 últimos caracteres contra `wp_woocommerce_api_keys`): `WOOCOMMERCE_CONSUMER_KEY` é **leitura e escrita, mas é a chave do Bling** ("bling", usada hoje); `WOO_CONSUMER_KEY` é **só leitura** ("claude"). O passo `create_coupon` precisa de escrita: **criar uma chave própria "wacrm" com leitura e escrita** em vez de reaproveitar a do Bling (revogar uma não derruba a outra).
3. O Rishi continua mandando os **próprios** 3 e-mails de recuperação (1 h/24 h/72 h, snippet 163). **Ligar o webhook para o WaCRM sem desligar os do Rishi duplica os e-mails.** Ordem: ligar o WaCRM → conferir um carrinho de teste → pausar o Rishi (`Campaigns::set_paused(true)`, ver memória do carrinho abandonado).

### Migrações 053, 054 e 055 APLICADAS EM PRODUÇÃO (2026-11-19, autorizado pelo Junior: "pode continuar")
Projeto Supabase de produção do WaCRM: **`oqwfyceyiixzdjjmntiy`** (`supabase-canary-curtain`, sa-east-1, integração Vercel). Aplicadas pela Management API (processo do `HANDOFF.md` do repo; token da CLI no Windows Credential Manager `Supabase CLI:access-token`; **não** usar a CLI contra produção), na ordem 053 → 054 → 055, cada arquivo numa requisição (atômica). Antes: lido o estado (produção estava até a 052; sem broadcast em "enviando", 1 pausado e 9 enviados; nenhuma execução de automação pendente; 34.858 contatos e 48.183 pedidos). Depois, verificado: 5 tabelas novas com **RLS ligada**; `contacts.phone` agora aceita nulo (0 contatos sem telefone); as 3 funções da régua executáveis **só pelo `service_role`** (anon/authenticated = false); índices criados; `recency_candidates_count` responde; `/login` do app segue 200. Não há tabela de histórico de migrações em produção (nada a registrar). **Rollback:** ver os DROPs listados na conversa/053–055 (tabelas `abandoned_carts`, `automation_enrollments`, `email_*`, as 3 funções, os 3 índices e `ALTER COLUMN phone SET NOT NULL`).
**O app em produção ainda roda o código ANTIGO** (deploy `eb96366`): as tabelas existem, mas nada as usa até publicar a branch `feat/email-channel` (nada commitado ainda). Publicar = commit + push/merge em `main` (auto-deploy na Vercel).

### 401 do cron — causa achada e segredo trocado (2026-11-19, autorizado pelo Junior)
**Causa:** a Vercel (projeto `wacrm-rfm`, time `juniorthiesens-projects`) ganhou uma `CRON_SECRET` em **30/08/2026** (mesmo dia do primeiro 401), e o código usa `CRON_SECRET ?? AUTOMATION_CRON_SECRET`: a nova variável passou a valer e o script do VPS ficou com o valor antigo. Em 31/08 13:00–13:05 houve dois 200 (deploy em transição) e depois 401 de novo.
**Feito:** gerado um segredo novo (32 bytes), **`CRON_SECRET` da Vercel (produção, sensível) atualizada**, produção **republicada** (mesmo commit `eb96366`, deploy `dpl_HWECLyv9…`, READY) e **`/etc/wacrm-cron.env` criado no VPS** (600, root). Os crons do próprio Vercel (RFM, aniversário) continuam certos porque a Vercel envia `Bearer $CRON_SECRET`. Verificado com o cron do RFM (inofensivo): segredo novo → 200 (por `x-cron-secret` e por `Bearer`), segredo errado → 401. O valor fica só em `D:\CHAVES_CONSOLIDADAS\wacrm_cron.env`.
**ATUALIZAÇÃO (17:30 UTC): drip religado e funcionando.** O Junior conferiu a campanha `8229db09…` ("Recompra 365d+ - Frete Ago26"): já estava **Sent** (1.821 enviadas, 179 falhas de 2.000), nada pendente. O `wacrm-drip-cron.sh` agora lê o segredo de `/etc/wacrm-cron.env` (backup em `/usr/local/bin/wacrm-drip-cron.sh.bak-20261119`) e a primeira execução devolveu `{"campaigns":0,"summary":[]} HTTP:200`. O texto abaixo é o histórico do que estava pendente antes disso.
**(histórico) Não feito de propósito:** o `/usr/local/bin/wacrm-drip-cron.sh` do VPS **ainda tinha o segredo antigo** (401). Trocar religa o envio de campanhas, e a campanha `8229db09-e464-4a50-8c3e-025b9dcd20b0` ficou parada em "enviando" (0 enviados) desde 31/08: se ainda estiver nesse estado, o drip volta a enviá-la a toda a audiência. **Conferir a tela de Campanhas antes** (cancelar/pausar se estiver velha) e então trocar a linha `SECRET=` do script pelo valor do `/etc/wacrm-cron.env` (há backup do env antigo em `.bak` só se já existia; o script antigo não foi tocado).
**Atenção:** o `/api/automations/cron` **em produção hoje** é a versão antiga (só aceita `x-cron-secret` = `AUTOMATION_CRON_SECRET`, que **não existe** na Vercel → 503). O código novo (branch `feat/email-channel`, aceita `CRON_SECRET`) precisa ser publicado antes de instalar os crons de `scripts/deploy/vps-cron/`. Além disso, a produção responde a GET de cron por um **cache de CDN curto** (visto `X-Vercel-Cache: HIT` ~1–2 min depois de uma chamada autorizada, expirou sozinho): chamadas repetidas em menos de ~2 min podem não executar; considerar `export const dynamic = 'force-dynamic'` nas rotas de cron.

### Chave Woo "wacrm" — CRIADA (2026-11-19, autorizada pelo Junior)
Criada direto na tabela `wp_woocommerce_api_keys` da loja (via `wp eval`, mesma rotina do WooCommerce: `wc_rand_hash` + `wc_api_hash`), `key_id` 78, descrição `wacrm`, **`read_write`**, mesmo dono das outras chaves (user 26846). Verificada: leitura autenticada em `/wp-json/wc/v3/coupons` retorna 200 (sem chave, 401). **Nenhuma escrita de teste foi feita** (nenhum cupom criado). O segredo está **só** em `D:\CHAVES_CONSOLIDADAS\woo_wacrm.env` (`WACRM_WOO_CONSUMER_KEY` / `WACRM_WOO_CONSUMER_SECRET`); não foi para chat, repositório nem Vercel. **Falta cadastrá-la** em Configurações → WooCommerce do WaCRM (ou na tabela `integration_configs`, criptografada). Para revogar: apagar a linha `key_id = 78` (ou WooCommerce → Avançado → API REST).

### Para ligar (nada disto foi feito)
1. Aplicar **053, 054, 055** num Supabase de teste e depois no de produção; conferir o `NEXT_PUBLIC_SITE_URL`, o canal de e-mail ativo e o Resend (domínio verificado).
2. Alinhar o segredo de cron (achado 1) e instalar os crons do VPS (`scripts/deploy/vps-cron/README.md`).
3. Criar a chave Woo "wacrm" (leitura e escrita) e cadastrá-la na integração (Configurações → WooCommerce); copiar o `webhook_secret` dessa integração.
4. Deploy do WaCRM com este código na Vercel (`wacrm-rfm.vercel.app`).
5. No plugin: apontar o webhook para `https://wacrm-rfm.vercel.app/api/integrations/woocommerce/carts?user_id=<uuid>&token=<webhook_secret>`. Fazer um carrinho de teste com um e-mail do Junior e esperar ~25 min.
6. Criar a automação pelo modelo "Carrinho abandonado (e-mail, 3 lembretes)" (nasce inativa), revisar textos e links e **ativar**; só então pausar o Rishi.
7. Link mágico: só ativar o modelo depois de confirmar que o WordPress não envia o mesmo e-mail.

### Limitações / dívidas
- O e-mail lista as peças em **texto** (sem foto, como o snippet 163 fazia). O layout do WaCRM não tem bloco de itens com imagem; dá para criar (a lista já vem com `image_url` em `abandoned_carts.items`).
- O cupom da etapa 3 é do WaCRM (5 %, 7 dias, restrito ao e-mail, digitado pelo cliente); o do Rishi era aplicado ao abrir o link. Se quiser aplicar automaticamente, falta um parâmetro `?cupom=` no Woo.
- `purchased_since_enrollment` casa pedido por `contact_id`. Com carrinho só com e-mail o contato é criado por e-mail; se a compra vier com outro contato do mesmo e-mail, a sequência pode não parar. Melhorar casando também por `customer_email` (já listado na seção 14).
- Um carrinho **sem** e-mail (só telefone) dispara o gatilho `cart_abandoned` (WhatsApp); sem automação de WhatsApp ativa, não acontece nada.
- O token vai na URL do webhook (limitação do plugin) e aparece em logs da Vercel; trocar o `webhook_secret` se vazar.
- Fora do escopo desta rodada: eventos do **site novo** (5a–5f), formulário de cadastro/consentimento (5e).

---

## 13. Revisão: a integração já funciona com o site novo? (2026-11-19) — NÃO, ainda

Revisado (só leitura) o site Next em `D:\pagina do produto - dly-trabalho` (branch `feat/imagens-blob`, com alterações ainda não commitadas). Resultado: **o site e o WaCRM ainda não conversam**. O site não referencia o WaCRM em lugar nenhum e só faz chamadas de saída para Meta CAPI, GA4 e provedores de pagamento. Isso é esperado (Fase 5 do plano), mas estas são as lacunas concretas, em ordem de impacto:

**Site → WaCRM (dados)**
1. **Não existe canal de entrada para o site.** A única entrada de pedidos é o webhook do Woo (`/api/integrations/woocommerce/webhook?user_id=`). `orders.platform` e `integration_configs.platform` têm `CHECK IN ('woocommerce','shopify','nuvemshop')` (migração 015): pedidos do site **não podem ser gravados** sem migração + um adaptador novo (sugestão: `POST /api/integrations/dly-site/events` assinado por HMAC, escopo próprio).
2. **Vocabulário de status**: o RFM (migração 030) só conta `processing, completed, enviado, separacao` (após tirar `wc-`). O site usa `processing, shipped, completed, refunded`: **`shipped` não seria contado** → recência/RFM erradas. Mapear `shipped → enviado` (e definir `paid`).
3. **Valores**: site em centavos (`total_cents`), WaCRM em reais (`NUMERIC`). Converter na entrada.
4. **Pull não serve bem**: `/api/admin/orders` e `/api/admin/customers` paginam só por `page` (sem `updated_since`) e exigem o **segredo de admin inteiro** (`x-admin-secret`), credencial ampla demais para um CRM. Preferir o site **empurrar** eventos assinados (pedido pago/enviado/reembolsado, checkout abandonado, cadastro) com segredo próprio.
5. **Histórico duplicado na virada**: o site já guarda os pedidos migrados do Woo (`legacy_order_id`, `source`), e o WaCRM já tem os mesmos pedidos via Woo. Namespacear `external_order_id` e ignorar `source <> 'native'` no push, senão dobra receita/frequência no RFM.

**Cupons (WaCRM → site) — o ponto mais crítico para a régua**
6. O cupom do site (`coupons`) tem tipo, valor, mínimo, **limite global** (`max_uses`), datas e ativo. **Não tem restrição por e-mail, limite por cliente nem "só primeira compra"**, e `resolveCartCoupon(lines, code)` (usado em `/api/coupons/validate`, `/api/payment/pix`, `/api/payment/card`, `/api/shipping/quote`) **não recebe quem está comprando**. Hoje só dá para criar um código compartilhável com `max_uses = 1`. Para o cupom de boas-vindas e o da régua é preciso: colunas `customer_email`, `per_customer_limit`, `first_order_only` em `coupons` e passar o e-mail do cliente para `resolveCartCoupon`. `coupon_redemptions.customer_email` já registra o resgate (serve de sinal de conversão para o relatório).
7. Criar cupom exige `POST /api/admin/coupons` com o segredo de admin. Precisa de um endpoint com **token de escopo mínimo** só para criar cupom.
8. O site não aplica cupom por link (`?cupom=`/`?dly_cupom=`), que os e-mails usam para o cliente não digitar o código.

**Consentimento e descadastro**
9. O site **não tem cadastro de newsletter, campo de consentimento de marketing nem descadastro**. O cadastro do rodapé hoje está no Woo (snippet 164). Ao migrar, precisa de formulário no site + `POST /api/public/subscribe` no WaCRM (não construído). A lista de supressão do WaCRM é a autoridade; os e-mails **transacionais** do site (Pix gerado, pagamento aprovado, link de login, parcerias) seguem independentes.
10. Clientes migrados do Woo não têm base de consentimento registrada; definir a política (ex.: só quem comprou nos últimos N meses) antes de qualquer envio em massa a partir do site.

**Carrinho abandonado**
11. O site captura `abandoned_checkouts` (e-mail, telefone, itens, status), mas **ninguém envia e-mail** e **não há link de recuperação** (sem token que reconstrua o carrinho). O gatilho `cart_abandoned` do WaCRM espera o payload multipart do Funnelkit/Woo e **ignora carrinho sem telefone**. Para o site: evento próprio com `{email, phone?, itens, checkout_url}` e rota de restauração por token.

**O que já ajuda**
- O site já usa **Resend** para transacionais (`RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`), o mesmo provedor do canal novo: o domínio pode já estar verificado (conferir em resend.com/domains) e o layout de `src/lib/server/email.ts` é o mesmo design system do `layout.ts` do WaCRM.
- Pedidos do site têm `placed_at`, `paid_at`, `customer_id`, e-mail único por cliente; clientes têm telefone opcional (o WaCRM agora aceita contato sem telefone, migração 053).
- Para o WaCRM o contato é por e-mail+telefone; o `customers.email` único do site casa bem.

**Ordem sugerida (mínimo para funcionar ponta a ponta)** (a mesma lista está como tarefa 5a–5f na seção 5): (a) migração do `platform` + endpoint assinado de eventos no WaCRM; (b) site emite `order.paid/shipped/refunded` e `checkout.abandoned`; (c) site: colunas de cupom (`customer_email`, `per_customer_limit`, `first_order_only`) + e-mail do cliente em `resolveCartCoupon`; (d) endpoint de criação de cupom com token mínimo; (e) `POST /api/public/subscribe` + formulário no site + campo de consentimento; (f) restauração de carrinho por link e `?cupom=`. Fazer (c) e (d) **antes** da Fase 2 se a régua for rodar no site novo; enquanto o Woo estiver no ar, a régua pode rodar pelo conector do Woo.
