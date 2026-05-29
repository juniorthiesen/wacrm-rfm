#!/bin/sh
# Apply every supabase/migrations/*.sql in order against the Supabase
# Postgres. Mounted into the `migrate` service in docker-compose.yml.
#
# Idempotent: every migration in this repo is written with
# CREATE … IF NOT EXISTS / DROP … IF EXISTS, so re-running is safe.

set -eu

DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"

echo "wacrm-migrate: waiting for ${DB_HOST}:${DB_PORT} ..."
until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" >/dev/null 2>&1; do
  sleep 2
done

# Also wait for the auth schema — Supabase auth (GoTrue) creates
# auth.users on first start. Our migration 001 references it via
# FK, so applying before auth is ready would fail.
echo "wacrm-migrate: waiting for auth.users ..."
i=0
while [ $i -lt 60 ]; do
  if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
       "SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='users'" \
       | grep -q 1; then
    break
  fi
  i=$((i + 1))
  sleep 2
done

echo "wacrm-migrate: applying migrations"
for f in /migrations/*.sql; do
  echo "  -> $f"
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
       -v ON_ERROR_STOP=1 -f "$f"
done

echo "wacrm-migrate: done"
