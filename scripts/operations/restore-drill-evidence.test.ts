// scripts/operations/restore-drill-evidence.test.ts

import { describe, expect, it } from "vitest";

import {
  composeEvidenceJson,
  composeEvidenceMarkdown,
  composeProvisionScript,
  composeTeardownScript,
  type DrillRecord,
} from "./restore-drill-evidence.js";

const BASE_RECORD: DrillRecord = {
  quarter: "2026-Q2",
  captain: "Alice Pharmacist",
  observer: "Bob Engineer",
  startedAtIso: "2026-06-04T19:30:00Z",
  completedAtIso: "2026-06-04T20:15:00Z",
  sourceClusterId: "pharmax-prod-use1-aurora",
  drillClusterId: "pharmax-prod-use1-aurora-drill-20260604",
  drillInstanceId: "pharmax-prod-use1-aurora-drill-20260604-0",
  restoreTimeIso: "2026-06-04T18:00:00Z",
  preflight: {
    kmsKeyArn: "arn:aws:kms:us-east-1:111122223333:key/abcd-1234",
    kmsHealthy: true,
    kmsReason: null,
    backupRetentionDays: 35,
    latestRestorableTimeIso: "2026-06-04T19:25:00Z",
  },
  verify: {
    smokeConnect: { ok: true, engineVersion: "16.4", reason: null },
    auditChain: {
      ok: true,
      orgsChecked: 12,
      orgsFailed: 0,
      perOrg: [],
    },
    rowCounts: {
      organizations: 12,
      users: 84,
      orders: 12_345,
      auditLogRows: 98_765,
      eventOutboxRows: 5_432,
    },
    rlsSanity: { ok: true, reason: null },
  },
  teardownConfirmed: false,
  findings: [],
  signOff: "Drill captain confirms restore path is exercised end-to-end. Signed: Alice Pharmacist",
};

describe("composeProvisionScript", () => {
  const SCRIPT = composeProvisionScript({
    sourceClusterId: "pharmax-prod-use1-aurora",
    drillClusterId: "pharmax-prod-use1-aurora-drill-20260604",
    drillInstanceId: "pharmax-prod-use1-aurora-drill-20260604-0",
    restoreTimeIso: "2026-06-04T18:00:00Z",
    subnetGroup: "pharmax-prod-use1-db",
    drillSecurityGroupId: "sg-0123abcd",
    instanceClass: "db.t4g.medium",
  });

  it("includes the bash shebang + strict-mode preamble", () => {
    expect(SCRIPT.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(SCRIPT).toContain("set -euo pipefail");
  });

  it("substitutes all variables single-quoted", () => {
    expect(SCRIPT).toContain("SRC_CLUSTER_ID='pharmax-prod-use1-aurora'");
    expect(SCRIPT).toContain("RESTORE_TIME='2026-06-04T18:00:00Z'");
    expect(SCRIPT).toContain("NEW_CLUSTER_ID='pharmax-prod-use1-aurora-drill-20260604'");
    expect(SCRIPT).toContain("NEW_INSTANCE_ID='pharmax-prod-use1-aurora-drill-20260604-0'");
    expect(SCRIPT).toContain("SUBNET_GROUP='pharmax-prod-use1-db'");
    expect(SCRIPT).toContain("DRILL_SG='sg-0123abcd'");
    expect(SCRIPT).toContain("INSTANCE_CLASS='db.t4g.medium'");
  });

  it("emits restore-cluster + create-instance + wait sequence", () => {
    expect(SCRIPT).toContain("aws rds restore-db-cluster-to-point-in-time");
    expect(SCRIPT).toContain("aws rds wait db-cluster-available");
    expect(SCRIPT).toContain("aws rds create-db-instance");
    expect(SCRIPT).toContain("aws rds wait db-instance-available");
  });

  it("pins the no-publicly-accessible + deletion-protection invariants", () => {
    expect(SCRIPT).toContain("--no-publicly-accessible");
    expect(SCRIPT).toContain("--deletion-protection");
  });

  it("pins the runbook-mandated cloudwatch-logs-exports postgresql flag", () => {
    expect(SCRIPT).toContain("--enable-cloudwatch-logs-exports postgresql");
  });

  it("safely quotes a value containing a single quote (defense in depth)", () => {
    const script = composeProvisionScript({
      sourceClusterId: "alice's-cluster",
      drillClusterId: "x",
      drillInstanceId: "y",
      restoreTimeIso: "2026-06-04T18:00:00Z",
      subnetGroup: "z",
      drillSecurityGroupId: "sg-a",
      instanceClass: "db.t4g.medium",
    });
    expect(script).toContain("SRC_CLUSTER_ID='alice'\\''s-cluster'");
  });
});

describe("composeTeardownScript", () => {
  const SCRIPT = composeTeardownScript({
    drillClusterId: "pharmax-prod-use1-aurora-drill-20260604",
    drillInstanceId: "pharmax-prod-use1-aurora-drill-20260604-0",
  });

  it("emits the three teardown steps in order: delete-instance, modify-cluster, delete-cluster", () => {
    const i1 = SCRIPT.indexOf("aws rds delete-db-instance");
    const i2 = SCRIPT.indexOf("aws rds modify-db-cluster");
    const i3 = SCRIPT.indexOf("aws rds delete-db-cluster");
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });

  it("disables deletion-protection before delete-cluster", () => {
    expect(SCRIPT).toContain("--no-deletion-protection");
  });

  it("verifies destroy with describe-db-clusters at the end", () => {
    expect(SCRIPT).toContain("aws rds describe-db-clusters");
    expect(SCRIPT).toContain("FAIL: cluster");
  });
});

describe("composeEvidenceJson", () => {
  it("emits stable, pretty-printed JSON with trailing newline", () => {
    const out = composeEvidenceJson(BASE_RECORD);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('"quarter": "2026-Q2"');
    expect(JSON.parse(out)).toEqual(BASE_RECORD);
  });

  it("is byte-identical across two calls (deterministic)", () => {
    expect(composeEvidenceJson(BASE_RECORD)).toBe(composeEvidenceJson(BASE_RECORD));
  });
});

describe("composeEvidenceMarkdown", () => {
  it("populates the §3 template header with captain + dates + cluster ids", () => {
    const md = composeEvidenceMarkdown(BASE_RECORD);
    expect(md).toContain("QUARTERLY AURORA RESTORE DRILL — 2026-Q2");
    expect(md).toContain("Captain:        Alice Pharmacist");
    expect(md).toContain("Observer:       Bob Engineer");
    expect(md).toContain("Started:        2026-06-04T19:30:00Z");
    expect(md).toContain("Completed:      2026-06-04T20:15:00Z");
    expect(md).toContain("Drill cluster:  pharmax-prod-use1-aurora-drill-20260604");
    expect(md).toContain("Source:         pharmax-prod-use1-aurora");
    expect(md).toContain("Restore time:   2026-06-04T18:00:00Z");
  });

  it("emits <in flight> when completion timestamp is null", () => {
    const md = composeEvidenceMarkdown({
      ...BASE_RECORD,
      completedAtIso: null,
    });
    expect(md).toContain("Completed:      <in flight>");
  });

  it("renders all §1 preflight fields when preflight is captured", () => {
    const md = composeEvidenceMarkdown(BASE_RECORD);
    expect(md).toContain("§1. Provision");
    expect(md).toContain("KMS CMK (arn:aws:kms:us-east-1:111122223333:key/abcd-1234): PASS");
    expect(md).toContain("Backup retention: 35 day(s)");
    expect(md).toContain("Latest restorable time: 2026-06-04T19:25:00Z");
  });

  it("emits FAIL + reason when preflight KMS is unhealthy", () => {
    const md = composeEvidenceMarkdown({
      ...BASE_RECORD,
      preflight: {
        kmsKeyArn: "arn:aws:kms:us-east-1:111122223333:key/abcd-1234",
        kmsHealthy: false,
        kmsReason: "KeyState=Disabled",
        backupRetentionDays: 35,
        latestRestorableTimeIso: "2026-06-04T19:25:00Z",
      },
    });
    expect(md).toContain(
      "KMS CMK (arn:aws:kms:us-east-1:111122223333:key/abcd-1234): FAIL — KeyState=Disabled"
    );
  });

  it("renders all §2 verify fields including row counts when verify is captured", () => {
    const md = composeEvidenceMarkdown(BASE_RECORD);
    expect(md).toContain("§2. Verify");
    expect(md).toContain("psql smoke connect: PASS — engine 16.4");
    expect(md).toContain("verifyChain across orgs: PASS (12 checked, 0 failed)");
    expect(md).toContain("organizations: 12");
    expect(md).toContain("users:         84");
    expect(md).toContain("audit_log:     98765");
    expect(md).toContain("RLS sanity: PASS");
  });

  it("renders per-org BROKEN rows under verifyChain when chain breaks are present", () => {
    const md = composeEvidenceMarkdown({
      ...BASE_RECORD,
      verify: {
        ...BASE_RECORD.verify!,
        auditChain: {
          ok: false,
          orgsChecked: 12,
          orgsFailed: 1,
          perOrg: [
            {
              organizationId: "00000000-0000-0000-0000-000000000001",
              organizationSlug: "acme-pharma",
              chainValid: false,
              verifiedRows: 5,
              lastSeq: "5",
              reason: "AuditChainBrokenError: seq gap: expected 6, got 8",
            },
            {
              organizationId: "00000000-0000-0000-0000-000000000002",
              organizationSlug: "clean-pharma",
              chainValid: true,
              verifiedRows: 42,
              lastSeq: "42",
              reason: null,
            },
          ],
        },
      },
    });
    expect(md).toContain("verifyChain across orgs: FAIL (12 checked, 1 failed)");
    expect(md).toContain(
      "BROKEN: acme-pharma (00000000-0000-0000-0000-000000000001) — AuditChainBrokenError: seq gap: expected 6, got 8"
    );
    expect(md).not.toContain("BROKEN: clean-pharma");
  });

  it("emits §3 teardown 'NO' + the failure-mode banner when verify FAILED and teardown not confirmed", () => {
    const md = composeEvidenceMarkdown({
      ...BASE_RECORD,
      teardownConfirmed: false,
    });
    expect(md).toContain("§3. Teardown");
    expect(md).toContain("Destroy confirmed: NO");
    expect(md).toContain("if the verify phase FAILED, the cluster is now evidence");
  });

  it("emits §3 teardown 'YES' when confirmed", () => {
    const md = composeEvidenceMarkdown({
      ...BASE_RECORD,
      teardownConfirmed: true,
    });
    expect(md).toContain("Destroy confirmed: YES");
    expect(md).not.toContain("the cluster is now evidence");
  });

  it("emits 'none' under §4 findings when the findings list is empty", () => {
    const md = composeEvidenceMarkdown(BASE_RECORD);
    expect(md).toMatch(/§4\. Findings\n- none/);
  });

  it("emits each finding as a bullet under §4 when present", () => {
    const md = composeEvidenceMarkdown({
      ...BASE_RECORD,
      findings: [
        "engine version drift: source 16.4, restored 16.5",
        "backup retention is 30, expected ≥ 35",
      ],
    });
    expect(md).toContain("- engine version drift: source 16.4, restored 16.5");
    expect(md).toContain("- backup retention is 30, expected ≥ 35");
  });

  it("emits 'pending' under §5 when no sign-off is provided", () => {
    const md = composeEvidenceMarkdown({
      ...BASE_RECORD,
      signOff: null,
    });
    expect(md).toMatch(/§5\. Sign-off\n- pending/);
  });
});
