-- migration: 20260609000000_phase3_stage_interval_exception_kinds
--
-- Extend OrderStageIntervalKind with the three exception kinds the
-- non-primary workflow commands need to ship their SLA semantics:
--
--   - HOLD_ACTIVE              — PlaceHold opens, ReleaseHold closes.
--                                The active interval kind for the
--                                "order is paused" stage. Reporting
--                                excludes HOLD_ACTIVE from per-stage
--                                breach windows (a held order is
--                                NOT eating its PV1 / fill / final
--                                budget while paused).
--
--   - WAIT_AFTER_PV1_REJECT    — RejectPV1 opens (closing PV1_ACTIVE
--                                in the same transition). ReopenForCorrection
--                                closes (opening the next-stage
--                                interval per `reopenToState`).
--                                Disentangles rework cost from
--                                first-pass pharmacist time on
--                                productivity reports.
--
--   - WAIT_AFTER_FINAL_REJECT  — symmetric: RejectFinalVerification
--                                opens, ReopenForCorrection closes.
--
-- PostgreSQL note: `ALTER TYPE … ADD VALUE` cannot be used in the
-- same transaction as queries that reference the new value, so this
-- migration only adds the values. The recorder code that closes /
-- opens these kinds ships in the same release but executes against
-- the already-committed enum.

ALTER TYPE "OrderStageIntervalKind" ADD VALUE 'HOLD_ACTIVE';
ALTER TYPE "OrderStageIntervalKind" ADD VALUE 'WAIT_AFTER_PV1_REJECT';
ALTER TYPE "OrderStageIntervalKind" ADD VALUE 'WAIT_AFTER_FINAL_REJECT';
