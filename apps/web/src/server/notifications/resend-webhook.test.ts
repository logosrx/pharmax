import { describe, expect, it } from "vitest";

import { mapResendEvent } from "./resend-webhook.js";

const EMAIL_ID = "re_abc123";
const TS = "2026-05-28T13:00:00.000Z";

function evt(type: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    created_at: TS,
    data: { email_id: EMAIL_ID, ...extra },
  };
}

describe("mapResendEvent — lifecycle events set status", () => {
  it("maps email.delivered → DELIVERED", () => {
    const r = mapResendEvent(evt("email.delivered"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.update.status).toBe("DELIVERED");
      expect(r.update.providerMessageId).toBe(EMAIL_ID);
      expect(r.update.lastEventType).toBe("email.delivered");
      expect(r.update.lastEventAt.toISOString()).toBe(TS);
    }
  });

  it("maps email.delivery_delayed → DELIVERY_DELAYED", () => {
    const r = mapResendEvent(evt("email.delivery_delayed"));
    expect(r.ok && r.update.status).toBe("DELIVERY_DELAYED");
  });

  it("maps email.bounced → BOUNCED with a failure reason", () => {
    const r = mapResendEvent(
      evt("email.bounced", { bounce: { type: "hard", message: "mailbox does not exist" } })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.update.status).toBe("BOUNCED");
      expect(r.update.failureReason).toBe("hard: mailbox does not exist");
    }
  });

  it("maps email.complained → COMPLAINED", () => {
    const r = mapResendEvent(evt("email.complained"));
    expect(r.ok && r.update.status).toBe("COMPLAINED");
  });
});

describe("mapResendEvent — engagement events do NOT set status", () => {
  it.each(["email.sent", "email.opened", "email.clicked"])(
    "%s carries lastEventType but no status",
    (type) => {
      const r = mapResendEvent(evt(type));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.update.status).toBeUndefined();
        expect(r.update.lastEventType).toBe(type);
      }
    }
  );
});

describe("mapResendEvent — rejects", () => {
  it("rejects an event with no email_id", () => {
    const r = mapResendEvent({ type: "email.delivered", created_at: TS, data: {} });
    expect(r).toEqual({ ok: false, reason: "no_email_id" });
  });

  it("rejects an unknown event type", () => {
    const r = mapResendEvent(evt("email.quantum_entangled"));
    expect(r).toEqual({ ok: false, reason: "unknown_type" });
  });

  it("rejects a missing/blank type", () => {
    const r = mapResendEvent({ created_at: TS, data: { email_id: EMAIL_ID } });
    expect(r).toEqual({ ok: false, reason: "unknown_type" });
  });

  it("rejects a bad timestamp", () => {
    const r = mapResendEvent({
      type: "email.delivered",
      created_at: "not-a-date",
      data: { email_id: EMAIL_ID },
    });
    expect(r).toEqual({ ok: false, reason: "bad_timestamp" });
  });
});
