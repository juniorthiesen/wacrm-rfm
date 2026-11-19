import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation } from "@/types";

/**
 * End-to-end test of the engine's retry queue against an in-memory fake of the
 * database. External services (e-mail send, store connector, WhatsApp) are mocked.
 * What it proves: a transient failure parks THIS step (right position, parent and
 * branch), keeps the context (the coupon already created is not created again),
 * and the cron resume continues from there; ambiguous / permanent failures do not
 * loop; the retries are bounded.
 */

/* ------------------------------ fake database ----------------------------- */

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = {};
  private seq = 0;
  from(table: string) {
    return new Query(this, table);
  }
  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }
  nextId() {
    return `id-${++this.seq}`;
  }
  rpc() {
    return Promise.resolve({ data: null, error: null });
  }
}

class Query {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row = {};
  private filters: Array<(r: Row) => boolean> = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private head = false;
  private wantCount = false;
  private returning = false;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.head = !!opts?.head;
      this.wantCount = opts?.count === "exact";
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  gt(col: string, v: unknown) {
    this.filters.push((r) => String(r[col]) > String(v));
    return this;
  }
  gte(col: string, v: unknown) {
    this.filters.push((r) => (r[col] as number) >= (v as number));
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  is(col: string, v: unknown) {
    this.filters.push((r) => (v === null ? r[col] == null : r[col] === v));
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.orderBy = { col, asc: o?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }

  private run(): { data: Row[]; count: number } {
    const all = this.db.rows(this.table);
    if (this.op === "insert") {
      const row = { id: this.db.nextId(), ...structuredClone(this.payload) } as Row;
      all.push(row);
      return { data: [row], count: 1 };
    }
    let matched = all.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of matched) Object.assign(r, structuredClone(this.payload));
      return { data: matched, count: matched.length };
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      matched = [...matched].sort((a, b) => ((a[col] as number) - (b[col] as number)) * (asc ? 1 : -1));
    }
    const count = matched.length;
    if (this.max !== null) matched = matched.slice(0, this.max);
    return { data: matched, count };
  }

  single() {
    const { data } = this.run();
    return Promise.resolve(data[0] ? { data: data[0], error: null } : { data: null, error: { message: "not found" } });
  }
  maybeSingle() {
    const { data } = this.run();
    return Promise.resolve({ data: data[0] ?? null, error: null });
  }
  then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
    try {
      const { data, count } = this.run();
      return Promise.resolve({
        data: this.head ? null : data,
        count: this.wantCount ? count : null,
        error: null,
      }).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).then(resolve, reject);
    }
  }
}

/* --------------------------------- mocks ---------------------------------- */

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  sendEmail: vi.fn(),
  createCoupon: vi.fn(),
  loadStoreConnector: vi.fn(),
}));

vi.mock("./admin-client", () => ({ supabaseAdmin: () => h.db }));
vi.mock("./meta-send", () => ({ engineSendText: vi.fn(), engineSendTemplate: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: (...args: unknown[]) => h.sendEmail(...args) }));
vi.mock("@/lib/email/store", () => ({ supabaseEmailStore: () => ({}) }));
vi.mock("@/lib/commerce/connector", () => ({
  loadStoreConnector: (...args: unknown[]) => h.loadStoreConnector(...args),
}));

import { resumePendingExecution, runAutomationForContact } from "./engine";

/* --------------------------------- fixtures -------------------------------- */

const USER = "user-1";
const AUTOMATION: Automation = {
  id: "auto-1",
  user_id: USER,
  name: "Régua de reativação",
  trigger_type: "recency_reached",
  trigger_config: {},
  is_active: true,
  execution_count: 0,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const EMAIL_STEP = {
  subject: "Um presente para você",
  heading: "Um presente",
  body: "Oi, {{customer.first_name|linda}}.",
  coupon_code: "{{vars.coupon_code}}",
  category: "marketing",
};

/** condition(root) -> 'no' branch: [0] create_coupon, [1] send_email */
function seedFlow(db: FakeDb) {
  db.tables.automations = [{ ...AUTOMATION }];
  db.tables.contacts = [{ id: "c1", user_id: USER, name: "Ana Silva", email: "ana@x.com" }];
  db.tables.orders = [];
  db.tables.automation_enrollments = [{ automation_id: AUTOMATION.id, email: "ana@x.com", cohort: "treatment" }];
  db.tables.automation_steps = [
    { id: "cond", automation_id: AUTOMATION.id, parent_step_id: null, branch: null, position: 0, step_type: "condition", step_config: { subject: "purchased_since_enrollment" } },
    { id: "coupon", automation_id: AUTOMATION.id, parent_step_id: "cond", branch: "no", position: 0, step_type: "create_coupon", step_config: { discount_type: "fixed_cart", amount: 20, valid_days: 10, code_prefix: "VOLTA" } },
    { id: "mail", automation_id: AUTOMATION.id, parent_step_id: "cond", branch: "no", position: 1, step_type: "send_email", step_config: EMAIL_STEP },
  ];
}

const ctx = () => ({ customer: { name: "Ana Silva", first_name: "Ana" }, vars: { enrolled_at: "2026-11-01T00:00:00Z" } });
const pending = () => h.db.rows("automation_pending_executions");
const log = () => h.db.rows("automation_logs")[0];
type LoggedStep = { step_type: string; status: string; detail?: string };
const steps = () => log().steps_executed as LoggedStep[];
// The engine appends a branch's results before the condition that opened it, so
// query by step type instead of relying on the position in the list.
const statusesOf = (type: string) => steps().filter((s) => s.step_type === type).map((s) => s.status);
const lastOf = (type: string) => steps().filter((s) => s.step_type === type).at(-1)!;
const asResumeInput = (r: Row) => ({
  id: r.id as string,
  automation_id: r.automation_id as string,
  user_id: r.user_id as string,
  contact_id: (r.contact_id as string | null) ?? null,
  log_id: (r.log_id as string | null) ?? null,
  parent_step_id: (r.parent_step_id as string | null) ?? null,
  branch: (r.branch as "yes" | "no" | null) ?? null,
  next_step_position: r.next_step_position as number,
  context: r.context as never,
});
const sent = { status: "sent", messageId: "m", providerMessageId: "p" };

beforeEach(() => {
  h.db = new FakeDb();
  seedFlow(h.db);
  h.sendEmail.mockReset();
  h.createCoupon.mockReset();
  h.loadStoreConnector.mockReset();
  h.createCoupon.mockResolvedValue({ code: "VOLTA-AAA111", externalId: "1", expiresAt: "2026-11-29T00:00:00Z" });
  h.loadStoreConnector.mockResolvedValue({ platform: "woocommerce", createCoupon: h.createCoupon });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/* ---------------------------------- tests --------------------------------- */

describe("retry queue: e-mail over the daily limit", () => {
  it("parks the e-mail step for tomorrow, keeps the coupon, and resumes only that step", async () => {
    h.sendEmail.mockResolvedValueOnce({ status: "skipped", messageId: "m1", reason: "daily_limit" });
    await runAutomationForContact(AUTOMATION, "c1", ctx());

    // the coupon was created once; the e-mail was not sent
    expect(h.createCoupon).toHaveBeenCalledTimes(1);
    expect(pending()).toHaveLength(1);
    const row = pending()[0];
    expect(row).toMatchObject({ status: "pending", parent_step_id: "cond", branch: "no", next_step_position: 1 });
    expect(new Date(row.run_at as string).getTime()).toBeGreaterThan(Date.now());
    expect((row.context as { vars: Record<string, string> }).vars.coupon_code).toBe("VOLTA-AAA111");
    expect(statusesOf("create_coupon")).toEqual(["success"]);
    expect(statusesOf("send_email")).toEqual(["retrying"]);
    expect(log().status).toBe("partial");
    expect(lastOf("send_email").detail).toContain("nova tentativa 1/6");

    // the cron resumes: the next day the limit has reset
    h.sendEmail.mockImplementationOnce(async (input: { render: (c: { unsubscribeUrl: string | null; brand: object }) => { html: string } }) => {
      // the e-mail is rendered with the coupon created BEFORE the retry
      expect(input.render({ unsubscribeUrl: "https://crm/u", brand: {} }).html).toContain("VOLTA-AAA111");
      return sent;
    });
    await resumePendingExecution(asResumeInput(row));

    expect(h.createCoupon).toHaveBeenCalledTimes(1); // NOT created again
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
    expect(row.status).toBe("done");
    expect(statusesOf("send_email")).toEqual(["retrying", "success"]);
  });

  it("gives up after the maximum number of retries and reports why", async () => {
    h.sendEmail.mockResolvedValue({ status: "skipped", messageId: "m", reason: "daily_limit" });
    await runAutomationForContact(AUTOMATION, "c1", ctx());

    let guard = 0;
    while (pending().some((p) => p.status === "pending") && guard++ < 20) {
      const next = pending().find((p) => p.status === "pending")!;
      await resumePendingExecution(asResumeInput(next));
    }

    expect(h.sendEmail).toHaveBeenCalledTimes(7); // 1 try + 6 retries
    expect(pending().every((p) => p.status === "done")).toBe(true);
    expect(log().status).not.toBe("success");
    expect(statusesOf("send_email")).toEqual(["retrying", "retrying", "retrying", "retrying", "retrying", "retrying", "failed"]);
    expect(lastOf("send_email").detail).toMatch(/esgotou as 6 novas tentativas/);
    expect(h.createCoupon).toHaveBeenCalledTimes(1);
  });
});

describe("retry queue: store (coupon) failures", () => {
  it("retries the coupon step itself and then carries on to the e-mail", async () => {
    h.createCoupon.mockRejectedValueOnce(new Error("WooCommerce coupon creation failed: 503 Service Unavailable"));
    h.sendEmail.mockResolvedValue(sent);
    await runAutomationForContact(AUTOMATION, "c1", ctx());

    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(pending()).toHaveLength(1);
    expect(pending()[0]).toMatchObject({ parent_step_id: "cond", branch: "no", next_step_position: 0 });
    expect(statusesOf("create_coupon")).toEqual(["retrying"]);
    expect(statusesOf("send_email")).toEqual([]);

    await resumePendingExecution(asResumeInput(pending()[0]));
    expect(h.createCoupon).toHaveBeenCalledTimes(2);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(statusesOf("create_coupon")).toEqual(["retrying", "success"]);
    expect(statusesOf("send_email")).toEqual(["success"]);
  });

  it("retries when no store integration is configured yet (an admin may fix it)", async () => {
    h.loadStoreConnector.mockResolvedValueOnce(null);
    await runAutomationForContact(AUTOMATION, "c1", ctx());
    expect(pending()).toHaveLength(1);
    expect(statusesOf("create_coupon")).toEqual(["retrying"]);
  });
});

describe("retry queue: what must NOT be retried", () => {
  it("does not retry an ambiguous send (timeout): the e-mail may already have gone out", async () => {
    h.sendEmail.mockResolvedValue({ status: "failed", messageId: "m", error: "timeout", retryable: true, ambiguous: true });
    await runAutomationForContact(AUTOMATION, "c1", ctx());
    expect(pending()).toHaveLength(0);
    expect(statusesOf("send_email")).toEqual(["failed"]);
    expect(log().error_message).toMatch(/pode ter sido enviado/);
  });

  it("retries an explicit provider rejection that is retryable (429/5xx)", async () => {
    h.sendEmail.mockResolvedValueOnce({ status: "failed", messageId: "m", error: "Too many requests", retryable: true, ambiguous: false });
    await runAutomationForContact(AUTOMATION, "c1", ctx());
    expect(pending()).toHaveLength(1);
    expect(statusesOf("send_email")).toEqual(["retrying"]);
  });

  it("does not retry a permanent failure", async () => {
    h.sendEmail.mockResolvedValue({ status: "failed", messageId: "m", error: "invalid_email", retryable: false, ambiguous: false });
    await runAutomationForContact(AUTOMATION, "c1", ctx());
    expect(pending()).toHaveLength(0);
    expect(statusesOf("send_email")).toEqual(["failed"]);
  });

  it("does not retry a suppressed address (final, by design)", async () => {
    h.sendEmail.mockResolvedValue({ status: "suppressed", messageId: "m", reason: "unsubscribed" });
    await runAutomationForContact(AUTOMATION, "c1", ctx());
    expect(pending()).toHaveLength(0);
    expect(statusesOf("send_email")).toEqual(["success"]); // recorded as a skip, the run ends cleanly
    expect(lastOf("send_email").detail).toContain("suppressed");
  });
});

describe("retry queue: someone who already bought", () => {
  it("ends the sequence without creating a coupon or sending anything", async () => {
    h.db.tables.orders = [{ id: "o1", user_id: USER, contact_id: "c1", status: "wc-enviado", ordered_at: "2026-11-05T00:00:00Z" }];
    await runAutomationForContact(AUTOMATION, "c1", ctx());
    expect(h.createCoupon).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(pending()).toHaveLength(0);
  });
});
