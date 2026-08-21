// Prescription history panel for the patient detail page.
//
// One block per prescription rather than a table row, because the facts
// a pharmacist checks are not all the same shape: drug and sig are
// text, refills and quantity are numbers, and the fills are a nested
// list. Forcing them into columns would make the sig unreadable, and
// the sig is the point.
//
// Standing is computed from status AND the expiry date, so a
// prescription that lapsed yesterday reads as expired even though
// nothing has run to change its stored status. Same reasoning as the
// credential pages: a stored flag needs a sweeper, and the window
// before the sweeper runs is exactly when the wrong answer is
// dangerous.
//
// PHI: renders the decrypted sig. Only mounted by the patient detail
// page, which audits the view and refuses to render on audit failure.

import Link from "next/link";
import type { ReactNode } from "react";

import type {
  PatientRxHistory,
  PatientRxHistoryRow,
} from "../../server/ops/get-patient-rx-history.js";

import { Badge, type Tone } from "../ui/badge.js";
import { Card, CardContent } from "../ui/card.js";
import { buttonClass } from "../ui/button.js";
import { EmptyState } from "../ui/feedback.js";
import { Icon } from "../ui/icon.js";

function formatDate(value: Date | null): string {
  return value === null ? "—" : value.toLocaleDateString("en-US");
}

/** Standing shown to the pharmacist, folding expiry into status. */
function standing(row: PatientRxHistoryRow): { readonly label: string; readonly tone: Tone } {
  switch (row.status) {
    case "DISCONTINUED":
      return { label: "Discontinued", tone: "danger" };
    case "TRANSFERRED_OUT":
      return { label: "Transferred out", tone: "neutral" };
    case "EXPIRED":
      return { label: "Expired", tone: "warning" };
    case "ACTIVE":
      // Derived, not stored — see the file header.
      if (row.expired) return { label: "Lapsed", tone: "warning" };
      if (row.refillsRemaining === 0) return { label: "No refills left", tone: "warning" };
      return { label: "Active", tone: "success" };
    default: {
      const exhaustive: never = row.status;
      return exhaustive;
    }
  }
}

function drugLabel(row: PatientRxHistoryRow): string {
  return [row.drugName, row.drugStrength, row.drugForm].filter((p) => p !== null).join(" ");
}

function RxBlock({ row }: { readonly row: PatientRxHistoryRow }): ReactNode {
  const s = standing(row);
  const controlled = row.controlledSubstanceSchedule !== "NON_CONTROLLED";

  return (
    <Card>
      <CardContent>
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg">{drugLabel(row)}</span>
                <Badge tone={s.tone}>{s.label}</Badge>
                {controlled ? (
                  <Badge tone="warning">{row.controlledSubstanceSchedule}</Badge>
                ) : null}
              </div>
              <div className="font-mono text-xs text-subtle">
                Rx {row.rxNumber} · NDC {row.drugNdc}
              </div>
            </div>
            <div className="text-right text-xs text-muted">
              <div>{row.clinicCode}</div>
              <Link
                href={`/ops/admin/providers/${row.prescriberId}`}
                className="transition-colors hover:text-fg"
              >
                {row.prescriberDisplayName}
              </Link>
            </div>
          </div>

          {/* The directions. Without these it is not a medication
              record, which is why the sig is decrypted here at all. */}
          <div className="rounded-md border border-line bg-surface-2 p-2.5 text-sm">
            {row.sig === null ? (
              <span className="italic text-subtle">
                Directions could not be decrypted — open the order for the original.
              </span>
            ) : (
              row.sig
            )}
          </div>

          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
            <div>
              <dt className="text-muted">Written</dt>
              <dd className="mt-0.5 text-fg">{formatDate(row.originalDateWritten)}</dd>
            </div>
            <div>
              <dt className="text-muted">Expires</dt>
              <dd className={`mt-0.5 ${row.expired ? "text-tone-warning" : "text-fg"}`}>
                {formatDate(row.expiresAt)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Quantity</dt>
              <dd className="mt-0.5 text-fg">{row.quantityAuthorized}</dd>
            </div>
            <div>
              <dt className="text-muted">Days supply</dt>
              <dd className="mt-0.5 text-fg">{row.daysSupply}</dd>
            </div>
            <div>
              <dt className="text-muted">Refills</dt>
              <dd className="mt-0.5 text-fg">
                {row.refillsRemaining} of {row.refillsAuthorized} left
              </dd>
            </div>
          </dl>

          {row.fills.length > 0 ? (
            <div className="border-t border-line pt-2.5">
              <div className="mb-1.5 text-xs font-medium text-muted">
                Dispensed {row.fills.length === 1 ? "once" : `${row.fills.length} times`}
              </div>
              <ul className="space-y-1">
                {row.fills.map((fill) => (
                  <li
                    key={fill.orderId}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                  >
                    <Link
                      href={`/ops/orders/${fill.orderId}`}
                      className="font-mono text-muted transition-colors hover:text-fg"
                    >
                      {fill.externalOrderNumber ?? fill.orderId.slice(0, 8)}
                    </Link>
                    <span className="text-subtle">{formatDate(fill.receivedAt)}</span>
                    <Badge tone={fill.orderStatus === "SHIPPED" ? "success" : "neutral"}>
                      {fill.orderStatus}
                    </Badge>
                    {fill.shippedAt !== null ? (
                      <span className="text-subtle">shipped {formatDate(fill.shippedAt)}</span>
                    ) : null}
                    {/* An excluded line means this drug was NOT
                        dispensed on that order, which would otherwise
                        read as a fill. */}
                    {fill.lineStatus === "EXCLUDED" ? (
                      <Badge tone="warning">not dispensed</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="border-t border-line pt-2.5 text-xs text-subtle">Never dispensed.</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function PatientRxHistoryPanel({
  history,
  nextHref,
}: {
  readonly history: PatientRxHistory;
  /** Next page, or null at the end. */
  readonly nextHref: string | null;
}): ReactNode {
  if (history.totalPrescriptions === 0) {
    return (
      <EmptyState
        icon="typing"
        title="No prescriptions on file"
        description="Nothing has been prescribed for this patient in this organization yet."
      />
    );
  }

  return (
    <div className="space-y-3">
      {history.phiDecryptErrors > 0 ? (
        <div className="rounded-lg border border-tone-warning/40 bg-tone-warning/10 px-3 py-2 text-xs">
          <Badge tone="warning">PHI</Badge> {history.phiDecryptErrors} set
          {history.phiDecryptErrors === 1 ? "" : "s"} of directions could not be decrypted. The
          prescriptions are listed; open the order for the original.
        </div>
      ) : null}

      {history.rows.map((row) => (
        <RxBlock key={row.prescriptionId} row={row} />
      ))}

      {nextHref !== null ? (
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-subtle">
            {history.rows.length} of {history.totalPrescriptions} shown
          </span>
          <Link href={nextHref} className={buttonClass({ variant: "secondary", size: "sm" })}>
            Older prescriptions
            <Icon name="arrowRight" size={13} />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
