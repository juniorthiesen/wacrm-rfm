# Pasta deploy/

Esta pasta é **gitignored** e segura nos seus segredos de produção.
Não comite nem suba pro repo público.

## Arquivos

| Arquivo | Onde vai na VPS |
| --- | --- |
| `wacrm.env.production` | `/opt/wacrm-stack/wacrm/.env.production` |
| `supabase.env`         | `/opt/wacrm-stack/supabase/docker/.env` (sobrescreve o `.env.example`) |

## O que falta preencher

Tem `<<<` em algumas linhas — substitua antes de subir:

**`wacrm.env.production`:**
- `META_APP_SECRET` — Meta for Developers → App Settings → Basic

**`supabase.env`:**
- Bloco `SMTP_*` — provedor transacional (Resend, Postmark, Brevo, etc.)

## Como subir em massa

Do seu Windows (PowerShell):

```powershell
# wacrm
scp deploy/wacrm.env.production root@148.230.78.248:/opt/wacrm-stack/wacrm/.env.production

# supabase — copia primeiro o .env.example, depois sobrescreve
ssh root@148.230.78.248 "cd /opt/wacrm-stack/supabase/docker && cp .env.example .env"
scp deploy/supabase.env root@148.230.78.248:/opt/wacrm-stack/supabase/docker/.env
```

Ou via SFTP no FileZilla / WinSCP, apontando pros mesmos caminhos.

## Heads up

Esses arquivos têm:
- Senha do Postgres do Supabase
- JWT_SECRET (assina anon + service_role)
- ENCRYPTION_KEY (decripta tokens do WhatsApp no banco)

**Trate como senha master.** Guarda numa cópia no 1Password/Bitwarden.
Se vazar, refaz o ciclo: `bash scripts/deploy/generate-secrets.sh` →
substitui em ambos `.env` → `docker compose down && up -d` →
todos os usuários precisam reconfigurar tokens do WhatsApp.
