// Discrete operator activity ingest.
//
// Covers the four signals in the rule vocabulary that nothing else
// already records: SIGNED_OUT, ORDER_OPENED, QUEUE_CLAIMED, SCAN.
// LOGIN, COMMAND_STARTED/COMPLETED, PRINT, and scan FAILURES each
// already have a durable writer elsewhere, so none of them is
// representable here — see schema.prisma §11.
//
// Same bus argument as the heartbeat: none of the four mutates
// workflow state. QUEUE_CLAIMED is the one worth being explicit
// about — it RECORDS that a claim happened, it does not perform one.
// Nothing in the workflow engine reads these rows, so a client that
// lied about claiming a queue would corrupt its own productivity
// numbers and nothing else. Where claiming genuinely moves an order,
// that move is a command and is audited as one.

import {
  prisma,
  type OperatorActivityKind,
  type OperatorScanKind,
  type OperatorScanOutcome,
  type PrismaClient,
} from "@pharmax/database";
import { errors } from "@pharmax/platform-core";
import { requireCurrentContext } from "@pharmax/tenancy";
import { z } from "zod";

export const ACTIVITY_SCAN_DETAIL_REQUIRED = "ACTIVITY_SCAN_DETAIL_REQUIRED";
export const ACTIVITY_SCAN_DETAIL_UNEXPECTED = "ACTIVITY_SCAN_DETAIL_UNEXPECTED";

export type ActivityEventClient = Pick<PrismaClient, "operatorActivityEvent">;

/**
 * Input shape. `.strict()` matters more than usual here: it is what
 * makes an unrecognized key — `url`, `keystrokes`, `screenshotKey`,
 * `userAgent`, `deviceId` — a validation ERROR rather than a
 * silently dropped field. Combined with a schema that has no open
 * column to hold such a value, prohibited telemetry fails at the
 * boundary instead of being quietly ignored (and later, quietly
 * accepted when someone adds the column).
 *
 * There is deliberately no `userId` / `organizationId`: both come
 * from the tenancy frame. See `recordHeartbeat` for why.
 */
const inputSchema = z
  .object({
    kind: z.enum(["SIGNED_OUT", "ORDER_OPENED", "QUEUE_CLAIMED", "SCAN"]),
    /** Workflow subject. Typed uuid — cannot hold a URL or a path. */
    orderId: z.uuid().optional(),
    bucketId: z.uuid().optional(),
    /**
     * SCAN only. Classification + outcome, never the scanned value.
     *
     * The raw string is not accepted even as a transient parameter,
     * so no code path in this package ever holds a scanned value.
     * Callers classify with `parseScannedValue` (@pharmax/scan) and
     * pass the result. A Pharmax vial-label barcode happens to be
     * PHI-free by construction (`PX:<orderLineId>`), but a scanner
     * is a general-purpose input device and the operator chooses
     * what goes under it — a patient wristband scans just as well.
     */
    scan: z
      .object({
        kind: z.enum(["GS1", "NDC", "VIAL_LABEL", "LOT", "UNKNOWN"]),
        outcome: z.enum(["MATCHED", "MISMATCHED", "UNPARSEABLE"]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RecordActivityEventInput = z.infer<typeof inputSchema>;

export interface RecordActivityEventOptions {
  readonly client?: ActivityEventClient;
  readonly now?: Date;
}

export interface RecordActivityEventResult {
  readonly activityEventId: string;
}

/**
 * Record one discrete activity signal for the operator in the active
 * tenancy frame.
 */
export async function recordActivityEvent(
  rawInput: RecordActivityEventInput,
  options: RecordActivityEventOptions = {}
): Promise<RecordActivityEventResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new errors.ValidationError({
      code: "ACTIVITY_EVENT_INPUT_INVALID",
      message: "Operator activity event input is not valid.",
      issues: parsed.error.issues.map((issue) => ({
        path: [...issue.path].map(String),
        message: issue.message,
      })),
    });
  }
  const input = parsed.data;

  // Scan detail is required for SCAN and forbidden otherwise, so a
  // row can never claim to describe a scan it has no classification
  // for, nor carry a classification for something that was not one.
  if (input.kind === "SCAN" && input.scan === undefined) {
    throw new errors.ValidationError({
      code: ACTIVITY_SCAN_DETAIL_REQUIRED,
      message: "A SCAN activity event requires a scan classification and outcome.",
      metadata: { kind: input.kind },
    });
  }
  if (input.kind !== "SCAN" && input.scan !== undefined) {
    throw new errors.ValidationError({
      code: ACTIVITY_SCAN_DETAIL_UNEXPECTED,
      message: "Scan classification is only meaningful on a SCAN activity event.",
      metadata: { kind: input.kind },
    });
  }

  const ctx = requireCurrentContext();
  const client = options.client ?? prisma;

  const created = await client.operatorActivityEvent.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.actor.userId,
      workstationId: ctx.workstationId ?? null,
      kind: input.kind as OperatorActivityKind,
      occurredAt: options.now ?? new Date(),
      orderId: input.orderId ?? null,
      bucketId: input.bucketId ?? null,
      scanKind: (input.scan?.kind ?? null) as OperatorScanKind | null,
      scanOutcome: (input.scan?.outcome ?? null) as OperatorScanOutcome | null,
    },
    select: { id: true },
  });

  return Object.freeze({ activityEventId: created.id });
}
