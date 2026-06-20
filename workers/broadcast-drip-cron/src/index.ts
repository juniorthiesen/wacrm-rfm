interface Env {
  APP_URL: string
  CRON_SECRET: string
}

interface ScheduledController {
  cron: string
  scheduledTime: number
  noRetry(): void
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

const DRIP_PATH = '/api/broadcasts/drip'

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })
}

function dripUrl(appUrl: string): string {
  return new URL(DRIP_PATH, appUrl.endsWith('/') ? appUrl : `${appUrl}/`).toString()
}

async function runDrip(env: Env): Promise<Response> {
  if (!env.APP_URL || !env.CRON_SECRET) {
    return json({ error: 'worker not configured' }, 500)
  }

  const startedAt = Date.now()
  const upstream = await fetch(dripUrl(env.APP_URL), {
    method: 'GET',
    headers: {
      'x-cron-secret': env.CRON_SECRET,
      'user-agent': 'wacrm-cloudflare-cron/1.0',
    },
  })

  let upstreamBody: unknown = null
  const text = await upstream.text()
  if (text) {
    try {
      upstreamBody = JSON.parse(text)
    } catch {
      upstreamBody = text
    }
  }

  return json(
    {
      ok: upstream.ok,
      status: upstream.status,
      duration_ms: Date.now() - startedAt,
      upstream: upstreamBody,
    },
    upstream.ok ? 200 : 502,
  )
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runDrip(env).then(async (response) => {
        if (!response.ok) {
          console.error('broadcast drip cron failed', await response.text())
        }
      }),
    )
  },

  async fetch(request: Request, env: Env) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      return json({ ok: true })
    }

    const authed =
      request.headers.get('authorization') === `Bearer ${env.CRON_SECRET}` ||
      request.headers.get('x-cron-secret') === env.CRON_SECRET

    if (!authed) {
      return json({ error: 'Unauthorized' }, 401)
    }

    return runDrip(env)
  },
}
