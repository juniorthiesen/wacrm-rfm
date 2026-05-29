#!/usr/bin/env bash
# Mint every secret the wacrm + Supabase stack needs.
# Run once per environment; store the output somewhere safe
# (1Password / Bitwarden) and paste into .env.production and
# supabase/docker/.env.
#
# Usage:
#   bash scripts/deploy/generate-secrets.sh

set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }
}
need openssl
need node

JWT_SECRET="$(openssl rand -hex 32)"
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
DASHBOARD_PASSWORD="$(openssl rand -hex 16)"
ENCRYPTION_KEY="$(openssl rand -hex 32)"
AUTOMATION_CRON_SECRET="$(openssl rand -hex 32)"
SECRET_KEY_BASE="$(openssl rand -hex 32)"
VAULT_ENC_KEY="$(openssl rand -hex 32)"

# Mint the Supabase anon + service_role JWTs from JWT_SECRET. These
# are HS256 JWTs Supabase signs with the same secret GoTrue uses.
mint_jwt() {
  local role="$1"
  node -e "
    const crypto = require('crypto');
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      role: '$role',
      iss: 'supabase',
      iat: now,
      // 10-year expiry — rotate together with JWT_SECRET if needed.
      exp: now + (60 * 60 * 24 * 365 * 10),
    };
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = b64(header) + '.' + b64(payload);
    const sig = crypto.createHmac('sha256', '$JWT_SECRET').update(data).digest('base64url');
    process.stdout.write(data + '.' + sig);
  "
}

ANON_KEY="$(mint_jwt anon)"
SERVICE_ROLE_KEY="$(mint_jwt service_role)"

cat <<EOF
# ====================================================================
# Generated secrets — paste into:
#   - .env.production              (wacrm app)
#   - supabase/docker/.env         (Supabase stack)
# ====================================================================

# ---- both files ----
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# ---- supabase/docker/.env only ----
JWT_SECRET=${JWT_SECRET}
ANON_KEY=${ANON_KEY}
SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}
SECRET_KEY_BASE=${SECRET_KEY_BASE}
VAULT_ENC_KEY=${VAULT_ENC_KEY}

# ---- .env.production (wacrm) only ----
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
AUTOMATION_CRON_SECRET=${AUTOMATION_CRON_SECRET}

# ---- still to set manually ----
# META_APP_SECRET           — from Meta for Developers
# NEXT_PUBLIC_SUPABASE_URL  — your https://api.<domain>
# NEXT_PUBLIC_SITE_URL      — your https://crm.<domain>
EOF
