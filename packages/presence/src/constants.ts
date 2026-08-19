// Timing constants for the operator presence layer.
//
// These three numbers are related and should be changed together;
// the relationships are stated here rather than left implicit
// because getting them wrong degrades quietly (the idle report keeps
// producing plausible-looking numbers) rather than failing loudly.

/**
 * Width of a presence slot. One `operator_presence_slot` row covers
 * one slot per operator, however many heartbeats land inside it.
 *
 * This is the knob that trades storage against idle resolution. At 5
 * minutes an 8-hour shift is at most 96 rows per operator rather than
 * the 480 an append-per-beat log would write at
 * `HEARTBEAT_INTERVAL_MS`, and idle is resolved to the nearest slot
 * boundary — which is the right granularity for a report measuring
 * shift-scale idle time, not keystroke-scale gaps.
 */
export const PRESENCE_SLOT_MS = 5 * 60_000;

/**
 * Cadence a client should beat at. Deliberately several times
 * smaller than `PRESENCE_SLOT_MS` so a slot survives a dropped beat:
 * at 60s a slot expects five beats and needs only one.
 *
 * Nothing enforces this on the server, and nothing needs to — the
 * slot upsert is idempotent, so a client that beats faster writes the
 * same row more often instead of writing more rows.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How long an operator can go without recording any application
 * activity, while still present, before that stretch counts as idle.
 *
 * Set to one slot width. Shorter and the report counts ordinary
 * think-time between two order screens as idle; much longer and a
 * genuine break disappears into the noise. `deriveIdleTime` takes
 * this as a parameter so a report can override it.
 */
export const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60_000;

/**
 * Default retention for both telemetry tables, in days.
 *
 * These rows are operational telemetry, NOT audit evidence — the
 * seven-year `audit_log` retention does not apply and should not be
 * inherited by accident. 90 days covers a quarterly staffing review,
 * which is the longest window the consuming reports are built for.
 * The worker prune loop reads its own env-configured value; this is
 * the documented default the two agree on.
 */
export const DEFAULT_TELEMETRY_RETENTION_DAYS = 90;
