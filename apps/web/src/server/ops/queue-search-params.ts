// Read queue filters and the page cursor out of the URL.
//
// Six queue pages take the same five filters, so parsing lives here
// rather than being retyped per page — and more to the point, so the
// validation does. An unrecognised `priority` has to become "no
// priority filter" rather than reaching Prisma as an invalid enum
// value, and a `clinicId` that is not a UUID has to be dropped rather
// than sent as a predicate that throws.
//
// Filters are NOT a security boundary. Tenant isolation comes from
// `readInOrgScope` plus the explicit `organizationId` predicate; a
// `clinicId` from the URL only narrows within the operator's own
// organization, and a clinic id belonging to another tenant simply
// matches nothing. Operators see every client by design — the pharmacy
// is the one processing the work.

import "server-only";

import { OrderPriority } from "@pharmax/database";

import { type QueueFilters } from "./list-orders-in-bucket.js";

export type QueueSearchParams = Record<string, string | string[] | undefined>;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(params: QueueSearchParams, key: string): string | undefined {
  const raw = params[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function uuid(params: QueueSearchParams, key: string): string | undefined {
  const value = one(params, key);
  return value !== undefined && UUID_SHAPE.test(value) ? value : undefined;
}

const PRIORITIES = new Set<string>(Object.values(OrderPriority));

export function parseQueueFilters(params: QueueSearchParams): QueueFilters {
  const clinicId = uuid(params, "clinicId");
  const siteId = uuid(params, "siteId");
  const priorityRaw = one(params, "priority");
  const priority =
    priorityRaw !== undefined && PRIORITIES.has(priorityRaw)
      ? (priorityRaw as OrderPriority)
      : undefined;

  return Object.freeze({
    ...(clinicId === undefined ? {} : { clinicId }),
    ...(siteId === undefined ? {} : { siteId }),
    ...(priority === undefined ? {} : { priority }),
    ...(one(params, "breached") === "1" ? { breachedOnly: true } : {}),
    ...(one(params, "unclaimed") === "1" ? { unclaimedOnly: true } : {}),
  });
}

/**
 * The page cursor. Namespaced by bucket code so a page rendering two
 * lists can page one without resetting the other.
 */
export function parseQueueCursor(
  params: QueueSearchParams,
  bucketCode?: string
): string | undefined {
  return uuid(params, bucketCode === undefined ? "cursor" : `cursor_${bucketCode}`);
}

export function hasAnyQueueFilter(filters: QueueFilters): boolean {
  return Object.keys(filters).length > 0;
}

/**
 * Build a URL for this queue preserving the current filters and
 * changing only what is passed. Cursors are dropped on any filter
 * change, because a cursor from a differently-filtered result set
 * points into a sequence that no longer exists.
 */
export function buildQueueHref(input: {
  readonly basePath: string;
  readonly filters: QueueFilters;
  readonly override?: Readonly<Record<string, string | undefined>>;
  /** Cursors to carry forward, keyed by the query param name. */
  readonly cursors?: Readonly<Record<string, string | undefined>>;
}): string {
  const search = new URLSearchParams();
  const f = input.filters;
  if (f.clinicId !== undefined) search.set("clinicId", f.clinicId);
  if (f.siteId !== undefined) search.set("siteId", f.siteId);
  if (f.priority !== undefined) search.set("priority", f.priority);
  if (f.breachedOnly === true) search.set("breached", "1");
  if (f.unclaimedOnly === true) search.set("unclaimed", "1");

  for (const [key, value] of Object.entries(input.cursors ?? {})) {
    if (value !== undefined) search.set(key, value);
  }

  for (const [key, value] of Object.entries(input.override ?? {})) {
    if (value === undefined) search.delete(key);
    else search.set(key, value);
  }

  const qs = search.toString();
  return qs.length === 0 ? input.basePath : `${input.basePath}?${qs}`;
}
