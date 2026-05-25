// Per-handler tests for the outbox handler registry.
//
// Drainer-level routing is covered in event-outbox-drainer.test.ts.
// These tests pin the handlers' own behavior, including:
//   - Non-throw on a well-formed payload (drainer would otherwise
//     reschedule the row and emit a FAILED metric).
//   - PHI-safe log projection (no email, no patient fields ever).

import { describe, expect, it, vi } from "vitest";

import { logger as loggerNs } from "@pharmax/platform-core";

import { outboxHandlers, createOutboxHandlers } from "./outbox-handlers.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";

function fakeOrgCreatedRow(): ClaimedOutboxEventRow {
  return Object.freeze({
    id: "outbox_org_1",
    organizationId: "11111111-1111-1111-1111-000000000001",
    eventType: "organization.created.v1",
    aggregateType: "Organization",
    aggregateId: "11111111-1111-1111-1111-000000000001",
    payload: {
      organizationId: "11111111-1111-1111-1111-000000000001",
      slug: "acme",
      name: "Acme Pharmacy",
      adminUserId: "22222222-2222-2222-2222-000000000001",
      occurredAt: "2026-05-21T18:30:00.000Z",
    },
    status: "PENDING",
    attempts: 1,
    lastError: null,
    nextAttemptAt: null,
    dispatchedAt: null,
    createdAt: new Date("2026-05-21T18:30:00.000Z"),
  });
}

describe("outboxHandlers.organization.created.v1", () => {
  it("is registered", () => {
    expect(outboxHandlers["organization.created.v1"]).toBeDefined();
  });

  it("does not throw on a well-formed payload", async () => {
    const handler = outboxHandlers["organization.created.v1"];
    expect(handler).toBeDefined();
    if (!handler) return;

    await expect(
      handler(fakeOrgCreatedRow(), {
        logger: loggerNs.noopLogger,
        receivedAt: new Date("2026-05-21T18:30:00.000Z"),
      })
    ).resolves.toBeUndefined();
  });

  it("logs only non-PHI projection fields (no admin email)", async () => {
    const handler = outboxHandlers["organization.created.v1"];
    expect(handler).toBeDefined();
    if (!handler) return;

    const info = vi.fn();
    const fakeLogger: Parameters<typeof handler>[1]["logger"] = {
      info,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Parameters<typeof handler>[1]["logger"];

    // Include an `email` in the payload to prove the handler does
    // not surface it into logs even if upstream accidentally adds it.
    const row: ClaimedOutboxEventRow = {
      ...fakeOrgCreatedRow(),
      payload: {
        ...(fakeOrgCreatedRow().payload as Record<string, unknown>),
        adminEmail: "owner@acme.test",
      },
    };

    await handler(row, { logger: fakeLogger, receivedAt: new Date() });

    expect(info).toHaveBeenCalledTimes(1);
    const [, ctx] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(ctx).toMatchObject({
      organizationId: row.organizationId,
      aggregateId: row.aggregateId,
      slug: "acme",
    });
    // Critical assertion: email-shaped fields never appear.
    expect(JSON.stringify(ctx)).not.toContain("owner@acme.test");
    expect(JSON.stringify(ctx)).not.toContain("adminEmail");
  });
});

describe("outboxHandlers.labels.vial_print.requested.v1", () => {
  it("is registered in createOutboxHandlers", () => {
    const handlers = createOutboxHandlers({
      client: {
        printJob: { findFirst: vi.fn(), update: vi.fn() },
        labelPrinter: { findFirst: vi.fn() },
      },
    });
    expect(handlers["labels.vial_print.requested.v1"]).toBeDefined();
    expect(handlers["labels.vial_print.reprint_requested.v1"]).toBeDefined();
  });
});
