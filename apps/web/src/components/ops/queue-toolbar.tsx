// Filter and pagination chrome shared by every workflow queue.
//
// Server-rendered, driven entirely by URL parameters. That is not
// laziness — it means a filtered queue is a link. An operator working
// "rush orders for one client, unclaimed" can bookmark it, and a
// supervisor can paste it into chat and know the recipient sees the
// same rows.
//
// The toolbar is a plain GET form, so it works before hydration and
// needs no client bundle. `Apply` exists for the selects; the toggles
// are links because a single click should not need a second one.

import Link from "next/link";
import type { ReactNode } from "react";

import type { OrderPriority } from "@pharmax/database";

import { Badge } from "../ui/badge.js";
import { buttonClass } from "../ui/button.js";
import { Field, Select } from "../ui/field.js";
import { Icon } from "../ui/icon.js";

export interface QueueFilterOption {
  readonly id: string;
  readonly label: string;
}

export interface QueueToolbarState {
  readonly clinicId?: string;
  readonly siteId?: string;
  readonly priority?: OrderPriority;
  readonly breachedOnly?: boolean;
  readonly unclaimedOnly?: boolean;
}

const PRIORITY_OPTIONS: ReadonlyArray<{ readonly value: OrderPriority; readonly label: string }> = [
  { value: "EMERGENCY", label: "Emergency" },
  { value: "RUSH", label: "Rush" },
  { value: "NORMAL", label: "Normal" },
];

export function QueueToolbar({
  basePath,
  filters,
  clinics,
  sites,
  hrefFor,
  totalMatching,
  shownCount,
}: {
  readonly basePath: string;
  readonly filters: QueueToolbarState;
  readonly clinics: ReadonlyArray<QueueFilterOption>;
  readonly sites: ReadonlyArray<QueueFilterOption>;
  /** Builds a URL with these overrides, preserving other filters. */
  readonly hrefFor: (override: Readonly<Record<string, string | undefined>>) => string;
  readonly totalMatching: number;
  readonly shownCount: number;
}) {
  const anyFilter =
    filters.clinicId !== undefined ||
    filters.siteId !== undefined ||
    filters.priority !== undefined ||
    filters.breachedOnly === true ||
    filters.unclaimedOnly === true;

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
      {/* GET, so submitting rewrites the query string. No cursor is
          carried: a cursor from a different filter set points into a
          sequence that no longer exists. */}
      <form method="get" action={basePath} className="flex flex-wrap items-end gap-3">
        <Field label="Client">
          <Select name="clinicId" defaultValue={filters.clinicId ?? ""}>
            <option value="">All clients</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Site">
          <Select name="siteId" defaultValue={filters.siteId ?? ""}>
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select name="priority" defaultValue={filters.priority ?? ""}>
            <option value="">Any priority</option>
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        {/* Toggles ride along as hidden inputs so applying a select
            does not silently clear them. */}
        {filters.breachedOnly === true ? <input type="hidden" name="breached" value="1" /> : null}
        {filters.unclaimedOnly === true ? <input type="hidden" name="unclaimed" value="1" /> : null}
        <button type="submit" className={buttonClass({ variant: "secondary", size: "md" })}>
          Apply
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={hrefFor({
            breached: filters.breachedOnly === true ? undefined : "1",
            cursor: undefined,
          })}
          className={buttonClass({
            variant: filters.breachedOnly === true ? "danger" : "ghost",
            size: "sm",
          })}
        >
          <Icon name="alert" size={13} />
          Past SLA
        </Link>
        <Link
          href={hrefFor({
            unclaimed: filters.unclaimedOnly === true ? undefined : "1",
            cursor: undefined,
          })}
          className={buttonClass({
            variant: filters.unclaimedOnly === true ? "primary" : "ghost",
            size: "sm",
          })}
        >
          Unclaimed
        </Link>
        {anyFilter ? (
          <Link href={basePath} className={buttonClass({ variant: "ghost", size: "sm" })}>
            Clear filters
          </Link>
        ) : null}
        <span className="ml-auto text-xs text-subtle">
          {/* Showing "25 of 340" rather than just the page count: a
              paginated queue otherwise hides whether the backlog is
              under control. */}
          {shownCount === totalMatching
            ? `${totalMatching} order${totalMatching === 1 ? "" : "s"}`
            : `showing ${shownCount} of ${totalMatching}`}
          {anyFilter ? " · filtered" : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * Next-page link. Cursor pagination is forward-only, so there is no
 * "previous" — going back is what the browser's back button is for,
 * and a fake previous link would need a cursor stack in the URL.
 */
export function QueuePager({
  nextHref,
  shownCount,
  totalMatching,
}: {
  readonly nextHref: string | null;
  readonly shownCount: number;
  readonly totalMatching: number;
}) {
  if (nextHref === null) return null;
  return (
    <div className="flex items-center justify-between gap-3 pt-2">
      <span className="text-xs text-subtle">
        {shownCount} of {totalMatching} shown
      </span>
      <Link href={nextHref} className={buttonClass({ variant: "secondary", size: "sm" })}>
        Next page
        <Icon name="arrowRight" size={13} />
      </Link>
    </div>
  );
}

/** Reports names the queue could not show, without naming anyone. */
export function QueuePhiNotice({
  withheldCount,
  decryptErrorCount,
}: {
  readonly withheldCount: number;
  readonly decryptErrorCount: number;
}): ReactNode {
  if (withheldCount === 0 && decryptErrorCount === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-tone-warning/40 bg-tone-warning/10 px-3 py-2 text-xs">
      <Badge tone="warning">PHI</Badge>
      {withheldCount > 0 ? (
        <span>
          {withheldCount} patient name{withheldCount === 1 ? "" : "s"} hidden because the required
          access record could not be written. The orders are still listed and still workable.
        </span>
      ) : null}
      {decryptErrorCount > 0 ? (
        <span>
          {decryptErrorCount} patient name{decryptErrorCount === 1 ? "" : "s"} could not be
          decrypted. Open the order for detail.
        </span>
      ) : null}
    </div>
  );
}
