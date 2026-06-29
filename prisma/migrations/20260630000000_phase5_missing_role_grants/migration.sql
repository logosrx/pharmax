-- Grant runtime-role table privileges missing from five Phase-5
-- migrations.
--
-- The RLS baseline (20260522060000) grants privileges PER TABLE — no
-- ALTER DEFAULT PRIVILEGES — so every migration that creates a table
-- must GRANT to `pharmax_app` / `pharmax_system` explicitly (the
-- repo-wide convention, see e.g. 20260601000000_phase4_carrier_credential).
-- Five Phase-5 migrations created tables WITHOUT any grants:
--
--   * report_run             (20260614000000)
--   * access_review_snapshot (20260615000000)
--   * report_schedule        (20260615000000)
--   * notification_delivery  (20260618000000)
--   * resend_webhook_event   (20260618000000)
--
-- Consequence: BOTH runtime roles got `permission denied` (42501) on
-- these tables. Note that BYPASSRLS does NOT bypass table privileges,
-- so the worker's `pharmax_system` role was equally locked out — the
-- report scheduler, the Resend notification store, and the access-
-- review snapshot writer would all fail at the GRANT layer in any
-- environment using the production roles. Fail closed (availability),
-- not a leak. Discovered by the live-DB integration suite
-- (packages/integration-tests/src/rls-system-context-sentinel.test.ts).
--
-- Privilege levels follow the observed write patterns and the
-- existing conventions:
--
--   * notification_delivery / resend_webhook_event / report_schedule:
--     SELECT, INSERT, UPDATE — status-transition ledgers, like
--     stripe_webhook_event (no DELETE; rows are never removed by
--     runtime code).
--   * report_run / access_review_snapshot: SELECT, INSERT only —
--     append-only evidence records, like verification_record. No
--     runtime code updates or deletes them, and withholding UPDATE/
--     DELETE makes immutability a database guarantee.

GRANT SELECT, INSERT, UPDATE ON TABLE "notification_delivery"
  TO pharmax_app, pharmax_system;

GRANT SELECT, INSERT, UPDATE ON TABLE "resend_webhook_event"
  TO pharmax_app, pharmax_system;

GRANT SELECT, INSERT, UPDATE ON TABLE "report_schedule"
  TO pharmax_app, pharmax_system;

GRANT SELECT, INSERT ON TABLE "report_run"
  TO pharmax_app, pharmax_system;

GRANT SELECT, INSERT ON TABLE "access_review_snapshot"
  TO pharmax_app, pharmax_system;
