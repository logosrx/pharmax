import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_SCAN_DETAIL_REQUIRED,
  ACTIVITY_SCAN_DETAIL_UNEXPECTED,
  recordActivityEvent,
  type ActivityEventClient,
  type RecordActivityEventInput,
} from "./record-activity-event.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const ORDER = "55555555-5555-4555-8555-555555555555";
const BUCKET = "66666666-6666-4666-8666-666666666666";

function fakeClient(): { client: ActivityEventClient; created: Record<string, unknown>[] } {
  const created: Record<string, unknown>[] = [];
  const client = {
    operatorActivityEvent: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: "77777777-7777-4777-8777-777777777777" };
      }),
    },
  } as unknown as ActivityEventClient;
  return { client, created };
}

function ctxFor(organizationId: string, userId: string) {
  return buildTenancyContext({
    organizationId,
    actor: { userId, correlationId: "01JCORRELATION0000000000000" },
  });
}

describe("recordActivityEvent — tenancy", () => {
  it("stamps organizationId and userId from the frame", async () => {
    const { client, created } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), () =>
      recordActivityEvent({ kind: "ORDER_OPENED", orderId: ORDER }, { client })
    );
    expect(created[0]).toMatchObject({
      organizationId: ORG_A,
      userId: USER_A,
      kind: "ORDER_OPENED",
      orderId: ORDER,
    });
  });

  it("follows the active frame across tenants", async () => {
    const { client, created } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), () =>
      recordActivityEvent({ kind: "QUEUE_CLAIMED", bucketId: BUCKET }, { client })
    );
    await withTenancyContext(ctxFor(ORG_B, USER_A), () =>
      recordActivityEvent({ kind: "QUEUE_CLAIMED", bucketId: BUCKET }, { client })
    );
    expect(created.map((d) => d.organizationId)).toEqual([ORG_A, ORG_B]);
  });

  it("refuses to write with no tenancy frame", async () => {
    const { client, created } = fakeClient();
    await expect(recordActivityEvent({ kind: "SIGNED_OUT" }, { client })).rejects.toThrow();
    expect(created).toHaveLength(0);
  });
});

describe("recordActivityEvent — privacy boundary", () => {
  /**
   * The structural guard. The rule file forbids tracking
   * screenshots, keystrokes, unrelated websites, and personal device
   * activity. There is no column on `operator_activity_event` that
   * could hold any of them, and `.strict()` on the input schema
   * means a caller who tries is REJECTED rather than silently
   * ignored — so the attempt surfaces at the boundary instead of
   * lying dormant until someone adds the column.
   */
  it.each([
    ["a browsed URL", { url: "https://example.test/patients/9" }],
    ["a keystroke buffer", { keystrokes: "atorvastatin 40mg" }],
    ["a screenshot pointer", { screenshotKey: "s3://shots/abc.png" }],
    ["a personal device id", { deviceId: "iPhone-of-jane" }],
    ["a raw scanned value", { scannedValue: "PX:55555555-5555-4555-8555-555555555555" }],
    ["free-text metadata", { metadata: { note: "anything at all" } }],
  ])("rejects %s instead of dropping it", async (_label, forbidden) => {
    const { client, created } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), async () => {
      await expect(
        recordActivityEvent(
          { kind: "ORDER_OPENED", orderId: ORDER, ...forbidden } as RecordActivityEventInput,
          { client }
        )
      ).rejects.toThrow();
    });
    expect(created).toHaveLength(0);
  });

  it("never persists a scanned value — only classification and outcome", async () => {
    const { client, created } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), () =>
      recordActivityEvent(
        { kind: "SCAN", orderId: ORDER, scan: { kind: "VIAL_LABEL", outcome: "MATCHED" } },
        { client }
      )
    );
    const row = created[0]!;
    expect(row).toMatchObject({ scanKind: "VIAL_LABEL", scanOutcome: "MATCHED" });
    // No column anywhere on the row holds barcode-shaped text.
    for (const value of Object.values(row)) {
      expect(typeof value === "string" ? value.startsWith("PX:") : false).toBe(false);
    }
  });

  it("rejects a subject reference that is not a uuid (so it cannot be a URL or path)", async () => {
    const { client, created } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), async () => {
      await expect(
        recordActivityEvent(
          { kind: "ORDER_OPENED", orderId: "/ops/orders/9?tab=phi" } as RecordActivityEventInput,
          { client }
        )
      ).rejects.toThrow();
    });
    expect(created).toHaveLength(0);
  });
});

describe("recordActivityEvent — scan detail coherence", () => {
  it("requires scan detail on a SCAN event", async () => {
    const { client } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), async () => {
      await expect(recordActivityEvent({ kind: "SCAN" }, { client })).rejects.toThrow(
        new RegExp(ACTIVITY_SCAN_DETAIL_REQUIRED.replace(/_/g, "[_ ]") + "|requires a scan", "i")
      );
    });
  });

  it("refuses scan detail on a non-SCAN event", async () => {
    const { client } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), async () => {
      await expect(
        recordActivityEvent(
          { kind: "SIGNED_OUT", scan: { kind: "LOT", outcome: "MATCHED" } },
          { client }
        )
      ).rejects.toThrow(
        new RegExp(ACTIVITY_SCAN_DETAIL_UNEXPECTED.replace(/_/g, "[_ ]") + "|only meaningful", "i")
      );
    });
  });

  it("rejects an unknown activity kind", async () => {
    const { client } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), async () => {
      await expect(
        recordActivityEvent({ kind: "SCREENSHOT_TAKEN" } as unknown as RecordActivityEventInput, {
          client,
        })
      ).rejects.toThrow();
    });
  });

  it("accepts the four recorded kinds", async () => {
    const { client, created } = fakeClient();
    await withTenancyContext(ctxFor(ORG_A, USER_A), async () => {
      await recordActivityEvent({ kind: "SIGNED_OUT" }, { client });
      await recordActivityEvent({ kind: "ORDER_OPENED", orderId: ORDER }, { client });
      await recordActivityEvent({ kind: "QUEUE_CLAIMED", bucketId: BUCKET }, { client });
      await recordActivityEvent(
        { kind: "SCAN", scan: { kind: "GS1", outcome: "MISMATCHED" } },
        { client }
      );
    });
    expect(created.map((d) => d.kind)).toEqual([
      "SIGNED_OUT",
      "ORDER_OPENED",
      "QUEUE_CLAIMED",
      "SCAN",
    ]);
  });
});
