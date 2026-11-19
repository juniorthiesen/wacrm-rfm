import { beforeEach, describe, expect, it } from "vitest";
import type { NormalizedCart } from "./carts";
import {
  buildCartContext,
  processCartEvents,
  SEQUENCE_PROTECTION_DAYS,
  type CartDispatch,
  type CartSavePatch,
  type CartStore,
  type StoredCart,
} from "./cart-ingestion";

const USER = "user-1";
const NOW = new Date("2026-11-19T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function makeCart(over: Partial<NormalizedCart> = {}): NormalizedCart {
  return {
    externalId: "41",
    email: "maria@gmail.com",
    phone: "5511998765432",
    firstName: "Maria",
    lastName: "Souza",
    status: "abandoned",
    cartUrl: "https://dly.com.br/?rishi_recover=abc123",
    items: [{ name: "Calcinha Fio", quantity: 2, price: 39.9, product_url: null, image_url: null }],
    total: 79.8,
    currency: "BRL",
    reachedCheckout: true,
    createdAt: null,
    ...over,
  };
}

interface Row extends StoredCart {
  external_id: string;
  email: string | null;
  skip_reason: string | null;
}

function memoryStore() {
  const rows = new Map<string, Row>();
  const contacts: { id: string; email: string | null; phone: string | null }[] = [];
  const store: CartStore = {
    async getCart(_u, id) {
      return rows.get(id) ?? null;
    },
    async hasRecentSequence(_u, email, sinceIso, exclude) {
      return [...rows.values()].some(
        (r) => r.email === email && r.external_id !== exclude && !!r.sequence_started_at && r.sequence_started_at >= sinceIso,
      );
    },
    async findOrCreateContact(_u, cart) {
      const hit = contacts.find((c) => (cart.email && c.email === cart.email) || (cart.phone && c.phone === cart.phone));
      if (hit) return hit.id;
      const created = { id: `c${contacts.length + 1}`, email: cart.email, phone: cart.phone };
      contacts.push(created);
      return created.id;
    },
    async saveCart(_u, cart, patch: CartSavePatch) {
      const prev = rows.get(cart.externalId);
      rows.set(cart.externalId, {
        external_id: cart.externalId,
        email: cart.email,
        status: cart.status,
        contact_id: patch.contactId ?? prev?.contact_id ?? null,
        sequence_started_at: patch.sequenceStartedAt !== undefined ? patch.sequenceStartedAt : (prev?.sequence_started_at ?? null),
        skip_reason: patch.skipReason !== undefined ? patch.skipReason : (prev?.skip_reason ?? null),
      });
    },
  };
  return { store, rows, contacts };
}

describe("processCartEvents", () => {
  let mem: ReturnType<typeof memoryStore>;
  let dispatched: Parameters<CartDispatch>[0][];
  const dispatch: CartDispatch = async (input) => {
    dispatched.push(input);
  };
  const run = (carts: NormalizedCart[], now = NOW) =>
    processCartEvents({ store: mem.store, dispatch, now: () => now }, USER, carts);

  beforeEach(() => {
    mem = memoryStore();
    dispatched = [];
  });

  it("starts the sequence for a new abandoned cart and records it first", async () => {
    const summary = await run([makeCart()]);
    expect(summary).toMatchObject({ started: 1, updated: 0, skipped: 0, failed: 0 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].contactId).toBe("c1");
    expect(mem.rows.get("41")).toMatchObject({ status: "abandoned", sequence_started_at: NOW.toISOString() });
  });

  it("works for an e-mail-only cart", async () => {
    await run([makeCart({ phone: null })]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].context.customer?.phone).toBeUndefined();
    expect(dispatched[0].context.customer?.email).toBe("maria@gmail.com");
  });

  it("is idempotent: the plugin retrying the same batch never restarts the sequence", async () => {
    await run([makeCart()]);
    const again = await run([makeCart()], new Date(NOW.getTime() + 10 * 60 * 1000));
    expect(again).toMatchObject({ started: 0, skipped: 1, reasons: { already_started: 1 } });
    expect(dispatched).toHaveLength(1);
  });

  it("does not start a second sequence for the same e-mail inside the protection window", async () => {
    await run([makeCart({ externalId: "41" })]);
    const summary = await run([makeCart({ externalId: "42" })], new Date(NOW.getTime() + 2 * DAY));
    expect(summary).toMatchObject({ started: 0, skipped: 1, reasons: { recent_sequence: 1 } });
    expect(dispatched).toHaveLength(1);
    expect(mem.rows.get("42")).toMatchObject({ skip_reason: "recent_sequence", sequence_started_at: null });
  });

  it("starts again once the protection window has passed", async () => {
    await run([makeCart({ externalId: "41" })]);
    const later = new Date(NOW.getTime() + (SEQUENCE_PROTECTION_DAYS + 1) * DAY);
    const summary = await run([makeCart({ externalId: "42" })], later);
    expect(summary.started).toBe(1);
    expect(dispatched).toHaveLength(2);
  });

  it("records but never starts a sequence for a stale cart (first sync after the webhook is switched on)", async () => {
    const old = new Date(NOW.getTime() - 3 * DAY).toISOString();
    const summary = await run([makeCart({ externalId: "old", createdAt: old })]);
    expect(summary).toMatchObject({ started: 0, skipped: 1, reasons: { stale: 1 } });
    expect(dispatched).toHaveLength(0);
    expect(mem.rows.get("old")).toMatchObject({ skip_reason: "stale", sequence_started_at: null });
  });

  it("still starts a recent cart and a cart whose age is unknown", async () => {
    const recent = new Date(NOW.getTime() - 40 * 60 * 1000).toISOString();
    const summary = await run([
      makeCart({ externalId: "new", email: "a@a.co", createdAt: recent }),
      makeCart({ externalId: "unknown", email: "b@b.co", createdAt: null }),
    ]);
    expect(summary.started).toBe(2);
  });

  it("only updates the record for recovered / converted / dismissed carts", async () => {
    await run([makeCart()]);
    for (const status of ["recovered", "converted", "dismissed"] as const) {
      const summary = await run([makeCart({ status })]);
      expect(summary).toMatchObject({ updated: 1, started: 0 });
      expect(mem.rows.get("41")?.status).toBe(status);
    }
    expect(dispatched).toHaveLength(1);
  });

  it("counts a failing cart without stopping the batch (the plugin will retry it)", async () => {
    const original = mem.store.findOrCreateContact;
    mem.store.findOrCreateContact = async (u, c) => {
      if (c.externalId === "bad") throw new Error("db down");
      return original(u, c);
    };
    const summary = await run([makeCart({ externalId: "bad", email: "a@a.co" }), makeCart({ externalId: "ok", email: "b@b.co" })]);
    expect(summary).toMatchObject({ started: 1, failed: 1 });
  });
});

describe("buildCartContext", () => {
  it("exposes the recovery link as checkout_url (Funnelkit-compatible) and recovery_url, plus the e-mail variables", () => {
    const ctx = buildCartContext(makeCart(), NOW);
    expect(ctx.cart).toMatchObject({
      checkout_url: "https://dly.com.br/?rishi_recover=abc123",
      recovery_url: "https://dly.com.br/?rishi_recover=abc123",
      checkout_url_suffix: "?rishi_recover=abc123",
      total: "R$ 79,80",
      product_names: "Calcinha Fio",
      items_list: "▪️ Calcinha Fio (Qtd: 2)",
      items_count: 2,
    });
    expect(ctx.customer).toMatchObject({ first_name: "Maria", name: "Maria Souza", email: "maria@gmail.com" });
    expect(ctx.vars).toMatchObject({ enrolled_at: NOW.toISOString(), cart_external_id: "41" });
  });

  it("falls back to the e-mail as the name when the plugin has no name", () => {
    const ctx = buildCartContext(makeCart({ firstName: "", lastName: "" }), NOW);
    expect(ctx.customer?.name).toBe("maria@gmail.com");
  });
});
