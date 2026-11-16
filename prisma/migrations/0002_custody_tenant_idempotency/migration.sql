-- Issue #6: Scope CustodyEvent idempotencyKey uniqueness per organizationId (NFR-IDEM-01)
-- Build the composite tenant-scoped unique index before dropping the global index so
-- uniqueness remains continuously enforced across existing rows.

-- CreateIndex
CREATE UNIQUE INDEX "CustodyEvent_organizationId_idempotencyKey_key" ON "shared"."CustodyEvent"("organizationId", "idempotencyKey");

-- DropIndex
DROP INDEX "shared"."CustodyEvent_idempotencyKey_key";
