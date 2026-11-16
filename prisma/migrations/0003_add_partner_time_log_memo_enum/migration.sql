-- Issue #9: Add PARTNER_TIME_LOG_MEMO enum value in a dedicated migration
-- so subsequent CHECK constraints can reference it after PostgreSQL commits the new value.

ALTER TYPE "shared"."ExpenseCategory" ADD VALUE IF NOT EXISTS 'PARTNER_TIME_LOG_MEMO';
