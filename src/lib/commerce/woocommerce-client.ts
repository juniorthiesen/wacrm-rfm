// Thin REST client for the WooCommerce REST API v3. Used by the
// one-time/manual sync path; the webhook never hits this — Meta-style
// inbound deliveries are the source of truth for deltas.
//
// Auth: Basic with Consumer Key + Consumer Secret. WC also accepts
// query-string auth but Basic is the documented preferred mode and works
// behind every reasonable reverse proxy.
//
// We deliberately *don't* import the official `@woocommerce/woocommerce-rest-api`
// npm package: it pulls a heavy axios chain, has type gaps, and we only
// need GET with pagination.

export interface WooClientConfig {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface WooPagedResult<T> {
  items: T[];
  totalPages: number;
  totalItems: number;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function buildAuthHeader(cfg: WooClientConfig): string {
  const credentials = `${cfg.consumerKey}:${cfg.consumerSecret}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

interface FetchPageOptions {
  page: number;
  perPage?: number;
  status?: string;       // for orders: "any" | "completed" | ...
  orderBy?: string;      // "date" by default
  order?: "asc" | "desc";
  // Free-form extras (e.g. customers don't accept `status`).
  extraParams?: Record<string, string>;
}

/**
 * Generic paged GET. Reads `X-WP-TotalPages` / `X-WP-Total` headers so
 * the caller knows when to stop. Throws on non-2xx so the sync engine
 * can stash the error in `sync_state`.
 */
async function fetchPage<T>(
  cfg: WooClientConfig,
  resource: "orders" | "customers",
  opts: FetchPageOptions,
): Promise<WooPagedResult<T>> {
  const url = new URL(`${stripTrailingSlash(cfg.storeUrl)}/wp-json/wc/v3/${resource}`);
  url.searchParams.set("page", String(opts.page));
  url.searchParams.set("per_page", String(opts.perPage ?? 50));
  url.searchParams.set("orderby", opts.orderBy ?? "date");
  url.searchParams.set("order", opts.order ?? "desc");
  if (opts.status) url.searchParams.set("status", opts.status);
  if (opts.extraParams) {
    for (const [k, v] of Object.entries(opts.extraParams)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: buildAuthHeader(cfg),
      Accept: "application/json",
    },
    // Vercel runtime: skip the Next.js fetch cache for live data.
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `WC ${resource} page ${opts.page} failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
    );
  }

  const totalPages = parseInt(res.headers.get("x-wp-totalpages") ?? "1", 10) || 1;
  const totalItems = parseInt(res.headers.get("x-wp-total") ?? "0", 10) || 0;
  const items = (await res.json()) as T[];

  return { items, totalPages, totalItems };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WooOrder {
  id: number;
  number?: string;
  status?: string;
  total?: string;
  currency?: string;
  date_created_gmt?: string;
  billing?: any;
  shipping?: any;
  line_items?: any[];
  meta_data?: any[];
  shipment_tracking?: any[];
}

export interface WooCustomer {
  id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  billing?: any;
  shipping?: any;
  date_created_gmt?: string;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export function fetchOrdersPage(
  cfg: WooClientConfig,
  page: number,
  perPage = 50,
): Promise<WooPagedResult<WooOrder>> {
  return fetchPage<WooOrder>(cfg, "orders", {
    page,
    perPage,
    // "any" matches the WC enum — without it the endpoint defaults to
    // `pending,processing,on-hold` and we'd miss completed/cancelled.
    status: "any",
    orderBy: "date",
    order: "desc",
  });
}

export function fetchCustomersPage(
  cfg: WooClientConfig,
  page: number,
  perPage = 50,
): Promise<WooPagedResult<WooCustomer>> {
  return fetchPage<WooCustomer>(cfg, "customers", {
    page,
    perPage,
    orderBy: "registered_date",
    order: "desc",
  });
}

/**
 * Liveness check — used by the test endpoint and before kicking off a
 * sync to catch bad credentials early. Throws on failure.
 */
export async function pingStore(cfg: WooClientConfig): Promise<void> {
  await fetchPage(cfg, "orders", { page: 1, perPage: 1, status: "any" });
}
