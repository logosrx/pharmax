-- migration: 20260620000000_phase5_package_photo_archive
--
-- Add the archive disposition to package_photo so a capture that
-- will NEVER match an order (packing-station test shot, duplicate
-- retake, wrong-photo misclick, or a genuine capture whose order was
-- cancelled) can be dispositioned out of the triage bucket and the
-- order timeline instead of dangling forever.
--
-- Soft delete, not hard delete: the row is RETAINED as an audit
-- anchor (it proves "operator X archived this capture for reason Y
-- at time T"). Every read surface filters on `archivedAt IS NULL`.
-- The S3 object the row points at is left in place — byte
-- reclamation for archived captures is a separate concern (the
-- orphan sweep won't touch it because `package_photo.storageKey`
-- still references it).
--
-- ArchivePackagePhoto (the only writer of these columns) is gated on
-- the new `ship.archive_package_photo` permission and emits
-- `shipping.package_photo.archived.v1`.
--
-- No RLS change: the package_photo table already has RLS ENABLE +
-- FORCE + the tenant_isolation policy from the original
-- 20260606000000_phase5_package_photo migration; new columns inherit
-- it automatically.

-- 1. Disposition reason enum.
CREATE TYPE "PackagePhotoArchiveReason" AS ENUM (
    -- Packing-station test shot — not a real shipment.
    'TEST_CAPTURE',
    -- The same package was already captured (operator retake / dupe).
    'DUPLICATE',
    -- Wrong photo / misclick / not actually a package.
    'CAPTURED_IN_ERROR',
    -- Genuine capture that will never match an order (cancelled order,
    -- one-off external number). Clears it from the triage bucket.
    'UNRESOLVABLE'
);

-- 2. Archive columns. All nullable: an unarchived row has
--    archivedAt IS NULL. The trio is written together by the command.
ALTER TABLE "package_photo"
    ADD COLUMN "archivedAt" TIMESTAMP(3),
    ADD COLUMN "archiveReason" "PackagePhotoArchiveReason",
    ADD COLUMN "archivedByUserId" UUID;

-- 3. FK on the archiving user. ON DELETE RESTRICT — same audit-anchor
--    reasoning as capturedByUserId: a user who archived a photo
--    cannot be hard-deleted without first dealing with the photo.
ALTER TABLE "package_photo" ADD CONSTRAINT "package_photo_archivedByUserId_fkey"
    FOREIGN KEY ("archivedByUserId") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
