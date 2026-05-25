// Time-of-day source.
//
// Every domain component that needs "now" MUST take a `Clock` rather
// than calling `new Date()` or `Date.now()` directly. The reasons are
// not stylistic:
//
//   - SLA interval recording fans out from a single workflow event.
//     If two writes within the same command call `new Date()` twice,
//     they get DIFFERENT instants and the resulting interval rows
//     drift by microseconds. Tests catch this immediately when the
//     clock is injectable.
//
//   - Backoff / retry math has off-by-one bugs that only appear under
//     time pressure. With a `FrozenClock` or `AdvancingClock` the
//     tests can simulate "exactly at the boundary" precisely.
//
//   - Audit logs require monotonic-within-a-command timestamps. The
//     production `SystemClock` returns `new Date()` per call (Node's
//     monotonic guarantee is sufficient at millisecond resolution),
//     but the bus may also pin a single `commandStartedAt` and reuse
//     it across all writes in the transaction.
//
// Implementations MUST return UTC Dates. Time-zone display is a
// presentation concern handled at the route boundary.

export interface Clock {
  now(): Date;
}
