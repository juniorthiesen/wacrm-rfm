# WACRM Broadcast Drip Cron

Cloudflare Worker that calls the WACRM broadcast drip endpoint every hour.

The Vercel Hobby plan only allows daily crons, so `/api/broadcasts/drip` is
scheduled here instead of in `vercel.json`.

## Configure

Set the same secret used by the production app:

```powershell
npx wrangler secret put CRON_SECRET --cwd workers/broadcast-drip-cron
```

If the production URL changes, edit `APP_URL` in `wrangler.toml`.

## Deploy

```powershell
npx wrangler deploy --cwd workers/broadcast-drip-cron
```

## Manual Test

After deploy, you can trigger one run manually:

```powershell
curl.exe -H "x-cron-secret: <CRON_SECRET>" https://wacrm-broadcast-drip-cron.<account>.workers.dev/
```

The `/health` endpoint is public and only returns Worker liveness. It does not
call WACRM.
