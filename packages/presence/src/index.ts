// Public surface of @pharmax/presence.
//
// Operator presence + application-activity telemetry: the ingest path
// for the signals in `.cursor/rules/03-sla-performance.mdc` that no
// other table records, and the derivation the idle-time report reads.
//
// This package is INFRASTRUCTURE, not a business domain — it does not
// appear in `DOMAIN_PACKAGES` in scripts/check-package-layers.ts — so
// any domain may call it to record that work happened. It depends
// only on database, tenancy, and platform-core, and deliberately not
// on @pharmax/scan: taking a pre-classified scan kind rather than a
// raw barcode means no code path in this package ever holds a
// scanned value.

export {
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_TELEMETRY_RETENTION_DAYS,
  HEARTBEAT_INTERVAL_MS,
  PRESENCE_SLOT_MS,
} from "./constants.js";

export { presenceSlotStart } from "./slot.js";

export {
  recordHeartbeat,
  type PresenceSlotClient,
  type RecordHeartbeatOptions,
  type RecordHeartbeatResult,
} from "./record-heartbeat.js";

export {
  ACTIVITY_SCAN_DETAIL_REQUIRED,
  ACTIVITY_SCAN_DETAIL_UNEXPECTED,
  recordActivityEvent,
  type ActivityEventClient,
  type RecordActivityEventInput,
  type RecordActivityEventOptions,
  type RecordActivityEventResult,
} from "./record-activity-event.js";

export {
  buildPresenceSpans,
  deriveIdleTime,
  type DeriveIdleTimeResult,
  type IdleWindow,
  type PresenceSlotInput,
  type PresenceSpan,
} from "./derive-idle.js";
