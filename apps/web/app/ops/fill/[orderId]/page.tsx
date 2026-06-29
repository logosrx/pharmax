// /ops/fill/[orderId] — pharmacy tech FILL workbench.
//
// One-screen surface for the assigned tech: workstation picker
// (URL-pinned), per-line lot assignment + vial-label print, and a
// scan-to-complete form that runs CompleteFill's barcode validation.
//
// Permission gates: page (fill.start), assign (fill.assign_lot), print
// (fill.print_vial_label), complete (fill.complete). Only the assignee
// can act (command-bus assignee guards); others see a read-only view.
// PHI: workbench is non-PHI; /ops/orders/[id] is the PHI read.

import Link from "next/link";

import { PERMISSIONS } from "@pharmax/rbac";

import {
  hasOperatorPermission,
  loadOperatorPermissions,
} from "../../../../src/server/auth/operator-permissions.js";
import { resolveOperatorTenancyContext } from "../../../../src/server/auth/resolve-tenancy.js";
import { getFillWorkbench } from "../../../../src/server/ops/get-fill-workbench.js";
import { PageHeader, Section } from "../../../../src/components/ui/page.js";
import { Card, CardContent, CardHeader } from "../../../../src/components/ui/card.js";
import { Badge } from "../../../../src/components/ui/badge.js";
import { Banner, EmptyState, PermissionDenied } from "../../../../src/components/ui/feedback.js";
import { Field, Select, Input } from "../../../../src/components/ui/field.js";
import { buttonClass } from "../../../../src/components/ui/button.js";
import { Icon } from "../../../../src/components/ui/icon.js";
import { statusMeta } from "../../../../src/components/ui/workflow.js";
import { ActionForm, SubmitButton } from "../../../../src/components/ops/action-form.js";

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function FillWorkbenchPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly orderId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ orderId }, sp] = await Promise.all([params, searchParams]);
  const session = await resolveOperatorTenancyContext();
  if (!session.ok) return null;

  const permissions = await loadOperatorPermissions(session.tenancy);
  if (!hasOperatorPermission(permissions, PERMISSIONS.FILL_START)) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Production" title="Fill workbench" />
        <PermissionDenied grant="fill.start" role="Pharmacy Technician" />
      </div>
    );
  }

  const canAssign = hasOperatorPermission(permissions, PERMISSIONS.FILL_ASSIGN_LOT);
  const canPrint = hasOperatorPermission(permissions, PERMISSIONS.FILL_PRINT_VIAL_LABEL);
  const canComplete = hasOperatorPermission(permissions, PERMISSIONS.FILL_COMPLETE);

  const workbench = await getFillWorkbench({
    organizationId: session.tenancy.organizationId,
    orderId,
  });

  if (workbench === null) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Production" title="Order not found" />
        <EmptyState
          icon="fill"
          title="This order doesn't exist in your organization"
          action={
            <Link href="/ops/fill" className={buttonClass({ variant: "secondary", size: "sm" })}>
              Back to fill queue
            </Link>
          }
        />
      </div>
    );
  }

  const isMine = workbench.currentAssigneeUserId === session.operator.userId;
  const inProgress = workbench.currentStatus === "FILL_IN_PROGRESS";
  const flashError = typeof sp["error"] === "string" ? sp["error"] : null;
  const flashKey = typeof sp["flash"] === "string" ? sp["flash"] : null;
  const flashLineId = typeof sp["lineId"] === "string" ? sp["lineId"] : null;
  const sm = statusMeta(workbench.currentStatus);

  const requestedWs = typeof sp["workstation"] === "string" ? sp["workstation"] : null;
  const workstationIsValid =
    requestedWs !== null &&
    workbench.availableWorkstations.some((w) => w.workstationId === requestedWs);
  const activeWorkstationId = workstationIsValid
    ? requestedWs
    : (workbench.availableWorkstations[0]?.workstationId ?? null);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/ops/fill"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
        >
          <Icon name="arrowLeft" size={15} />
          Back to fill queue
        </Link>
        <Link
          href={`/ops/orders/${workbench.orderId}`}
          className="inline-flex items-center gap-1.5 text-sm text-brand transition-colors hover:underline"
        >
          Order detail (patient + sig)
          <Icon name="arrowRight" size={15} />
        </Link>
      </div>

      <PageHeader
        eyebrow={
          <span className="normal-case tracking-normal text-subtle">
            v{workbench.version}
            {workbench.currentAssigneeUserId !== null ? (
              <>
                {" "}
                · assignee <code>{workbench.currentAssigneeUserId}</code>
              </>
            ) : null}
          </span>
        }
        title={
          <span className="font-mono">{workbench.externalOrderNumber ?? workbench.orderId}</span>
        }
        actions={
          <Badge tone={sm.tone} dot>
            {sm.label}
          </Badge>
        }
      />

      {flashError !== null ? (
        <Banner tone="danger" title="That action didn't go through">
          {flashError}
        </Banner>
      ) : null}
      {flashKey !== null ? (
        <Banner tone="success">
          {flashKey}
          {flashLineId !== null ? (
            <>
              {" "}
              for line <code>{flashLineId}</code>
            </>
          ) : null}
        </Banner>
      ) : null}

      {!inProgress ? (
        <Banner tone="warning" title="Workbench actions inactive">
          This order is not in FILL_IN_PROGRESS. Status <code>{workbench.currentStatus}</code>.
        </Banner>
      ) : null}
      {inProgress && !isMine ? (
        <Banner tone="warning" title="Read-only — you're not the assignee">
          The assignee must complete the fill, or release the order back to FILL.
        </Banner>
      ) : null}

      <Section title="Workstation">
        {workbench.availableWorkstations.length === 0 ? (
          <Banner tone="danger" title="No active workstations at this site">
            Print actions will fail. An admin must register a workstation before fills can be
            printed.
          </Banner>
        ) : (
          <Card>
            <CardContent>
              <form method="GET" className="flex flex-wrap items-end gap-2">
                <Field label="Active workstation" help="Used for print actions on this page">
                  <Select name="workstation" defaultValue={activeWorkstationId ?? ""}>
                    {workbench.availableWorkstations.map((w) => (
                      <option key={w.workstationId} value={w.workstationId}>
                        {w.code} — {w.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <button type="submit" className={buttonClass({ variant: "secondary" })}>
                  Switch
                </button>
              </form>
            </CardContent>
          </Card>
        )}
      </Section>

      <Section title="Prescription lines" count={workbench.lines.length}>
        <div className="space-y-3">
          {workbench.lines.map((line, idx) => {
            const hasLot = line.assignedLot !== null;
            const hasLabel = line.vialLabel !== null;
            return (
              <Card key={line.orderLineId}>
                <CardHeader>
                  <div>
                    <div className="text-[11px] text-subtle">
                      Line {idx + 1} · NDC <code className="font-mono">{line.drugNdc}</code> · Rx{" "}
                      <code className="font-mono">{line.rxNumber}</code>
                    </div>
                    <div className="text-base text-fg">
                      {line.drugName}
                      {line.drugStrength !== null ? ` ${line.drugStrength}` : ""} · qty{" "}
                      <span className="font-mono">{line.quantityToFill}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={hasLot ? "success" : "neutral"}>
                      {hasLot ? "lot ✓" : "no lot"}
                    </Badge>
                    <Badge tone={hasLabel ? "success" : "neutral"}>
                      {hasLabel ? "label ✓" : "no label"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-wide text-subtle">
                        Lot
                      </div>
                      {hasLot ? (
                        <div className="text-sm text-fg">
                          Assigned ·{" "}
                          <span className="font-mono">{line.assignedLot!.lotNumber}</span>
                        </div>
                      ) : isMine && canAssign && inProgress ? (
                        line.candidateLots.length === 0 ? (
                          <p className="text-sm text-amber-300">
                            No active, unexpired lots for NDC {line.drugNdc} at this site. Receive
                            inventory before continuing.
                          </p>
                        ) : (
                          <ActionForm
                            action={`/api/ops/orders/${workbench.orderId}/assign-lot`}
                            className="flex flex-wrap items-end gap-2"
                          >
                            <input type="hidden" name="orderLineId" value={line.orderLineId} />
                            <Field label="Lot">
                              <Select name="lotId" defaultValue={line.candidateLots[0]?.lotId}>
                                {line.candidateLots.map((lot) => (
                                  <option key={lot.lotId} value={lot.lotId}>
                                    {lot.lotNumber} (exp {formatDate(lot.expirationDate)})
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <SubmitButton icon="check">Assign lot</SubmitButton>
                          </ActionForm>
                        )
                      ) : (
                        <p className="text-sm text-subtle">Not assigned.</p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-wide text-subtle">
                        Vial label
                      </div>
                      {hasLabel ? (
                        <div className="text-sm text-fg">
                          {line.vialLabel!.latestPrintJobStatus ?? "—"} ·{" "}
                          <code className="font-mono text-xs text-muted">
                            {line.vialLabel!.barcodeValue}
                          </code>
                        </div>
                      ) : isMine && canPrint && inProgress ? (
                        !hasLot ? (
                          <p className="text-sm text-subtle">Assign a lot first.</p>
                        ) : workbench.availablePrinters.length === 0 ? (
                          <p className="text-sm text-amber-300">
                            No active label printers at this site.
                          </p>
                        ) : activeWorkstationId === null ? (
                          <p className="text-sm text-amber-300">
                            Select a workstation above before printing.
                          </p>
                        ) : (
                          <ActionForm
                            action={`/api/ops/orders/${workbench.orderId}/print-vial-label`}
                            className="flex flex-wrap items-end gap-2"
                          >
                            <input type="hidden" name="orderLineId" value={line.orderLineId} />
                            <input type="hidden" name="workstationId" value={activeWorkstationId} />
                            <Field label="Printer">
                              <Select
                                name="printerId"
                                defaultValue={workbench.availablePrinters[0]?.printerId}
                              >
                                {workbench.availablePrinters.map((p) => (
                                  <option key={p.printerId} value={p.printerId}>
                                    {p.code} — {p.name}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <SubmitButton icon="print">Print vial label</SubmitButton>
                          </ActionForm>
                        )
                      ) : (
                        <p className="text-sm text-subtle">Not printed.</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </Section>

      {isMine && inProgress && canComplete ? (
        <Section title="Scan to complete">
          {!workbench.readyForCompletionScans ? (
            <Banner tone="neutral">
              Every line needs an assigned lot AND a printed vial label before you can scan to
              complete.
            </Banner>
          ) : (
            <Card>
              <CardContent>
                <ActionForm
                  action={`/api/ops/orders/${workbench.orderId}/complete-fill`}
                  className="space-y-4"
                >
                  {workbench.lines.map((line, idx) => (
                    <div
                      key={line.orderLineId}
                      className="space-y-2 border-b border-line pb-4 last:border-b-0 last:pb-0"
                    >
                      <div className="text-xs text-subtle">
                        Line {idx + 1} · {line.drugName}
                      </div>
                      <input
                        type="hidden"
                        name={`lineScans[${idx}][orderLineId]`}
                        value={line.orderLineId}
                      />
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label="Lot scan">
                          <Input
                            type="text"
                            name={`lineScans[${idx}][lotScan]`}
                            autoComplete="off"
                            required
                            className="font-mono"
                            placeholder="(scan lot barcode)"
                          />
                        </Field>
                        <Field label="Vial label scan">
                          <Input
                            type="text"
                            name={`lineScans[${idx}][vialLabelScan]`}
                            autoComplete="off"
                            required
                            className="font-mono"
                            placeholder="(scan printed vial label)"
                          />
                        </Field>
                      </div>
                    </div>
                  ))}
                  <SubmitButton variant="go" icon="check">
                    Complete fill · scan-validate all lines
                  </SubmitButton>
                </ActionForm>
              </CardContent>
            </Card>
          )}
        </Section>
      ) : null}
    </div>
  );
}
