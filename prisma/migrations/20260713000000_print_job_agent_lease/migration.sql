-- Print-agent claim lease for print_job.
--
-- The agent's claim used FOR UPDATE SKIP LOCKED but never marked
-- the row as claimed, so the row lock evaporated at the end of the
-- claim transaction while the job stayed SENT. Two print-agent
-- processes polling the same workstation could each claim the same
-- job on consecutive ticks and print duplicate vial labels — a
-- patient-safety hazard when the duplicate lands on the wrong vial.
--
-- `agentLeasedUntil` mirrors the event_outbox lease pattern: the
-- claim sets it to now() + lease window inside the claim UPDATE,
-- making the row invisible to other agents until the lease expires
-- (crash recovery) or the job reaches a terminal status.

ALTER TABLE "print_job" ADD COLUMN "agentLeasedUntil" TIMESTAMP(3);
