#!/bin/bash
# Chama um endpoint de cron do WaCRM a partir do servidor do site (VPS do Woo).
# Substitui os crons do Vercel (o plano Hobby só permite 2). Mesmo padrão do
# /usr/local/bin/wacrm-drip-cron.sh que já roda neste servidor.
#
# Uso:  wacrm-cron.sh <caminho> [segundos-de-timeout]
#   ex.: wacrm-cron.sh /api/automations/cron 65
#
# Lê /etc/wacrm-cron.env (chmod 600, dono root) com:
#   WACRM_BASE_URL=https://wacrm-rfm.vercel.app
#   WACRM_CRON_SECRET=<o mesmo valor de AUTOMATION_CRON_SECRET / CRON_SECRET da Vercel>
# Nunca coloque o segredo neste script nem no repositório.

set -u

CONF=/etc/wacrm-cron.env
if [ ! -r "$CONF" ]; then
  echo "$(date -Iseconds) ERRO: $CONF ausente ou ilegível" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$CONF"

PATH_ARG="${1:-}"
TIMEOUT="${2:-65}"
case "$PATH_ARG" in
  /api/automations/cron|/api/automations/recency-cron|/api/automations/birthday-cron|/api/rfm/cron) ;;
  *) echo "$(date -Iseconds) ERRO: caminho não permitido: $PATH_ARG" >&2; exit 2 ;;
esac
if [ -z "${WACRM_BASE_URL:-}" ] || [ -z "${WACRM_CRON_SECRET:-}" ]; then
  echo "$(date -Iseconds) ERRO: WACRM_BASE_URL/WACRM_CRON_SECRET não definidos em $CONF" >&2
  exit 1
fi

NAME="$(echo "$PATH_ARG" | tr '/' '_')"
LOG="/var/log/wacrm-cron.log"
LOCK="/var/lock/wacrm-cron${NAME}.lock"

# Uma execução por endpoint por vez (o cron de espera esvazia a fila por até ~48 s).
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Iseconds) $PATH_ARG pulado: execução anterior ainda rodando" >> "$LOG"
  exit 0
fi

{
  printf "%s %s " "$(date -Iseconds)" "$PATH_ARG"
  # O segredo vai por arquivo de cabeçalho temporário para não aparecer em `ps`.
  HDR="$(mktemp)"
  trap 'rm -f "$HDR"' EXIT
  printf 'x-cron-secret: %s\n' "$WACRM_CRON_SECRET" > "$HDR"
  curl -s -m "$TIMEOUT" -o /dev/null -w "HTTP:%{http_code} tempo:%{time_total}s\n" \
    -H @"$HDR" "${WACRM_BASE_URL%/}${PATH_ARG}"
} >> "$LOG" 2>&1
