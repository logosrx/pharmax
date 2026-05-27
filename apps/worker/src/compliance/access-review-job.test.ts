// Unit test for the quarterly access-review loop.
//
// Drives the real `createQuarterlyAccessReviewLoop` against an
// in-memory access-review client + in-memory activity client +
// recording evidence publisher and recording notifier. No Prisma,
// no S3.

import { logger as loggerNs } from "@pharmax/platform-core";
import type { AccessReviewClient } from "@pharmax/security";
import type { PrismaClient } from "@pharmax/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessActivityClient } from "./access-activity-aggregator.js";
import {
  createQuarterlyAccessReviewLoop,
  RecordingComplianceNotifier,
  RecordingEvidencePublisher,
} from "./access-review-job.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORG_SLUG = "pentest-org-a";
const ACTOR = "00000000-0000-4000-8000-0000000000aa";

const logger = loggerNs.createPinoLogger({ service: "test-access-review", level: "error" });

const accessReviewClient: AccessReviewClient = {
  async loadOrganization() {
    return { id: ORG_ID, slug: ORG_SLUG };
  },
  async loadUsersWithRoles() {
    return [
      {
        id: ACTOR,
        email: "alice@pentest.test",
        displayName: "Alice T.",
        status: "ACTIVE",
        clerkUserId: "user_clerk_alice",
        lastLoginAt: new Date("2026-03-30T12:00:00Z"),
        userRoles: [
          {
            id: "00000000-0000-4000-8000-000000000aaa",
            createdAt: new Date("2025-09-01T00:00:00Z"),
            organizationId: ORG_ID,
            siteId: null,
            clinicId: null,
            teamId: null,
            role: {
              id: "role-1",
              code: "Pharmacist",
              name: "Pharmacist",
              scope: "ORGANIZATION",
              rolePermissions: [
                { permission: { code: "pv1.approve" } },
                { permission: { code: "verification.final_approve" } },
              ],
            },
          },
        ],
      },
    ];
  },
};

const activityClient: AccessActivityClient = {
  async groupCommandLogByActor() {
    return [
      {
        commandName: "ApproveInvoice",
        actorUserId: ACTOR,
        count: 60,
        successes: 60,
        failures: 0,
      },
      {
        commandName: "ApprovePV1",
        actorUserId: ACTOR,
        count: 12,
        successes: 12,
        failures: 0,
      },
    ];
  },
  async groupAuditLogByActor() {
    return [{ action: "patient.view", actorUserId: ACTOR, count: 15 }];
  },
};

// Minimal Prisma fake: only `organization.findMany` is reached.
function buildPrismaFake(orgs: ReadonlyArray<{ id: string; slug: string }>): PrismaClient {
  return {
    organization: {
      findMany: vi.fn(async () => orgs),
    },
  } as unknown as PrismaClient;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-01T03:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createQuarterlyAccessReviewLoop", () => {
  it("runs end-to-end on first day of a quarter, writes evidence + notifies", async () => {
    const publisher = new RecordingEvidencePublisher();
    const notifier = new RecordingComplianceNotifier();
    const loop = createQuarterlyAccessReviewLoop({
      prisma: buildPrismaFake([{ id: ORG_ID, slug: ORG_SLUG }]),
      logger,
      accessReviewClient,
      activityClient,
      evidencePublisher: publisher,
      notifier,
    });

    const summary = await loop.runOnce(new Date("2026-04-01T03:00:00Z"));

    expect(summary.quarter.label).toBe("2026-Q1");
    expect(summary.organizationsProcessed).toBe(1);
    expect(summary.organizationsFailed).toBe(0);
    expect(summary.artifacts).toHaveLength(1);

    expect(publisher.artifacts).toHaveLength(2);
    const jsonl = publisher.artifacts.find((a) => a.objectKey.endsWith("access-review.jsonl"));
    expect(jsonl).toBeDefined();
    expect(jsonl?.contentType).toBe("application/x-ndjson");
    expect(jsonl?.body).toContain('"recordType":"header"');
    expect(jsonl?.body).toContain('"recordType":"principal"');
    expect(jsonl?.body).toContain('"recordType":"command-activity"');
    expect(jsonl?.body).toContain('"recordType":"anomaly"');

    const markdown = publisher.artifacts.find((a) => a.objectKey.endsWith(".md"));
    expect(markdown).toBeDefined();
    expect(markdown?.contentType).toBe("text/markdown");
    expect(markdown?.body).toContain("# Quarterly Access Review");
    expect(markdown?.body).toContain("2026-Q1");

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.kind).toBe("access-review.ready");
    // 60 ApproveInvoice ≥ threshold (50): anomaly surfaced; severity = warning.
    expect(notifier.notices[0]?.severity).toBe("warning");
    expect(notifier.notices[0]?.subject).toContain(ORG_SLUG);
  });

  it("produces byte-identical evidence body on repeated runs (modulo generatedAt)", async () => {
    const publisher1 = new RecordingEvidencePublisher();
    const publisher2 = new RecordingEvidencePublisher();
    const fixedNow = new Date("2026-04-01T03:00:00Z");

    const loop1 = createQuarterlyAccessReviewLoop({
      prisma: buildPrismaFake([{ id: ORG_ID, slug: ORG_SLUG }]),
      logger,
      accessReviewClient,
      activityClient,
      evidencePublisher: publisher1,
      notifier: new RecordingComplianceNotifier(),
      now: () => fixedNow,
    });
    const loop2 = createQuarterlyAccessReviewLoop({
      prisma: buildPrismaFake([{ id: ORG_ID, slug: ORG_SLUG }]),
      logger,
      accessReviewClient,
      activityClient,
      evidencePublisher: publisher2,
      notifier: new RecordingComplianceNotifier(),
      now: () => fixedNow,
    });

    await loop1.runOnce(fixedNow);
    await loop2.runOnce(fixedNow);

    const jsonl1 = publisher1.artifacts.find((a) => a.objectKey.endsWith(".jsonl"))?.sha256;
    const jsonl2 = publisher2.artifacts.find((a) => a.objectKey.endsWith(".jsonl"))?.sha256;
    expect(jsonl1).toBeDefined();
    expect(jsonl1).toBe(jsonl2);
  });

  it("handles multiple orgs and continues after a single-org failure", async () => {
    const publisher = new RecordingEvidencePublisher();
    const notifier = new RecordingComplianceNotifier();
    const BROKEN_ORG = "00000000-0000-4000-8000-0000000000bb";

    const flakyAccessReviewClient: AccessReviewClient = {
      async loadOrganization({ organizationId }) {
        if (organizationId === BROKEN_ORG) throw new Error("simulated org failure");
        return { id: organizationId, slug: ORG_SLUG };
      },
      loadUsersWithRoles: accessReviewClient.loadUsersWithRoles.bind(accessReviewClient),
    };

    const loop = createQuarterlyAccessReviewLoop({
      prisma: buildPrismaFake([
        { id: ORG_ID, slug: ORG_SLUG },
        { id: BROKEN_ORG, slug: "broken-org" },
      ]),
      logger,
      accessReviewClient: flakyAccessReviewClient,
      activityClient,
      evidencePublisher: publisher,
      notifier,
    });

    const summary = await loop.runOnce(new Date("2026-04-01T03:00:00Z"));
    expect(summary.organizationsProcessed).toBe(1);
    expect(summary.organizationsFailed).toBe(1);
  });
});
