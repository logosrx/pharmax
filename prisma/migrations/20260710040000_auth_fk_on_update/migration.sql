-- Reconcile the phase-6 auth tables' userId foreign keys with the
-- Prisma schema.
--
-- The phase6_auth_engine migration created the userId FKs as
-- `ON DELETE CASCADE` with no ON UPDATE clause (Postgres default:
-- NO ACTION). Prisma's canonical rendering of the schema's
-- `onDelete: Cascade` relations is `ON DELETE CASCADE ON UPDATE
-- CASCADE`, so `prisma migrate diff` reported the migration
-- history as drifted from schema.prisma ("[-] Removed / [+] Added
-- foreign key on columns (userId)"). Recreate each FK with the
-- canonical clauses. Done as a follow-up migration (not an edit of
-- the original file) so databases that already applied
-- phase6_auth_engine don't hit a migration-checksum mismatch.

ALTER TABLE "auth_session"
  DROP CONSTRAINT "auth_session_userId_fkey",
  ADD CONSTRAINT "auth_session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mfa_enrollment"
  DROP CONSTRAINT "mfa_enrollment_userId_fkey",
  ADD CONSTRAINT "mfa_enrollment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recovery_code"
  DROP CONSTRAINT "recovery_code_userId_fkey",
  ADD CONSTRAINT "recovery_code_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_history"
  DROP CONSTRAINT "password_history_userId_fkey",
  ADD CONSTRAINT "password_history_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_reset_token"
  DROP CONSTRAINT "password_reset_token_userId_fkey",
  ADD CONSTRAINT "password_reset_token_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
