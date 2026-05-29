# Deploy do WaCRM na VPS (CloudPanel + Supabase self-hosted)

Guia passo a passo pra subir o WaCRM com Supabase self-hosted na sua
VPS Hostinger atrás do **CloudPanel** (que já é dono das portas 80/443
via Nginx). O domínio público alvo é `crm.auroralabs.com.br`, com
Cloudflare na frente (proxy ON).

## Arquitetura

```
Cloudflare (proxy laranja)
        │
        ▼  443
CloudPanel / Nginx  ───── crm.auroralabs.com.br  ──► 127.0.0.1:3000  (Next.js)
                    │
                    └──── sb.auroralabs.com.br ──► 127.0.0.1:8000  (Supabase Kong)

Docker network: supabase_default
  ├─ db (Postgres 15 — só do Supabase, não mexe no postgresql-4x4k)
  ├─ auth, rest, realtime, storage, kong   (do compose oficial Supabase)
  ├─ wacrm-app          (Next.js)
  ├─ wacrm-migrate      (one-shot — aplica supabase/migrations/*.sql)
  └─ wacrm-automation-cron  (curl no /api/automations/cron a cada 60s)
```

**Princípios:**

- CloudPanel/Nginx é o único processo escutando em `0.0.0.0:443` —
  Docker bindea tudo em `127.0.0.1` pra **não brigar** pelas portas
  com o site `umenucombr` que já roda na VPS.
- Cloudflare em modo **Full (strict)**. CloudPanel emite Let's Encrypt
  válido — não precisa de Origin Cert da Cloudflare.
- Postgres do Supabase é container próprio, isolado do
  `postgresql-4x4k`. Os dois coexistem sem se ver.

## 1. Pré-requisitos na VPS

Conecta via terminal do CloudPanel (ou SSH no IP `148.230.78.248`):

```bash
# Docker já vem com o "Gerenciador Docker" do CloudPanel.
# Confirma:
docker --version
docker compose version

# Cria a pasta de trabalho.
sudo mkdir -p /opt/wacrm-stack
sudo chown "$USER":"$USER" /opt/wacrm-stack
cd /opt/wacrm-stack
```

## 2. Sobe o Supabase self-hosted

Usa o compose oficial — mantém atualizado pelo `git pull`.

```bash
cd /opt/wacrm-stack
git clone --depth 1 https://github.com/supabase/supabase.git
cd supabase/docker

# Configuração base — sobrescreve campo a campo a seguir.
cp .env.example .env
```

Gera os segredos do Supabase + WaCRM na sua **máquina local** (não na VPS):

```bash
# Na pasta do repo wacrm, na sua máquina local:
bash scripts/deploy/generate-secrets.sh > /tmp/wacrm-secrets.env
# Abre o arquivo, copia os valores para os dois .env corretos.
```

Edita `/opt/wacrm-stack/supabase/docker/.env` na VPS e substitui:

| Variável | Valor |
| --- | --- |
| `POSTGRES_PASSWORD` | gerado |
| `JWT_SECRET` | gerado |
| `ANON_KEY` | gerado |
| `SERVICE_ROLE_KEY` | gerado |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | gerado (caso queira Studio depois) |
| `SECRET_KEY_BASE` | gerado |
| `VAULT_ENC_KEY` | gerado |
| `SITE_URL` | `https://crm.auroralabs.com.br` |
| `API_EXTERNAL_URL` | `https://sb.auroralabs.com.br` |
| `SUPABASE_PUBLIC_URL` | `https://sb.auroralabs.com.br` |
| `ADDITIONAL_REDIRECT_URLS` | `https://crm.auroralabs.com.br/**` |
| `SMTP_*` | um SMTP transacional (Resend, Postmark, Brevo, etc.) |

**Importante:** o compose do Supabase publica portas em `0.0.0.0`
por padrão. **Antes** de subir, força bind local:

```bash
cd /opt/wacrm-stack/supabase/docker

# Kong (gateway que o app vai consumir) → 127.0.0.1:8000
sed -i 's/"8000:8000"/"127.0.0.1:8000:8000"/' docker-compose.yml
sed -i 's/"8443:8443"/"127.0.0.1:8443:8443"/' docker-compose.yml

# Studio: COLISÃO com a porta 3000 que o app usa!
# Movemos pro 3001 (acessível por SSH tunnel se você quiser usar
# depois: ssh -L 3001:127.0.0.1:3001 user@vps).
sed -i 's/"3000:3000"/"127.0.0.1:3001:3000"/' docker-compose.yml

# Postgres do Supabase — só local (porta 54322 pra não brigar com
# o postgresql-4x4k da Hostinger nem com algum Postgres do host).
sed -i 's/"5432:5432"/"127.0.0.1:54322:5432"/' docker-compose.yml
```

> **Por que 3001 pro Studio:** o reverse proxy que você já criou no
> CloudPanel aponta `crm.auroralabs.com.br → 127.0.0.1:3000`. Essa
> porta é do app Next. O Studio sobe na mesma porta dentro do
> container, então a gente expõe ele no host em outra porta. Como
> você não precisa do Studio agora, dá pra desligar de vez:
> `docker compose stop studio` depois de subir tudo.

Sobe:

```bash
docker compose pull
docker compose up -d
docker compose ps   # tudo deve estar Up / healthy
```

## 3. Clona o WaCRM e configura

```bash
cd /opt/wacrm-stack
git clone https://github.com/ArnasDon/wacrm.git wacrm   # ou seu fork
cd wacrm

cp .env.production.example .env.production
nano .env.production    # cola os valores gerados + META_APP_SECRET
```

Sobe o app:

```bash
# A network do Supabase é "supabase_default" por padrão. Confirma:
docker network ls | grep supabase

# Build + up
docker compose build
docker compose up -d
docker compose logs -f migrate    # confere se as 14 migrations passaram
docker compose logs -f app        # confere "ready" do Next
```

A essa altura:

- `curl -I http://127.0.0.1:3000` → `200 OK` (Next está vivo)
- `curl -I http://127.0.0.1:8000` → `404 from Kong` (esperado, é a raiz)

## 4. Cria os vhosts no CloudPanel (UI)

**Site 1 — app (já feito):**
- `crm.auroralabs.com.br` → `http://127.0.0.1:3000` ✅

**Site 2 — Supabase (criar agora):**

1. **Sites → Add Site → Create a Reverse Proxy**
2. **Domain Name:** `sb.auroralabs.com.br`
3. **Reverse Proxy URL:** `http://127.0.0.1:8000`
4. Salva.
5. No DNS do Cloudflare, cria um **A record** `sb` → `148.230.78.248`
   (nuvem cinza — DNS only — pra emitir o cert; depois liga o proxy).
6. No site recém-criado no CloudPanel: **SSL/TLS → Actions → New
   Let's Encrypt Certificate**.
7. Depois que o cert sair, **liga a nuvem laranja** (proxy ON) nos
   dois subdomínios no Cloudflare.

> Se o `crm.auroralabs.com.br` ainda não tem cert Let's Encrypt
> emitido, faz o mesmo: nuvem cinza temporária no Cloudflare, emite
> o cert, religa proxy.

> **Cloudflare:** em **SSL/TLS → Overview**, modo **Full (strict)**.
> Em **Rules → Configuration Rules**, pra `crm.auroralabs.com.br/api/*`
> desliga o cache (Cache Level: Bypass). O `Cache-Control: no-store`
> que o app já manda também serve, mas a regra é defesa em profundidade.

## 5. Smoke test

```bash
# App
curl -sI https://crm.auroralabs.com.br | head -n 1
# Esperado: HTTP/2 200

# Supabase REST (anon)
curl -s https://sb.auroralabs.com.br/rest/v1/ \
  -H "apikey: $ANON_KEY"
# Esperado: {"swagger":"2.0", …}
```

Cria uma conta em `https://crm.auroralabs.com.br/signup` e confirma
que o e-mail sai pelo SMTP configurado. Se não cair na caixa, olha
os logs:

```bash
cd /opt/wacrm-stack/supabase/docker && docker compose logs auth | tail -n 50
```

## 6. Configura o webhook do Meta

No **Meta for Developers → WhatsApp → Configuration → Webhook**:

- **Callback URL:** `https://crm.auroralabs.com.br/api/whatsapp/webhook`
- **Verify Token:** o que está em `WHATSAPP_VERIFY_TOKEN` (se você
  usar; o repo lê esse na rota — confere `route.ts` antes).
- Após Verify pass, inscreve nos campos `messages` e
  `message_template_status_update`.

Manda uma mensagem de teste pro número de WhatsApp Business e
acompanha:

```bash
docker compose logs -f app | grep -i webhook
```

## 7. Backup do Postgres do Supabase

Adiciona um cron no host (não no container) — `crontab -e`:

```cron
# Dump diário às 3h da manhã, retenção de 14 dias.
0 3 * * * docker exec supabase-db pg_dumpall -U postgres | gzip > /opt/wacrm-stack/backups/pg-$(date +\%F).sql.gz && find /opt/wacrm-stack/backups -name 'pg-*.sql.gz' -mtime +14 -delete
```

Cria a pasta:

```bash
mkdir -p /opt/wacrm-stack/backups
```

> **Heads up:** isso é backup local. Sobe um snapshot diário do disco
> pelo painel da Hostinger também (**VPS → Snapshots**), ou empurra
> os dumps pra um bucket S3 com `rclone`.

## 8. Operação do dia a dia

```bash
# Logs do app
cd /opt/wacrm-stack/wacrm && docker compose logs -f app

# Aplicar uma nova migration (depois de adicionar um .sql no repo)
cd /opt/wacrm-stack/wacrm
git pull
docker compose up -d --force-recreate migrate

# Atualizar o app (rebuild)
cd /opt/wacrm-stack/wacrm
git pull
docker compose build app
docker compose up -d app

# Atualizar o Supabase
cd /opt/wacrm-stack/supabase
git pull
cd docker && docker compose pull && docker compose up -d
```

## Troubleshooting

**Porta 3000 já em uso ao subir o app**
Provavelmente o Studio do Supabase não foi movido pra 3001 (passo 2).
Confere com `ss -tlnp | grep 3000`. Se o container `studio` está
ali, pára ele (`docker compose -f /opt/wacrm-stack/supabase/docker/docker-compose.yml
stop studio`) ou refaz o sed mostrado no passo 2.

**Build do app explode com `Cannot find module '@/lib/...'`**
O Dockerfile copia `.` no estágio builder — confere se o
`.dockerignore` não está excluindo `src/`. Refaz `docker compose build
--no-cache app`.

**Migrations falham com `relation "auth.users" does not exist`**
O Supabase ainda não terminou de inicializar quando o `migrate`
rodou. O script `run-migrations.sh` já espera pela `auth.users`, mas
se o timeout estourar (2 min) ele desiste. `docker compose up -d
--force-recreate migrate` quando o Supabase estiver pronto.

**Next responde 200 mas o cliente vê CSP errors com Supabase**
Confere que `NEXT_PUBLIC_SUPABASE_URL` no `.env.production` está
**exatamente** igual ao domínio público (`https://sb.auroralabs.com.br`).
A CSP em `next.config.ts` permite só `*.supabase.co` por default — se
você usar outro domínio, edita o `connect-src` lá.

> **TODO:** flexibilizar o `connect-src` da CSP em `next.config.ts`
> pra incluir o subdomínio Supabase próprio quando self-hosted.
> Hoje a CSP está em report-only, então só vai aparecer no console.

**Webhook do Meta retorna 401**
Sinal típico de `META_APP_SECRET` errado — o HMAC não bate. Confere
no Meta for Developers (App Settings → Basic → App Secret) e
sincroniza com `.env.production` + restart:
`docker compose restart app`.

**Cron de automation não roda**
`docker compose logs automation-cron`. Se aparecer 401, o
`AUTOMATION_CRON_SECRET` está diferente entre o container e o app.
Os dois leem do mesmo `.env.production`, então o problema é quase
sempre o app ter sido buildado antes de você atualizar o env.
`docker compose up -d --force-recreate app automation-cron`.
