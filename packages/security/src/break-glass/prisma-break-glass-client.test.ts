import { describe, expect, it } from "vitest";

import type { PrismaClient } from "@pharmax/database";

import { PrismaBreakGlassClient } from "./prisma-break-glass-client.js";

interface SessionRow {
  id: string;
  reason: string;
  requestedByUserId: string;
  ticketUrl: string;
  approvedByUserId: string | null;
  openedAt: Date;
  maxDurationMinutes: number;
  closedAt: Date | null;
  resolution: string | null;
  createdAt: Date;
}

interface ActionRow {
  id: string;
  sessionId: string;
  actionLabel: string;
  parameters: unknown;
  success: boolean;
  errorMessage: string | null;
  commandLogId: string | null;
  startedAt: Date;
  completedAt: Date;
  createdAt: Date;
}

function buildFakePrisma(): {
  prisma: PrismaClient;
  sessions: SessionRow[];
  actions: ActionRow[];
  gucStatements: string[];
} {
  const sessions: SessionRow[] = [];
  const actions: ActionRow[] = [];
  const gucStatements: string[] = [];

  const fakeTx = {
    async $executeRaw(template: TemplateStringsArray, ...values: ReadonlyArray<unknown>) {
      gucStatements.push(
        template.raw.map((part, i) => part + (i < values.length ? String(values[i]) : "")).join("")
      );
      return 0;
    },
    async $queryRaw<T>(): Promise<T> {
      return [] as unknown as T;
    },
  };

  const fake = {
    breakGlassSession: {
      async create(args: { data: Omit<SessionRow, "closedAt" | "resolution" | "createdAt"> }) {
        const row: SessionRow = {
          ...args.data,
          closedAt: null,
          resolution: null,
          createdAt: new Date(),
        };
        sessions.push(row);
        return row;
      },
      async update(args: { where: { id: string }; data: { closedAt: Date; resolution: string } }) {
        const row = sessions.find((s) => s.id === args.where.id);
        if (row === undefined) throw new Error(`no session ${args.where.id}`);
        row.closedAt = args.data.closedAt;
        row.resolution = args.data.resolution;
        return row;
      },
    },
    breakGlassAction: {
      async create(args: {
        data: Omit<ActionRow, "createdAt" | "parameters"> & { parameters?: unknown };
      }) {
        const row: ActionRow = {
          ...args.data,
          parameters: args.data.parameters ?? null,
          createdAt: new Date(),
        };
        actions.push(row);
        return row;
      },
    },
    async $transaction<T>(fn: (tx: typeof fakeTx) => Promise<T>): Promise<T> {
      return fn(fakeTx);
    },
  };

  return { prisma: fake as unknown as PrismaClient, sessions, actions, gucStatements };
}

const SESSION_ID = "01900000-0000-7000-8000-000000000001";
const REQUESTER = "11111111-1111-1111-1111-111111111111";

describe("PrismaBreakGlassClient", () => {
  it("persists and maps the session lifecycle", async () => {
    const { prisma, sessions } = buildFakePrisma();
    const client = new PrismaBreakGlassClient({ prisma });

    const openedAt = new Date("2026-07-30T02:00:00.000Z");
    const record = await client.insertSession({
      id: SESSION_ID,
      reason: "repair stuck order under RLS bypass",
      requestedByUserId: REQUESTER,
      ticketUrl: "https://tickets/INC-42",
      approvedByUserId: null,
      maxDurationMinutes: 60,
      openedAt,
    });
    expect(record).toMatchObject({
      id: SESSION_ID,
      closedAt: null,
      resolution: null,
      openedAt,
    });
    expect(sessions).toHaveLength(1);

    const closedAt = new Date("2026-07-30T02:30:00.000Z");
    const closed = await client.closeSession({
      id: SESSION_ID,
      closedAt,
      resolution: "order repaired; see INC-42",
    });
    expect(closed.closedAt).toEqual(closedAt);
    expect(closed.resolution).toBe("order repaired; see INC-42");
  });

  it("records actions and normalizes parameters to their JSON projection", async () => {
    const { prisma, actions } = buildFakePrisma();
    const client = new PrismaBreakGlassClient({ prisma });

    const base = {
      sessionId: SESSION_ID,
      success: true,
      errorMessage: null,
      commandLogId: null,
      startedAt: new Date("2026-07-30T02:01:00.000Z"),
      completedAt: new Date("2026-07-30T02:01:01.000Z"),
    };

    const withParams = await client.recordAction({
      ...base,
      id: "a-1",
      actionLabel: "lookup_order",
      parameters: { orderId: "o-1", note: undefined, when: new Date("2026-07-30T00:00:00.000Z") },
    });
    // JSON projection: undefined keys dropped, Date → ISO string.
    expect(withParams.parameters).toEqual({
      orderId: "o-1",
      when: "2026-07-30T00:00:00.000Z",
    });

    const withoutParams = await client.recordAction({
      ...base,
      id: "a-2",
      actionLabel: "noop",
      parameters: null,
    });
    // NULL parameters are stored as SQL NULL (column omitted on insert).
    expect(withoutParams.parameters).toBeNull();
    expect(actions).toHaveLength(2);
  });

  it("applies the system-context GUCs inside withSystemContextTx", async () => {
    const { prisma, gucStatements } = buildFakePrisma();
    const client = new PrismaBreakGlassClient({ prisma });

    const result = await client.withSystemContextTx(
      { reason: `break-glass:${SESSION_ID}` },
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        return "done";
      }
    );

    expect(result).toBe("done");
    expect(gucStatements).toHaveLength(1);
    const statement = gucStatements[0] ?? "";
    expect(statement).toContain("set_config('pharmax.system_context', on, true)");
    expect(statement).toContain(
      `set_config('pharmax.system_context_reason', break-glass:${SESSION_ID}, true)`
    );
  });
});
