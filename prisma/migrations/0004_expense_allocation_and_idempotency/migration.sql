-- Issue #9: Expense recipient/holder attribution, draw float-offset split,
-- per-organization idempotency keys, CHECK constraints, and immutability trigger hardening.

-- 1. AlterTable shared.Expense
ALTER TABLE "shared"."Expense"
  ADD COLUMN "recipientUserId" UUID,
  ADD COLUMN "floatOffsetAppliedCadMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "custodyHolderUserId" UUID,
  ADD COLUMN "idempotencyKey" TEXT;

-- 2. AlterTable shared.CashCustodyTransfer
ALTER TABLE "shared"."CashCustodyTransfer"
  ADD COLUMN "custodyHolderUserId" UUID,
  ADD COLUMN "idempotencyKey" TEXT;

-- 3. Unique and Lookup Indexes
CREATE UNIQUE INDEX "Expense_organizationId_idempotencyKey_key"
  ON "shared"."Expense"("organizationId", "idempotencyKey");

CREATE INDEX "Expense_organizationId_loggedByUserId_receiptVerification_idx"
  ON "shared"."Expense"("organizationId", "loggedByUserId", "receiptVerificationState", "createdAt");

CREATE INDEX "Expense_organizationId_recipientUserId_idx"
  ON "shared"."Expense"("organizationId", "recipientUserId");

CREATE INDEX "Expense_organizationId_custodyHolderUserId_idx"
  ON "shared"."Expense"("organizationId", "custodyHolderUserId");

CREATE UNIQUE INDEX "CashCustodyTransfer_organizationId_idempotencyKey_key"
  ON "shared"."CashCustodyTransfer"("organizationId", "idempotencyKey");

CREATE INDEX "CashCustodyTransfer_organizationId_custodyHolderUserId_idx"
  ON "shared"."CashCustodyTransfer"("organizationId", "custodyHolderUserId");

-- 4. Composite Intra-Tenant Membership Foreign Keys
ALTER TABLE "shared"."Expense"
  ADD CONSTRAINT "Expense_organizationId_recipientUserId_fkey"
  FOREIGN KEY ("organizationId", "recipientUserId")
  REFERENCES "shared"."OrganizationMembership"("organizationId", "userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shared"."Expense"
  ADD CONSTRAINT "Expense_organizationId_custodyHolderUserId_fkey"
  FOREIGN KEY ("organizationId", "custodyHolderUserId")
  REFERENCES "shared"."OrganizationMembership"("organizationId", "userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shared"."CashCustodyTransfer"
  ADD CONSTRAINT "CashCustodyTransfer_organizationId_custodyHolderUserId_fkey"
  FOREIGN KEY ("organizationId", "custodyHolderUserId")
  REFERENCES "shared"."OrganizationMembership"("organizationId", "userId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Financial, Allocation, Compensation & Memo CHECK Constraints
ALTER TABLE "shared"."Expense"
  ADD CONSTRAINT "expense_amounts_and_draw_split_check" CHECK (
    "amountOriginalMinor" >= 0
    AND "amountCadMinor" >= 0
    AND "itcReceivableCadMinor" >= 0
    AND "itcReceivableCadMinor" <= "amountCadMinor"
    AND "floatOffsetAppliedCadMinor" >= 0
    AND "floatOffsetAppliedCadMinor" <= "amountCadMinor"
    AND (
      "itcReceivableCadMinor" = 0
      OR (
        "receiptVerificationState" = 'VERIFIED_RECEIPT'
        AND "receiptStorageKey" IS NOT NULL
        AND length(trim("receiptStorageKey")) > 0
      )
    )
    AND (
      "floatOffsetAppliedCadMinor" = 0
      OR "category" = 'PARTNER_PROFIT_DRAW'
    )
    AND (
      "category" <> 'PARTNER_PROFIT_DRAW'
      OR (
        "currencyOriginal" = 'CAD'
        AND "amountCadMinor" > 0
        AND "amountOriginalMinor" = "amountCadMinor"
        AND "itcReceivableCadMinor" = 0
        AND "recipientUserId" IS NOT NULL
        AND "isDeferredIntercompanyAccrual" = false
        AND "accrualSettledAt" IS NULL
      )
    )
    AND (
      "category" <> 'YARD_STRIPPER_PIECE_RATE'
      OR (
        "itcReceivableCadMinor" = 0
        AND "floatOffsetAppliedCadMinor" = 0
      )
    )
    AND (
      "category" <> 'PARTNER_TIME_LOG_MEMO'
      OR (
        "amountOriginalMinor" = 0
        AND "amountCadMinor" = 0
        AND "itcReceivableCadMinor" = 0
        AND "floatOffsetAppliedCadMinor" = 0
        AND "paidFromCashCustody" IS NULL
        AND "isDeferredIntercompanyAccrual" = false
        AND "accrualSettledAt" IS NULL
        AND "receiptVerificationState" = 'PENDING_RECEIPT_UPLOAD'
      )
    )
  );

-- 6. Harden Expense Immutability Trigger Function
CREATE OR REPLACE FUNCTION "shared"."prevent_expense_financial_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."vehicleId" IS DISTINCT FROM OLD."vehicleId"
     OR NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId"
     OR NEW."cannabisLotId" IS DISTINCT FROM OLD."cannabisLotId"
     OR NEW."loggedByUserId" IS DISTINCT FROM OLD."loggedByUserId"
     OR NEW."recipientUserId" IS DISTINCT FROM OLD."recipientUserId"
     OR NEW."floatOffsetAppliedCadMinor" IS DISTINCT FROM OLD."floatOffsetAppliedCadMinor"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."category" IS DISTINCT FROM OLD."category"
     OR NEW."amountOriginalMinor" IS DISTINCT FROM OLD."amountOriginalMinor"
     OR NEW."currencyOriginal" IS DISTINCT FROM OLD."currencyOriginal"
     OR NEW."amountCadMinor" IS DISTINCT FROM OLD."amountCadMinor"
     OR NEW."isDeferredIntercompanyAccrual" IS DISTINCT FROM OLD."isDeferredIntercompanyAccrual"
     OR NEW."isReversalEntry" IS DISTINCT FROM OLD."isReversalEntry"
     OR NEW."reversesExpenseId" IS DISTINCT FROM OLD."reversesExpenseId"
     OR NEW."incurredAt" IS DISTINCT FROM OLD."incurredAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."isDeferredIntercompanyAccrual" = false AND NEW."accrualSettledAt" IS NOT NULL)
     OR (OLD."accrualSettledAt" IS NOT NULL AND NEW."accrualSettledAt" IS DISTINCT FROM OLD."accrualSettledAt")
     OR (
       NEW."paidFromCashCustody" IS DISTINCT FROM OLD."paidFromCashCustody"
       AND NOT (
         OLD."isDeferredIntercompanyAccrual" = true
         AND OLD."accrualSettledAt" IS NULL
         AND NEW."accrualSettledAt" IS NOT NULL
         AND NEW."paidFromCashCustody" IS NOT NULL
       )
     )
     OR (
       NEW."custodyHolderUserId" IS DISTINCT FROM OLD."custodyHolderUserId"
       AND NOT (
         OLD."isDeferredIntercompanyAccrual" = true
         AND OLD."accrualSettledAt" IS NULL
         AND NEW."accrualSettledAt" IS NOT NULL
         AND OLD."custodyHolderUserId" IS NULL
         AND NEW."paidFromCashCustody" = 'HELD_IN_OPERATOR_FLOAT'
         AND NEW."custodyHolderUserId" IS NOT NULL
       )
     )
     OR (
       (
         OLD."receiptStorageKey" IS NOT NULL
         OR OLD."receiptVerificationState" <> 'PENDING_RECEIPT_UPLOAD'
         OR OLD."category" = 'PARTNER_TIME_LOG_MEMO'
       )
       AND (
         NEW."receiptVerificationState" IS DISTINCT FROM OLD."receiptVerificationState"
         OR NEW."itcReceivableCadMinor" IS DISTINCT FROM OLD."itcReceivableCadMinor"
         OR NEW."receiptStorageKey" IS DISTINCT FROM OLD."receiptStorageKey"
         OR NEW."receiptSha256Hash" IS DISTINCT FROM OLD."receiptSha256Hash"
       )
     )
     OR (
       OLD."receiptVerificationState" = 'PENDING_RECEIPT_UPLOAD'
       AND OLD."receiptStorageKey" IS NULL
       AND (
         (
           NEW."receiptStorageKey" IS NOT NULL
           AND NEW."receiptVerificationState" <> 'VERIFIED_RECEIPT'
         )
         OR (
           NEW."receiptStorageKey" IS NULL
           AND (
             NEW."receiptVerificationState" IS DISTINCT FROM OLD."receiptVerificationState"
             OR NEW."itcReceivableCadMinor" IS DISTINCT FROM OLD."itcReceivableCadMinor"
           )
         )
       )
     ) THEN
    RAISE EXCEPTION 'Immutable financial columns on Expense cannot be modified after creation; log a reversal entry instead.';
  END IF;
  RETURN NEW;
END;
$$;
