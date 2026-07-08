# Handoff: WaCRM — inbox mirroring, template buttons, pause/resume

**Data:** 2026-06-29
**Status:** Concluído — tudo commitado e em produção

---

## 1. Objetivo

Adicionar três melhorias ao WaCRM (Next.js 16 + Supabase + Meta WhatsApp Cloud API):

1. **Pause/Resume** para campanhas em andamento (`broadcasts`).
2. **Inbox mirroring** de mensagens enviadas por campanha — antes, o drip só atualizava `broadcast_recipients` e nada aparecia no histórico do contato.
3. **Botões de template** visíveis no inbox — a coluna `message_templates.buttons` existia mas nunca era denormalizada para `messages` nem renderizada na bolha.

---

## 2. Contexto essencial

- **Stack:** Next.js 16 App Router + React 19 + Supabase Cloud (`oqwfyceyiixzdjjmntiy`, sa-east-1) + Meta WhatsApp Cloud API. Deploy na Vercel (auto-deploy no push para `main`). Domínio público `crm.auroralabs.com.br`.
- **Cron de broadcast:** `/api/broadcasts/drip` chamado a cada 5 min via script no VPS Woo (`/usr/local/bin/wacrm-drip-cron.sh`). Vercel timeout = 60 s (`maxDuration = 60`). Respostas 504 são normais — o progresso parcial acontece antes do timeout.
- **Claim atômico:** `claim_broadcast_recipients` RPC usa `FOR UPDATE SKIP LOCKED` + janela de obsolescência de 10 min (migration 041). Impede double-send mesmo com execuções concorrentes.
- **Migrações DDL em prod:** via PowerShell + Windows Credential Manager + POST para a Management API do Supabase. Não há Supabase CLI configurada para rodar contra prod diretamente.
- **Dois clientes Supabase:** `src/lib/supabase/client.ts|server.ts` (anon, RLS ativo) e `src/lib/{automations,flows}/admin-client.ts` (service-role, bypass RLS). Drip usa `supabaseAdmin()` do automations admin-client.

---

## 3. O que já foi feito

### Migration 043 — `broadcasts_status_check` + `'paused'`
```sql
alter table broadcasts drop constraint broadcasts_status_check;
alter table broadcasts add constraint broadcasts_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed', 'paused'));
```
Aplicada em prod. Arquivo: `supabase/migrations/043_broadcast_pause.sql`.

### Migration 044 — `messages.template_buttons`
```sql
alter table messages add column if not exists template_buttons jsonb;
```
Aplicada em prod. Arquivo: `supabase/migrations/044_message_template_buttons.sql`.

### Commit `51a04d4` — `feat(broadcasts): add pause/resume button for sending campaigns`
- `src/types/index.ts`: `BroadcastStatus` recebeu `'paused'`.
- `src/lib/broadcast-status.ts`: entrada `paused` com estilo laranja.
- `src/lib/i18n/translations.ts`: strings em `en` e `pt-BR` para pause/resume/confirm.
- `src/app/(dashboard)/broadcasts/[id]/page.tsx`: botões Pause/Resume com handlers via Supabase; delete desabilitado quando `sending|paused`.

### Commit `180e1f7` — `feat(inbox): mirror campaign sends in the conversation + show template buttons`
- `src/lib/whatsapp/template-header.ts`: nova interface `TemplateButton` + `resolveTemplateButtons()`.
- `src/app/api/whatsapp/send/route.ts`: chama `resolveTemplateButtons()` e persiste `template_buttons` na inserção de `messages`.
- `src/lib/automations/meta-send.ts`: idem — `resolveTemplateButtons()` + `template_buttons` no insert.
- `src/app/api/broadcasts/drip/route.ts`:
  - Select do template ampliado para incluir `body_text, buttons`.
  - `renderTemplateBody()` preenche placeholders `{{n}}` com os params enviados.
  - Batch-fetch de conversas antes do loop de destinatários (evita N+1).
  - Após send bem-sucedido: find-or-create conversation → insert em `messages` com `sender_type='bot'`, `content_type='template'`, `template_buttons`, `message_id` → update `last_message_text` da conversation.
- `src/components/inbox/message-bubble.tsx`: renderiza `message.template_buttons` com ícones Link/Phone/MessageSquare por tipo (URL/PHONE_NUMBER/QUICK_REPLY).

---

## 4. Estado atual

- **Tudo verde:** `npm run typecheck` (0 erros), ESLint nos arquivos editados (0 erros), `npm run test` (261/261 passando).
- **Migrações 043 e 044** aplicadas em prod e verificadas via Management API.
- **Vercel deploy** acionado automaticamente pelo push `5e3745a..180e1f7` para `main`.
- **Cron** rodando automaticamente a cada 5 min (confirmado via SSH: timestamps exatos, HTTP 504 esperado, pending decrescendo).
- **Nota:** o mirror de inbox só vale para novos envios (após migration 044). Não há backfill retroativo — decisão intencional.

---

## 5. Próximos passos

Não há backlog aberto desta sessão. Possíveis continuações úteis:

1. **Verificar deploy Vercel** — confirmar que o build de `180e1f7` passou (`vercel ls` ou dashboard).
2. **Smoke test em prod** — enviar template manual via inbox → confirmar botões visíveis. Depois aguardar próxima rodada do cron → confirmar espelho no inbox do contato.
3. **Campanha `7de72d2c`** — estava com ~140 pendentes na última verificação. Verificar se fechou com `status='sent'` (o cron drena automaticamente).
4. **Template header caching** — o drip re-faz upload da imagem de header a cada rodada por campanha ativa. Seria mais eficiente cachear o `media_id` por URL, mas é melhoria futura, não bug.
5. **Cooldown em `order_received`** — discutido (caso Val Bramusse), não implementado. Baixa prioridade.

---

## 6. Perguntas em aberto

- O Vercel deploy de `180e1f7` concluiu com sucesso? (não foi verificado no final da sessão)
- Faz sentido adicionar UI de "histórico de campanhas" dentro da conversa do contato (mostrar de qual broadcast veio a mensagem)? A infra está pronta: `template_name` + `messages.message_id` → `broadcast_recipients.whatsapp_message_id`.
- O botão "Resume" deve validar se ainda há `pending` antes de mudar o status, ou deixar o drip descobrir na próxima rodada? (atualmente: deixa o drip descobrir — simplicidade ganha)

---

## 7. Artefatos relevantes

### Arquivos editados nesta sessão
| Arquivo | O que mudou |
|---|---|
| `supabase/migrations/043_broadcast_pause.sql` | Novo — adiciona `'paused'` ao CHECK |
| `supabase/migrations/044_message_template_buttons.sql` | Novo — coluna `template_buttons jsonb` em `messages` |
| `src/types/index.ts` | `BroadcastStatus` + interface `TemplateButton` + campo em `Message` |
| `src/lib/broadcast-status.ts` | Entrada `paused` |
| `src/lib/i18n/translations.ts` | Strings pause/resume pt-BR e en |
| `src/app/(dashboard)/broadcasts/[id]/page.tsx` | Botões Pause/Resume |
| `src/lib/whatsapp/template-header.ts` | `resolveTemplateButtons()` |
| `src/app/api/whatsapp/send/route.ts` | `template_buttons` no insert |
| `src/lib/automations/meta-send.ts` | `template_buttons` no insert |
| `src/app/api/broadcasts/drip/route.ts` | Inbox mirror completo |
| `src/components/inbox/message-bubble.tsx` | Render de `template_buttons` |

### Comandos úteis
```bash
# Verificar cron no VPS
ssh -o BatchMode=yes -i ~/.ssh/wacrm_woo root@191.101.78.101 'tail -20 /var/log/wacrm-drip.log'
```

```powershell
# Checar status da campanha via Management API
$tok = (Get-StoredCredential -Target "Supabase CLI:access-token" -AsPlainText)
$h = @{ apikey = $tok; Authorization = "Bearer $tok" }
Invoke-RestMethod -Uri "https://oqwfyceyiixzdjjmntiy.supabase.co/rest/v1/broadcasts?id=eq.7de72d2c-221b-4dad-8fb8-a11c6e1b86ef&select=id,status,sent_count" -Headers $h
```

### Infra
- **Supabase project:** `oqwfyceyiixzdjjmntiy`
- **Domínio:** `crm.auroralabs.com.br` (Cloudflare → Vercel)
- **SSH VPS Woo:** `ssh -i ~/.ssh/wacrm_woo root@191.101.78.101`

---

## 8. Instruções pra próxima sessão

- **Idioma:** responder em pt-BR, exceto em nomes de código/variáveis.
- **Tom:** direto, sem recapitular o que já foi feito, sem overhead de confirmação para mudanças pequenas.
- **Migrações DDL em prod:** Management API REST via PowerShell + Windows Credential Manager. Não usar Supabase CLI contra prod.
- **Não fazer:** sem abstrações desnecessárias, sem error handling especulativo, sem refatoração fora do escopo.
- **Testes:** `npm run typecheck` + `npm run test` antes de qualquer commit. ESLint nos arquivos editados é suficiente.
- **Commits:** separar por feature quando arquivos se sobrepõem. Mensagem no formato `type(scope): descrição`.
- **Armadilha:** o drip retorna HTTP 504 em prod mas ainda processa parcialmente — é esperado. Não "consertar" o timeout aumentando `maxDuration` além de 60 (limite do plano Vercel atual).
- **Memória persistente:** ler `C:\Users\junio\.claude\projects\D--wacrm\memory\MEMORY.md` para contexto de sessões anteriores antes de fazer suposições sobre infra ou estratégia.
