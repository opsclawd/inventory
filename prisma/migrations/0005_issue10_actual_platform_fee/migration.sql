-- Issue #10: Additive nullable SaleTransaction.actualPlatformFeeMinor with
-- initial-null, non-negative, eBay bank-settlement-only, and once-set immutability enforcement.

-- 1. Add nullable actualPlatformFeeMinor column (existing rows default to NULL -> fallback to platformFeeMinor)
ALTER TABLE "salvage"."SaleTransaction"
  ADD COLUMN "actualPlatformFeeMinor" INTEGER;

-- 2. Enforce non-negative, non-reversal, domestic eBay-only, settled/terminal state CHECK
ALTER TABLE "salvage"."SaleTransaction"
  ADD CONSTRAINT "sale_actual_platform_fee_check" CHECK (
    "actualPlatformFeeMinor" IS NULL
    OR (
      "actualPlatformFeeMinor" >= 0
      AND "reversesSaleTxId" IS NULL
      AND "marketNode" = 'DOMESTIC_ORIGIN'
      AND "domesticChannel" = 'EBAY_MOTORS_SHIPPED'
      AND "paymentSettlementState" IN ('BANK_SETTLEMENT_CONFIRMED', 'REFUNDED_OR_CHARGED_BACK')
    )
  );

-- 3. Harden SaleTransaction financial immutability trigger to enforce once-set actualPlatformFeeMinor
CREATE OR REPLACE FUNCTION "salvage"."prevent_sale_tx_financial_mutation"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."receiptNumber" IS DISTINCT FROM OLD."receiptNumber"
     OR NEW."marketNode" IS DISTINCT FROM OLD."marketNode"
     OR NEW."domesticChannel" IS DISTINCT FROM OLD."domesticChannel"
     OR NEW."exportChannel" IS DISTINCT FROM OLD."exportChannel"
     OR NEW."paymentCurrency" IS DISTINCT FROM OLD."paymentCurrency"
     OR NEW."subtotalMinor" IS DISTINCT FROM OLD."subtotalMinor"
     OR NEW."discountAmountMinor" IS DISTINCT FROM OLD."discountAmountMinor"
     OR NEW."platformFeeMinor" IS DISTINCT FROM OLD."platformFeeMinor"
     OR NEW."shippingCostMinor" IS DISTINCT FROM OLD."shippingCostMinor"
     OR NEW."grossCollectedMinor" IS DISTINCT FROM OLD."grossCollectedMinor"
     OR NEW."taxCollectionMode" IS DISTINCT FROM OLD."taxCollectionMode"
     OR NEW."appliedTaxJurisdiction" IS DISTINCT FROM OLD."appliedTaxJurisdiction"
     OR NEW."appliedTaxRateBps" IS DISTINCT FROM OLD."appliedTaxRateBps"
     OR NEW."taxOrVatMinor" IS DISTINCT FROM OLD."taxOrVatMinor"
     OR (OLD."buyerTaxRemittedByPlatformMinor" IS NOT NULL AND NEW."buyerTaxRemittedByPlatformMinor" IS DISTINCT FROM OLD."buyerTaxRemittedByPlatformMinor")
     OR NEW."estimatedPlatformFeeTaxCadMinor" IS DISTINCT FROM OLD."estimatedPlatformFeeTaxCadMinor"
     OR (OLD."isFeeTaxInvoiceVerified" = true AND (
          NEW."isFeeTaxInvoiceVerified" = false
          OR NEW."itcReceivableCadMinor" IS DISTINCT FROM OLD."itcReceivableCadMinor"
          OR NEW."feeTaxInvoiceStorageKey" IS DISTINCT FROM OLD."feeTaxInvoiceStorageKey"
        ))
     OR NEW."netRealizedCadMinor" IS DISTINCT FROM OLD."netRealizedCadMinor"
     OR NEW."paymentProofStorageKey" IS DISTINCT FROM OLD."paymentProofStorageKey"
     OR NEW."reversesSaleTxId" IS DISTINCT FROM OLD."reversesSaleTxId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."isVoidedOrReversed" = true AND (
          NEW."isVoidedOrReversed" = false
          OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"
        ))
     OR (OLD."actualPlatformFeeMinor" IS NOT NULL AND NEW."actualPlatformFeeMinor" IS DISTINCT FROM OLD."actualPlatformFeeMinor")
     OR (
       OLD."actualPlatformFeeMinor" IS NULL
       AND NEW."actualPlatformFeeMinor" IS NOT NULL
       AND NOT (
         OLD."reversesSaleTxId" IS NULL
         AND OLD."marketNode" = 'DOMESTIC_ORIGIN'
         AND OLD."domesticChannel" = 'EBAY_MOTORS_SHIPPED'
         AND OLD."isVoidedOrReversed" = false
         AND OLD."paymentSettlementState" IN ('MARKETPLACE_PAYOUT_PENDING', 'BANK_SETTLEMENT_PENDING')
         AND NEW."paymentSettlementState" = 'BANK_SETTLEMENT_CONFIRMED'
         AND NEW."cashCustodyState" = 'SETTLED_ORIGIN_CORP_BANK'
         AND NEW."isVoidedOrReversed" = false
         AND NEW."actualPlatformFeeMinor" >= 0
       )
     ) THEN
    RAISE EXCEPTION 'Immutable financial or tax columns on SaleTransaction cannot be modified after creation.';
  END IF;
  RETURN NEW;
END;
$$;

-- 4. Enforce initial NULL actualPlatformFeeMinor on INSERT while preserving all settlement transition checks
CREATE OR REPLACE FUNCTION "salvage"."enforce_sale_settlement_transition"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_allowed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."actualPlatformFeeMinor" IS NOT NULL THEN
      RAISE EXCEPTION 'New SaleTransaction must start with actualPlatformFeeMinor = NULL';
    END IF;
    IF NEW."paymentSettlementState" = 'REFUNDED_OR_CHARGED_BACK' THEN
      RAISE EXCEPTION 'New SaleTransaction cannot start in terminal REFUNDED_OR_CHARGED_BACK state';
    END IF;
    IF NEW."paymentSettlementState" = 'BANK_SETTLEMENT_CONFIRMED'
       AND NEW."paymentMethod" <> 'VERIFIED_BANK_WIRE' THEN
      RAISE EXCEPTION 'New SaleTransaction can only start in BANK_SETTLEMENT_CONFIRMED with paymentMethod VERIFIED_BANK_WIRE';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."paymentSettlementState" IS DISTINCT FROM OLD."paymentSettlementState" THEN
    IF OLD."paymentSettlementState" = 'REFUNDED_OR_CHARGED_BACK' THEN
      RAISE EXCEPTION 'Terminal REFUNDED_OR_CHARGED_BACK SaleTransaction cannot transition to %', NEW."paymentSettlementState";
    END IF;

    IF NEW."paymentSettlementState" = 'REFUNDED_OR_CHARGED_BACK' THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" = 'SALE_RECORDED'
          AND NEW."paymentSettlementState" IN ('PAYMENT_INITIATED', 'MARKETPLACE_PAYOUT_PENDING') THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" = 'PAYMENT_INITIATED'
          AND NEW."paymentSettlementState" IN ('PAYMENT_CONFIRMED', 'BANK_SETTLEMENT_PENDING') THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" = 'MARKETPLACE_PAYOUT_PENDING'
          AND NEW."paymentSettlementState" IN ('BANK_SETTLEMENT_PENDING', 'BANK_SETTLEMENT_CONFIRMED') THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" = 'BANK_SETTLEMENT_PENDING'
          AND NEW."paymentSettlementState" = 'BANK_SETTLEMENT_CONFIRMED' THEN
      v_allowed := true;
    ELSIF OLD."paymentSettlementState" <> 'REFUNDED_OR_CHARGED_BACK'
          AND NEW."paymentSettlementState" = 'BANK_SETTLEMENT_CONFIRMED'
          AND NEW."paymentMethod" = 'VERIFIED_BANK_WIRE'
          AND (
            OLD."paymentSettlementState" IN ('SALE_RECORDED', 'PAYMENT_INITIATED')
            OR OLD."paymentMethod" = 'VERIFIED_BANK_WIRE'
          ) THEN
      v_allowed := true;
    END IF;

    IF NOT v_allowed THEN
      RAISE EXCEPTION 'Illegal PaymentSettlementState transition from % to % (paymentMethod=%)',
        OLD."paymentSettlementState", NEW."paymentSettlementState", NEW."paymentMethod";
    END IF;
  END IF;

  -- If transaction is voided/reversed/refunded, automatically release active lock on child line items
  IF NEW."isVoidedOrReversed" = true AND OLD."isVoidedOrReversed" = false THEN
    UPDATE "salvage"."SaleTransactionPartItem"
       SET "isActiveSale" = false
     WHERE "organizationId" = NEW."organizationId"
       AND "saleTransactionId" = NEW."id";
    UPDATE "salvage"."SaleTransactionVehicleItem"
       SET "isActiveSale" = false
     WHERE "organizationId" = NEW."organizationId"
       AND "saleTransactionId" = NEW."id";
  END IF;

  RETURN NEW;
END;
$$;
