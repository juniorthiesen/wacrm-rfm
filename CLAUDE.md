# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next dev server on port 3000. |
| `npm run build` | Production build (runs Next's own typecheck). |
| `npm run typecheck` | `tsc --noEmit` — fast TS-only pass. |
| `npm run lint` | ESLint (flat config in `eslint.config.mjs`). |
| `npm run test` | Vitest, one shot. CI runs this. |
| `npm run test:watch` | Vitest watch mode. |
| `npx vitest run path/to/file.test.ts` | Run a single test file. |
| `npx vitest run -t "name fragment"` | Run a single test by name. |
| `npm run format` / `format:check` | Prettier write / check. |

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build with dummy values for `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ENCRYPTION_KEY`, `META_APP_SECRET`. Tests must stay green with those placeholders — `vitest.config.ts` mirrors them, and module-level `process.env.X!` reads in `lib/whatsapp/*` will crash if you remove either.

## Required env vars

See `.env.local.example`. Hard requirements at runtime:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — client + middleware.
- `SUPABASE_SERVICE_ROLE_KEY` — only used by server routes that need to bypass RLS (webhook, cron, automation/flow engines). Never reference from client code.
- `ENCRYPTION_KEY` — 64 hex chars (AES-256-GCM key for stored WhatsApp tokens). Rotating it orphans every encrypted token.
- `META_APP_SECRET` — HMAC verification for inbound webhook POSTs. The webhook rejects everything if this is missing.
- `AUTOMATION_CRON_SECRET` — optional, only required if you use Wait steps; gates `GET /api/automations/cron`.

## Architecture

Next.js 16 App Router + React 19 + Supabase (Postgres/Auth/Storage/RLS) + Meta Cloud API. shadcn-style components live under `src/components/ui` (config: `components.json`). Lucide for icons. Tailwind v4 with `tw-animate-css`.

### Route groups

- `src/app/(auth)/` — login, signup, forgot-password. Public.
- `src/app/(dashboard)/` — every protected page (inbox, contacts, pipelines, broadcasts, automations, flows, settings, dashboard). Shared `dashboard-shell.tsx` layout.
- `src/app/api/` — REST endpoints + webhook + cron entry points.

`src/middleware.ts` is the auth gate: it runs Supabase SSR session refresh on every request and redirects unauthenticated traffic on protected paths, plus 401s `/api/whatsapp/*` (except `/webhook`). When adding a protected top-level route, update the `protectedPaths` list there.

### Two Supabase clients, two trust levels

- `src/lib/supabase/client.ts` + `server.ts` — anon-key clients used by pages and most route handlers. RLS applies.
- `src/lib/{automations,flows}/admin-client.ts` — service-role clients. These bypass RLS and are used **only** from server-side engines and the webhook. Don't import them from anywhere a request's user identity is relevant.

### WhatsApp inbound path

`POST /api/whatsapp/webhook` (`src/app/api/whatsapp/webhook/route.ts`) is the single entry point for every inbound Meta event. It:

1. Verifies the HMAC-SHA256 signature via `verifyMetaWebhookSignature` — must pass before any DB read.
2. Decrypts the stored phone-number-id → access-token mapping with `lib/whatsapp/encryption.ts`. Tokens use GCM (`iv:ct:tag`); a CBC legacy format (`iv:ct`) is auto-detected on read and re-encrypted on write — see `isLegacyFormat` callers.
3. Persists messages and may call into `runAutomationsForTrigger` (`lib/automations/engine.ts`) and/or `dispatchInboundToFlows` (`lib/flows/engine.ts`).

### Automations vs Flows — they coexist

Two independent engines. They share concepts (triggers, Meta sends) but have different schemas, builders, and runners.

- **Automations** (`lib/automations/`) — flat-ish step list, trigger types like inbound message / new contact / keyword / schedule, conditional branches and Wait steps. Wait steps require the cron pinger at `/api/automations/cron`.
- **Flows** (`lib/flows/`) — node-graph conversation flows that suspend on customer input. Concurrency hardening matters here: idempotency on `meta_message_id`, optimistic UPDATE with `current_node_key` preconditions, and a partial unique index `idx_one_active_run_per_contact`. The header comment in `lib/flows/engine.ts` is the source of truth — read it before modifying the runner.

The webhook calls both per inbound message; flows can suppress automations for the same event via the `DispatchInboundResult` it returns.

### Rate limiting

`src/lib/rate-limit.ts` is a single-process in-memory fixed-window limiter. Fine for a single Node instance (the expected deploy target). If you ever scale horizontally, swap the `check` implementation to Redis/Upstash while keeping the return shape — call sites don't change.

### Security headers / CSP

`next.config.ts` sets HSTS, frame/sniff/referrer/permissions policies, plus a `Content-Security-Policy-Report-Only` CSP. CSP is intentionally in report-only mode pending validation; flip the key to `Content-Security-Policy` once console reports are clean. `connect-src` only allows Supabase — Meta Graph calls happen server-side, never from the browser.

Cache-Control rules in the same file exist because Hostinger's CDN was caching prerendered HTML for a year and serving it after Turbopack chunk hashes changed. Don't widen the s-maxage on `/:path*` without checking how dashboard pages behave behind a shared cache.

## Conventions worth knowing

- Path alias `@/*` → `src/*` (see `tsconfig.json`, `vitest.config.ts`).
- Tests live next to source: `foo.ts` + `foo.test.ts`. Vitest `environment: "node"`; no jsdom — these are unit tests for pure logic and server utilities, not React components.
- Service-role and `process.env.X!` reads at module top-level are intentional in `lib/whatsapp/*` so misconfiguration fails loud at boot rather than at first request. The webhook route uses a `_adminClient` lazy-init pattern to avoid this for build-time only.
- This is a fork-first template; CONTRIBUTING.md explicitly discourages upstream feature PRs. Lean toward small, additive changes that fit the existing module shape rather than introducing new abstractions.
