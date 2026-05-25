import type { OrderStageIntervalKind } from "@pharmax/database";
import { vi } from "vitest";

export interface OrderStageIntervalTxStub {
  readonly findFirst: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly updateMany: ReturnType<typeof vi.fn>;
  readonly create: ReturnType<typeof vi.fn>;
}

// Default "old enough" startedAt for stubbed open intervals. The SLA
// interval recorder reads `startedAt` from the open row and rejects
// negative durations on close, so every stub MUST return one.
const DEFAULT_STARTED_AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * Prisma tx stub for `orderStageInterval` queries used by command
 * contract tests. Tracks one open interval at a time.
 */
export function createOrderStageIntervalTxStub(
  recordCall: (table: string, op: string, args: unknown) => void,
  initialOpenKind: OrderStageIntervalKind,
  options: { readonly initialStartedAt?: Date } = {}
): OrderStageIntervalTxStub {
  const startedAt = options.initialStartedAt ?? DEFAULT_STARTED_AT;
  let openInterval: {
    id: string;
    kind: OrderStageIntervalKind;
    startedAt: Date;
  } | null = {
    id: "interval-open",
    kind: initialOpenKind,
    startedAt,
  };

  return {
    findFirst: vi.fn(async (args: unknown) => {
      recordCall("orderStageInterval", "findFirst", args);
      return openInterval;
    }),
    update: vi.fn(async (args: unknown) => {
      recordCall("orderStageInterval", "update", args);
      openInterval = null;
      return { id: "interval-closed" };
    }),
    updateMany: vi.fn(async (args: unknown) => {
      recordCall("orderStageInterval", "updateMany", args);
      openInterval = null;
      return { count: 1 };
    }),
    create: vi.fn(async (args: unknown) => {
      recordCall("orderStageInterval", "create", args);
      const data = (args as { data: { kind: OrderStageIntervalKind; startedAt?: Date } }).data;
      openInterval = {
        id: "interval-open",
        kind: data.kind,
        startedAt: data.startedAt ?? startedAt,
      };
      return { id: "interval-open" };
    }),
  };
}
