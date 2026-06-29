// /ops — operator dashboard (inside the application shell).
//
// A role-aware control surface: at-a-glance attention metrics, the
// live workflow pipeline (queue depth per stage), the emergency bucket,
// and quick jumps into the operator's own queues. Every datum is
// scoped to the operator's org + resolved server-side.
//
// PHI: dashboard surfaces are non-PHI — counts, order numbers, status,
// SLA. No patient identity is read here.

import Link from "next/link";

import { PERMISSIONS, type PermissionCode } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../src/server/auth/resolve-tenancy.js";
import { getQueueCounts } from "../../src/server/ops/get-queue-counts.js";
import { listEmergencyOrders } from "../../src/server/ops/list-emergency-orders.js";
import { PageHeader, Section } from "../../src/components/ui/page.js";
import { Stat } from "../../src/components/ui/data.js";
import { Card, LinkCard } from "../../src/components/ui/card.js";
import { Badge } from "../../src/components/ui/badge.js";
import { Banner, EmptyState } from "../../src/components/ui/feedback.js";
import { buttonClass } from "../../src/components/ui/button.js";
import { Icon, type IconName } from "../../src/components/ui/icon.js";
import { priorityMeta, statusMeta } from "../../src/components/ui/workflow.js";
import { SlaBadge, slaStatusFor } from "../../src/components/sla-badge.js";
import { cx } from "../../src/components/ui/cx.js";

function ageLabel(from: Date, now: number): string {
  const ms = now - from.getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

interface StageDef {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly icon: IconName;
  readonly tone: "info" | "brand" | "cyan";
  readonly codes: ReadonlyArray<string>;
  readonly requires: PermissionCode;
}

const STAGES: ReadonlyArray<StageDef> = [
  {
    key: "typing",
    label: "Typing",
    href: "/ops/typing",
    icon: "typing",
    tone: "info",
    codes: ["INBOX", "TYPING"],
    requires: PERMISSIONS.TYPING_START,
  },
  {
    key: "pv1",
    label: "PV1",
    href: "/ops/pv1",
    icon: "verify",
    tone: "brand",
    codes: ["PV1"],
    requires: PERMISSIONS.PV1_START,
  },
  {
    key: "fill",
    label: "Fill",
    href: "/ops/fill",
    icon: "fill",
    tone: "info",
    codes: ["FILL"],
    requires: PERMISSIONS.FILL_START,
  },
  {
    key: "final",
    label: "Final",
    href: "/ops/final",
    icon: "final",
    tone: "brand",
    codes: ["FINAL"],
    requires: PERMISSIONS.FINAL_START,
  },
];

export default async function DashboardPage() {
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null; // layout already rendered the message

  const permissions = await loadOperatorPermissions(session.tenancy);
  const counts = await getQueueCounts({
    organizationId: session.tenancy.organizationId,
    bucketCodes: ["INBOX", "TYPING", "PV1", "FILL", "FINAL"],
  });

  const canSeeEmergency = hasOperatorPermission(permissions, PERMISSIONS.SHIP_RESOLVE_ESCALATION);
  const emergency = canSeeEmergency
    ? await listEmergencyOrders({ organizationId: session.tenancy.organizationId, limit: 6 })
    : null;

  const n = (code: string): number => {
    const c = counts[code];
    return typeof c === "number" ? c : 0;
  };
  const stageCount = (codes: ReadonlyArray<string>): number =>
    codes.reduce((sum, c) => sum + n(c), 0);

  const inFlight = n("INBOX") + n("TYPING") + n("PV1") + n("FILL") + n("FINAL");
  const awaitingVerification = n("PV1") + n("FINAL");
  const emergencyCount = emergency?.rows.length ?? 0;
  const now = Date.now();
  const nowDate = new Date(now);

  const greeting = (() => {
    const h = nowDate.getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();
  const today = nowDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const quickActions = STAGES.filter((s) => hasOperatorPermission(permissions, s.requires));

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow={today}
        title={`${greeting}, ${session.operator.displayName.split(" ")[0] ?? session.operator.displayName}`}
        description="Your pharmacy at a glance — live queue depth, exceptions, and the fastest path into your work."
        actions={
          quickActions.length > 0 ? (
            <Link href={quickActions[0]!.href} className={buttonClass({ variant: "primary" })}>
              <Icon name={quickActions[0]!.icon} size={16} />
              Go to {quickActions[0]!.label}
            </Link>
          ) : undefined
        }
      />

      {emergencyCount > 0 ? (
        <Banner
          tone="danger"
          title={`${emergencyCount} order${emergencyCount === 1 ? "" : "s"} in the emergency bucket`}
        >
          Orders escalated past SLA or flagged by shipping exceptions need attention.{" "}
          {canSeeEmergency ? (
            <Link href="/ops/emergency" className="font-medium underline underline-offset-2">
              Open the emergency queue →
            </Link>
          ) : null}
        </Banner>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="In-flight orders"
          value={inFlight}
          icon="package"
          tone="brand"
          hint="Across all active stages"
        />
        <Stat
          label="Awaiting verification"
          value={awaitingVerification}
          icon="verify"
          tone={awaitingVerification > 0 ? "info" : "neutral"}
          hint="PV1 + final review"
        />
        <Stat
          label="Ready to type"
          value={n("INBOX")}
          icon="typing"
          tone={n("INBOX") > 0 ? "warning" : "neutral"}
          hint="Inbox waiting to be claimed"
        />
        <Stat
          label="Emergency"
          value={canSeeEmergency ? emergencyCount : "—"}
          icon="emergency"
          tone={emergencyCount > 0 ? "danger" : "neutral"}
          hint={canSeeEmergency ? "Escalated orders" : "Requires escalation access"}
        />
      </div>

      <Section title="Workflow pipeline" aside="Live queue depth, in flow order">
        <Card>
          <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-stretch sm:gap-0">
            {STAGES.map((stage, i) => {
              const count = stageCount(stage.codes);
              const permitted = hasOperatorPermission(permissions, stage.requires);
              const body = (
                <div
                  className={cx(
                    "flex flex-1 items-center gap-3 rounded-lg px-4 py-3 transition-colors",
                    permitted ? "hover:bg-surface-2" : "opacity-60"
                  )}
                >
                  <span
                    className={cx(
                      "flex h-10 w-10 items-center justify-center rounded-lg border",
                      count > 0
                        ? "border-brand/30 bg-brand/10 text-brand"
                        : "border-line bg-surface-2 text-subtle"
                    )}
                  >
                    <Icon name={stage.icon} size={18} />
                  </span>
                  <div>
                    <div className="text-2xl font-semibold tracking-tight text-fg tabular-nums">
                      {count}
                    </div>
                    <div className="text-xs text-muted">{stage.label}</div>
                  </div>
                </div>
              );
              return (
                <div key={stage.key} className="flex flex-1 items-center">
                  {permitted ? (
                    <Link href={stage.href} className="flex-1">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex-1">{body}</div>
                  )}
                  {i < STAGES.length - 1 ? (
                    <Icon
                      name="chevronRight"
                      size={16}
                      className="hidden shrink-0 text-subtle sm:block"
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      </Section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Section title="Emergency bucket" className="lg:col-span-3">
          {!canSeeEmergency ? (
            <EmptyState
              icon="shield"
              title="Emergency queue is access-gated"
              description="You don't have the escalation-resolution grant, so emergency orders are hidden from your dashboard."
            />
          ) : emergencyCount === 0 ? (
            <EmptyState
              icon="check"
              title="Nothing on fire"
              description="No orders are currently escalated to the emergency bucket. SLA breaches and shipping exceptions will appear here."
            />
          ) : (
            <div className="space-y-2">
              {emergency!.rows.map((row) => {
                const sm = statusMeta(row.currentStatus);
                const pm = priorityMeta(row.priority);
                return (
                  <LinkCard
                    key={row.orderId}
                    href={`/ops/orders/${row.orderId}`}
                    accent={
                      slaStatusFor(row.slaDeadlineAt, nowDate) === "BREACHED" ? "danger" : "warning"
                    }
                    end={
                      <div className="flex items-center gap-3 text-xs text-subtle">
                        <SlaBadge slaDeadlineAt={row.slaDeadlineAt} now={nowDate} />
                        <span>aged {ageLabel(row.receivedAt, now)}</span>
                      </div>
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-fg">
                        {row.externalOrderNumber ?? row.orderId}
                      </span>
                      <Badge tone={pm.tone}>{pm.label}</Badge>
                      <Badge tone={sm.tone}>{sm.label}</Badge>
                    </div>
                  </LinkCard>
                );
              })}
              <Link
                href="/ops/emergency"
                className={cx(buttonClass({ variant: "ghost", size: "sm" }), "w-full")}
              >
                View all emergency orders
                <Icon name="arrowRight" size={14} />
              </Link>
            </div>
          )}
        </Section>

        <Section title="Jump back in" className="lg:col-span-2">
          {quickActions.length === 0 ? (
            <EmptyState
              icon="check"
              title="No queues assigned"
              description="Your role doesn't grant access to a workflow queue yet. Ask your admin for a queue grant."
            />
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {quickActions.map((s) => {
                const count = stageCount(s.codes);
                return (
                  <LinkCard key={s.key} href={s.href} icon={s.icon}>
                    <div className="text-sm font-medium text-fg">{s.label} queue</div>
                    <div className="text-xs text-muted">
                      {count} order{count === 1 ? "" : "s"} waiting
                    </div>
                  </LinkCard>
                );
              })}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
