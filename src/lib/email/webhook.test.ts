import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./test-utils";
import {
  applyEmailEvent,
  mapResendEvent,
  shouldAdvanceStatus,
  verifySvixSignature,
} from "./webhook";

const SECRET_BYTES = Buffer.from("super-secret-signing-key-0123456");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const NOW_MS = Date.parse("2026-11-19T15:00:00Z");

function sign(id: string, timestamp: string, body: string, bytes: Buffer = SECRET_BYTES): string {
  return `v1,${createHmac("sha256", bytes).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

describe("verifySvixSignature", () => {
  const body = JSON.stringify({ type: "email.delivered" });
  const ts = String(Math.floor(NOW_MS / 1000));

  it("accepts a correct signature", () => {
    expect(verifySvixSignature({ id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) }, body, SECRET, NOW_MS)).toBe(true);
  });

  it("accepts when one of several signatures matches (key rotation)", () => {
    const header = `v1,${Buffer.from("junk").toString("base64")} ${sign("msg_1", ts, body)}`;
    expect(verifySvixSignature({ id: "msg_1", timestamp: ts, signature: header }, body, SECRET, NOW_MS)).toBe(true);
  });

  it("rejects a wrong secret, a tampered body and an altered id", () => {
    const good = { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) };
    expect(verifySvixSignature(good, body, `whsec_${Buffer.from("other").toString("base64")}`, NOW_MS)).toBe(false);
    expect(verifySvixSignature(good, body + " ", SECRET, NOW_MS)).toBe(false);
    expect(verifySvixSignature({ ...good, id: "msg_2" }, body, SECRET, NOW_MS)).toBe(false);
  });

  it("rejects stale or future timestamps (replay protection) and missing headers", () => {
    const old = String(Math.floor(NOW_MS / 1000) - 10 * 60);
    expect(verifySvixSignature({ id: "msg_1", timestamp: old, signature: sign("msg_1", old, body) }, body, SECRET, NOW_MS)).toBe(false);
    expect(verifySvixSignature({ id: null, timestamp: ts, signature: "v1,x" }, body, SECRET, NOW_MS)).toBe(false);
    expect(verifySvixSignature({ id: "msg_1", timestamp: "abc", signature: "v1,x" }, body, SECRET, NOW_MS)).toBe(false);
  });

  it("ignores signature versions other than v1", () => {
    const sig = sign("msg_1", ts, body).replace("v1,", "v2,");
    expect(verifySvixSignature({ id: "msg_1", timestamp: ts, signature: sig }, body, SECRET, NOW_MS)).toBe(false);
  });
});

describe("mapResendEvent", () => {
  const data = { email_id: "prov-1", tags: { email_message_id: "msg-1" } };

  it("maps delivered / opened / clicked / failed", () => {
    expect(mapResendEvent({ type: "email.delivered", created_at: "2026-11-19T15:00:00Z", data })).toMatchObject({
      providerMessageId: "prov-1",
      messageId: "msg-1",
      nextStatus: "delivered",
      patch: { delivered_at: "2026-11-19T15:00:00Z" },
    });
    expect(mapResendEvent({ type: "email.opened", data })).toMatchObject({ addOpens: 1 });
    expect(mapResendEvent({ type: "email.clicked", data })).toMatchObject({ addClicks: 1 });
    expect(mapResendEvent({ type: "email.failed", data: { ...data, reason: "boom" } })).toMatchObject({
      nextStatus: "failed",
      patch: { error: "boom" },
    });
  });

  it("suppresses on a permanent bounce only", () => {
    const permanent = mapResendEvent({ type: "email.bounced", data: { ...data, bounce: { type: "Permanent" } } });
    const transient = mapResendEvent({ type: "email.bounced", data: { ...data, bounce: { type: "Transient" } } });
    expect(permanent?.suppress).toEqual({ reason: "bounced" });
    expect(transient?.suppress).toBeUndefined();
    expect(transient?.nextStatus).toBe("bounced");
  });

  it("always suppresses on a complaint", () => {
    expect(mapResendEvent({ type: "email.complained", data })?.suppress).toEqual({ reason: "complained" });
  });

  it("reads tags given as an array and ignores unknown events", () => {
    const arr = mapResendEvent({
      type: "email.delivered",
      data: { email_id: "p", tags: [{ name: "email_message_id", value: "msg-9" }] },
    });
    expect(arr?.messageId).toBe("msg-9");
    expect(mapResendEvent({ type: "email.sent", data })).toBeNull();
    expect(mapResendEvent({ data })).toBeNull();
  });
});

describe("shouldAdvanceStatus", () => {
  it("only moves forward, and complaint/bounce are final", () => {
    expect(shouldAdvanceStatus("sent", "delivered")).toBe(true);
    expect(shouldAdvanceStatus("delivered", "bounced")).toBe(true);
    expect(shouldAdvanceStatus("bounced", "delivered")).toBe(false);
    expect(shouldAdvanceStatus("complained", "delivered")).toBe(false);
    expect(shouldAdvanceStatus("delivered", "delivered")).toBe(false);
  });
});

describe("applyEmailEvent", () => {
  const seeded = () =>
    createMemoryStore({
      messages: [{ to_email: "maria@gmail.com", status: "sent", provider_message_id: "prov-1" }],
    });

  it("advances sent → delivered and stores the timestamp", async () => {
    const store = seeded();
    const effect = mapResendEvent({ type: "email.delivered", created_at: "2026-11-19T15:00:00Z", data: { email_id: "prov-1" } })!;
    await applyEmailEvent(store, effect);
    expect(store.messages[0]).toMatchObject({ status: "delivered", delivered_at: "2026-11-19T15:00:00Z" });
  });

  it("counts opens and clicks", async () => {
    const store = seeded();
    await applyEmailEvent(store, mapResendEvent({ type: "email.opened", data: { email_id: "prov-1" } })!);
    await applyEmailEvent(store, mapResendEvent({ type: "email.opened", data: { email_id: "prov-1" } })!);
    await applyEmailEvent(store, mapResendEvent({ type: "email.clicked", data: { email_id: "prov-1" } })!);
    expect(store.messages[0]).toMatchObject({ open_count: 2, click_count: 1 });
  });

  it("marks a permanent bounce and adds the address to the suppression list", async () => {
    const store = seeded();
    const effect = mapResendEvent({ type: "email.bounced", data: { email_id: "prov-1", bounce: { type: "Permanent", message: "no such user" } } })!;
    await applyEmailEvent(store, effect);
    expect(store.messages[0]).toMatchObject({ status: "bounced", error: "no such user" });
    expect(store.suppressions.get("maria@gmail.com")).toBe("bounced");
  });

  it("never downgrades a complaint when a late 'delivered' arrives", async () => {
    const store = seeded();
    await applyEmailEvent(store, mapResendEvent({ type: "email.complained", data: { email_id: "prov-1" } })!);
    await applyEmailEvent(store, mapResendEvent({ type: "email.delivered", data: { email_id: "prov-1" } })!);
    expect(store.messages[0].status).toBe("complained");
    expect(store.suppressions.get("maria@gmail.com")).toBe("complained");
  });

  it("keeps the first suppression reason", async () => {
    const store = createMemoryStore({
      suppressions: { "maria@gmail.com": "complained" },
      messages: [{ to_email: "maria@gmail.com", status: "sent", provider_message_id: "prov-1" }],
    });
    await applyEmailEvent(store, mapResendEvent({ type: "email.bounced", data: { email_id: "prov-1", bounce: { type: "Permanent" } } })!);
    expect(store.suppressions.get("maria@gmail.com")).toBe("complained");
  });

  it("falls back to our own message id tag and returns null for unknown messages", async () => {
    const store = seeded();
    const byTag = mapResendEvent({ type: "email.delivered", data: { email_id: "different", tags: { email_message_id: store.messages[0].id } } })!;
    expect(await applyEmailEvent(store, byTag)).not.toBeNull();
    const unknown = mapResendEvent({ type: "email.delivered", data: { email_id: "nope" } })!;
    expect(await applyEmailEvent(store, unknown)).toBeNull();
  });
});
