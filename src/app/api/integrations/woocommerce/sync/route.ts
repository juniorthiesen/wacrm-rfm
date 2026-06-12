import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  syncOrdersPage,
  syncCustomersPage,
  emptySyncState,
  freshlyStartedSyncState,
  type SyncState,
} from "@/lib/commerce/sync/woocommerce";
import { recalculateUserRFM } from "@/lib/rfm/engine";
import type { WooClientConfig } from "@/lib/commerce/woocommerce-client";

// One-shot manual sync for a WooCommerce store. Designed to fit under
// Vercel's 60s function budget by running a single page per request and
// letting the client poll `POST` repeatedly until `done: true`.
//
//   GET  → returns the current sync_state (for polling).
//   POST → runs the next page of work, persists progress, returns
//          { done, state }. The client keeps POSTing until done=true.
//   DELETE → resets sync_state to idle (cancel).
//
// Why not a single long-running endpoint:
//   Big stores (10k+ orders) blow past Vercel's timeout on a single
//   request. Per-page invocation also gives the UI a natural progress
//   signal and survives transient WC API failures (operator just clicks
//   "resume").

// Service-role client used for the actual ingestion writes — they need
// to hit the contacts/orders/tags tables on behalf of the user, and we
// don't want RLS coupling to a request cookie. The user's identity is
// verified up front with the SSR client.
function adminClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function requireUser() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

interface IntegrationConfigRow {
  user_id: string;
  store_url: string;
  credentials: { consumer_key?: string; consumer_secret?: string } | null;
  status: string;
  sync_state: SyncState | Record<string, never>;
}

async function loadConfig(
  userId: string,
): Promise<{ config: IntegrationConfigRow | null; error: string | null }> {
  const admin = adminClient();
  const { data, error } = await admin
    .from("integration_configs")
    .select("user_id, store_url, credentials, status, sync_state")
    .eq("user_id", userId)
    .eq("platform", "woocommerce")
    .maybeSingle();
  // Surface the real PostgREST error instead of swallowing it — a
  // missing `sync_state` column (migration 017 not applied) used to
  // look identical to "no integration row", reported as the misleading
  // "Not connected" even though the store was connected and tested OK.
  if (error) return { config: null, error: error.message };
  return { config: (data ?? null) as IntegrationConfigRow | null, error: null };
}

function hydrateState(raw: SyncState | Record<string, never>): SyncState {
  if (raw && typeof raw === "object" && "status" in raw) return raw as SyncState;
  return emptySyncState();
}

async function persistState(userId: string, state: SyncState) {
  await adminClient()
    .from("integration_configs")
    .update({ sync_state: state })
    .eq("user_id", userId)
    .eq("platform", "woocommerce");
}

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { config, error } = await loadConfig(user.id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!config) return NextResponse.json({ error: "Not connected" }, { status: 404 });

  return NextResponse.json({ state: hydrateState(config.sync_state) });
}

export async function POST() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { config, error: loadError } = await loadConfig(user.id);
  if (loadError) return NextResponse.json({ error: loadError }, { status: 500 });
  if (!config) {
    return NextResponse.json({ error: "Not connected" }, { status: 404 });
  }
  if (
    !config.credentials?.consumer_key ||
    !config.credentials?.consumer_secret
  ) {
    return NextResponse.json(
      { error: "Missing consumer_key/consumer_secret" },
      { status: 400 },
    );
  }

  const cfg: WooClientConfig = {
    storeUrl: config.store_url,
    consumerKey: config.credentials.consumer_key,
    consumerSecret: config.credentials.consumer_secret,
  };

  // Resume or start fresh. "completed" + new POST = restart.
  let state = hydrateState(config.sync_state);
  if (state.status !== "running") {
    state = freshlyStartedSyncState();
    await persistState(user.id, state);
  }

  const admin = adminClient();

  try {
    if (state.phase === "orders") {
      const page = state.orders.current_page + 1;
      const result = await syncOrdersPage(admin, user.id, cfg, page);
      state.orders.current_page = page;
      state.orders.total_pages = result.totalPages;
      state.orders.synced_count += result.syncedThisPage;

      // Phase complete when WC says we're past the last page OR we got
      // an empty page (defensive — WC sometimes reports total_pages=0
      // for stores with zero orders).
      if (page >= result.totalPages || result.syncedThisPage === 0) {
        state.phase = "customers";
      }
    } else if (state.phase === "customers") {
      const page = state.customers.current_page + 1;
      const result = await syncCustomersPage(admin, user.id, cfg, page);
      state.customers.current_page = page;
      state.customers.total_pages = result.totalPages;
      state.customers.synced_count += result.syncedThisPage;

      if (page >= result.totalPages || result.syncedThisPage === 0) {
        state.status = "completed";
        state.completed_at = new Date().toISOString();

        // Run RFM once at the end. Re-running it per-page would be
        // wasteful — recalculateUserRFM scans all orders.
        try {
          await recalculateUserRFM(admin, user.id);
        } catch (err) {
          console.error("[sync-wc] RFM recalculation after sync failed:", err);
        }
      }
    }
  } catch (err) {
    state.status = "error";
    state.error = err instanceof Error ? err.message : String(err);
    await persistState(user.id, state);
    return NextResponse.json({ done: true, state }, { status: 500 });
  }

  await persistState(user.id, state);

  const done = state.status === "completed";
  return NextResponse.json({ done, state });
}

export async function DELETE() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const state = emptySyncState();
  await persistState(user.id, state);
  return NextResponse.json({ state });
}
