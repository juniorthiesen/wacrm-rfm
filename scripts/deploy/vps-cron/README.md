# Crons do WaCRM no servidor do site

O WaCRM roda no Vercel (plano Hobby: só 2 crons, 1×/dia). O servidor do site
(VPS do Woo, `191.101.78.101`) já dispara `/api/broadcasts/drip` a cada 5 min por
`/usr/local/bin/wacrm-drip-cron.sh`. Este diretório faz o mesmo para os crons novos:

| Endpoint | Quando | Para quê |
|---|---|---|
| `/api/automations/cron` | a cada 5 min | retoma esperas e **novas tentativas** (carrinho 1 h/24 h/72 h, réguas) |
| `/api/automations/recency-cron` | 1×/dia, 12:00 UTC (09:00 em SP) | inscreve a régua de reativação |

Com o Vercel diário, "esperar 45 min" viraria "até 24 h"; com o cron de 5 min no VPS fica certo.

## Instalar (nada disto foi feito ainda)

```bash
# 1. no servidor do site (como root)
install -m 755 wacrm-cron.sh /usr/local/bin/wacrm-cron.sh
install -m 644 wacrm.cron /etc/cron.d/wacrm

# 2. config com o segredo (o MESMO valor de AUTOMATION_CRON_SECRET / CRON_SECRET da Vercel;
#    é o que o wacrm-drip-cron.sh já usa)
install -m 600 /dev/null /etc/wacrm-cron.env
printf 'WACRM_BASE_URL=https://wacrm-rfm.vercel.app\nWACRM_CRON_SECRET=COLE_O_SEGREDO_AQUI\n' > /etc/wacrm-cron.env

# 3. testar uma vez à mão e olhar o log
/usr/local/bin/wacrm-cron.sh /api/automations/cron 65
tail -3 /var/log/wacrm-cron.log        # esperado: HTTP:200
```

Depois de confirmado, **remova do `vercel.json`** os dois crons correspondentes (já feito neste
repositório) para não rodarem em duplicidade.

## Segurança
- O segredo fica só em `/etc/wacrm-cron.env` (600, root). O script o passa por arquivo de
  cabeçalho temporário, não pela linha de comando (não aparece em `ps`).
- O script só aceita os 4 caminhos de cron conhecidos.
- `flock` impede duas execuções do mesmo endpoint ao mesmo tempo.
