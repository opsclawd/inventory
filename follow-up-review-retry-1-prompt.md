You are performing a follow-up review of code changes made in response to earlier review findings.

## CONTEXT

## WORKSPACE CONSTRAINTS

Your working directory is a dedicated git worktree with the repository's complete history. Run all commands from it. Do NOT cd to or read paths outside this directory — external-directory access is automatically rejected. git log, git diff, etc. work here directly.

.ai-orchestrator.local.json, if one exists, lives only in the main checkout and is intentionally not copied into your worktree — it is operator-machine-specific and not part of your task. Do not search for it or read it outside this directory. Reason about configuration using only .ai-orchestrator.json in your own working directory; treat it as the effective config for your task.

Working directory: /home/gary/.openclaw/workspace/inventory/.ai-worktrees/issue-9
Issue number: 9

Issue description & acceptance criteria:
# Issue 09: Shared Tiered Receipt/Voucher Expense Logger, ITA s. 78(1) Deferred Accruals & Operator Float Subledger (FR-EXP-01)

Blocked by: #3, #5, #7, #8

## 1. Context & Spec References
* **`ARCHITECTURE.md`:**
  * Section 4 (`Expense` with `organizationId`, composite `[organizationId, vehicleId]` & `[organizationId, shipmentId]` FKs, `itcReceivableCadMinor`, `ReceiptVerificationState`, `voucherReason`, `isDeferredIntercompanyAccrual`, `accrualSettledAt`, `CashCustodyTransfer`, `SaleTransaction` with `PaymentSettlementState`, `CashCustodyState.PENDING_EXTERNAL_RECEIVABLE`, `TaxCollectionMode`, `taxOrVatMinor`, `buyerTaxRemittedByPlatformMinor`, `estimatedPlatformFeeTaxCadMinor`, `isFeeTaxInvoiceVerified`, `feeTaxInvoiceStorageKey`, `itcReceivableCadMinor`, and `tx.$queryRaw` `withTenantTransaction`).
  * Section 5.1, 5.3 & 5.5 (*`PaymentSettlementState` Liquidity Separation [`FIX 05`], Jurisdiction-Aware CRA GST/HST & eBay Canada Billing Agent Rule `RULE-TAX-HST-01` [`FIX 06`], `netHstTrustLiability = max(0, directTaxCollectedNetOfRefunds - verifiedItcReceivable)`, and `ORG_SALVAGE_EXPORT` Liquidity-Backed 3-Rule Compensation Protocol*), `docs/adr/0003` through `docs/adr/0006-identity-rls-settlement-liquidity-jurisdiction-tax-and-run-finalization.md`.
* **`PRD.md` & `DOMAIN-RULES.md`:**
  * `PRD.md` Section 3 Module C **`FR-EXP-01`** (*Tiered Receipt/Voucher Expense Subledger, Verified ITCs `itcReceivableCadMinor`, Generic `ITA s. 78(1)` Deferred Accruals*) & **`FR-EXP-02`**, Section 6 **`NFR-SEC-01`**, **`NFR-SEC-02`**, **`NFR-RET-01`**, **`NFR-CI-01`**, **`NFR-IDEM-01`**, **`NFR-ACC-01`**.
  * `DOMAIN-RULES.md` Section 4.1, 4.3 & 4.5 (**7 Separated Financial & Liquidity Metrics [`FIX 05`]**, 3-Tranche `$22k/$12k/$10k` Working Capital Pool, **Jurisdiction-Aware `RULE-TAX-HST-01` & Verified vs. Estimated Seller-Fee ITCs [`ETA s. 169(4)`, `FIX 06`]**, generic `ITA s. 78(1)` Deferred Accrual cash exclusion, Operator Float `HELD_IN_OPERATOR_FLOAT`, and `RULE-PAY-001`–`003`).

## 2. In-Scope Files & Deliverables (7 files)
1. `src/modules/shared-ops/expenses/log-expense.use-case.ts` — Implements `organizationId`-scoped `Expense` logging (`FR-EXP-01` & `FR-EXP-02`) inside `withTenantTransaction` (`toTenantExecutionContext(session)` requiring `OrganizationMembership.isActive === true`):
   * **`VERIFIED_RECEIPT` (Default for Expenses $> \$50\text{ CAD}$) & Verified Recoverable ITC Capture (`ADR-0005` & `ADR-0006` `FIX 06`):** Requires non-empty `receiptStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET` (`422 RECEIPT_REQUIRED`) and records `itcReceivableCadMinor` **if and only if** `policy.domesticTaxPolicy.isGstHstRegistered === true` (forcing `itcReceivableCadMinor = 0` when `isGstHstRegistered === false` or when receipt state is not `VERIFIED_RECEIPT`).
   * **`PETTY_CASH_VOUCHER` (Under-$\$50\text{ CAD}$ Pressure-Relief Valve):** Permitted when `amountCadMinor <= 5000` with `voucherReason` ($\ge 5\text{ chars}$, `itcReceivableCadMinor = 0`), subject to rolling 30-day `$250/mo` cap unless `ARCHITECT_CFO` `cfoOverride`.
   * **`PENDING_RECEIPT_UPLOAD` (Temporary Float Liability Hold):** Transitions to `VERIFIED_RECEIPT` (allowing `itcReceivableCadMinor` verification on attachment) via `attachExpenseReceipt(session, expenseId, receiptStorageKey, itcReceivableCadMinor?)`.
   * **Generic Deferred Non-Arm's-Length Lease Accrual (`ITA s. 78(1)` — `isDeferredIntercompanyAccrual` & `settleDeferredAccrual`):** Excludes unsettled accruals (`accrualSettledAt == null`, zero hardcoded counterparty names) from liquid `ConfirmedCorpBankCash_CAD` / `AvailableWorkingCapital_CAD` drain until settled.
   * **Liquidity-Backed Compensation (`RULE-PAY-001`–`003` & `FIX 05`):** Enforces `YARD_STRIPPER_PIECE_RATE`, `PARTNER_TIME_LOG_MEMO` (`0` cash impact), and **`PARTNER_PROFIT_DRAW`** (strictly excluding `MARKETPLACE_PAYOUT_PENDING` and `BANK_SETTLEMENT_PENDING` receivables from `DistributableRealizedProfitPool_CAD`, auto-offsetting `RunningOperatorFloat_CAD`, and capping bank cash disbursement at `max(0, AvailableWorkingCapital_CAD - minCashReserveFloorCadMinor)` unless `1-Tap cfoOverride`).
2. `src/modules/shared-ops/expenses/record-cash-custody-transfer.use-case.ts` — Executes inside `withTenantTransaction` to record receipt-backed (`depositSlipStorageKey` in `R2_PRIVATE_EVIDENCE_BUCKET`) `CashCustodyTransfer` sweeps (`HELD_IN_OPERATOR_FLOAT -> SETTLED_ORIGIN_CORP_BANK` or `HELD_IN_DESTINATION_VAULT -> DEPOSITED_DESTINATION_BANK`), moving swept cash from `RunningOperatorFloat_CAD` into `ConfirmedCorpBankCash_CAD` & `AvailableWorkingCapital_CAD`.
3. `src/modules/shared-ops/expenses/operator-float-subledger.query.ts` — Executes inside `withTenantTransaction` to compute strictly `organizationId`-scoped live balances across all **7 Separated Financial & Liquidity Metrics (`FIX 05`)** and **Tax/ITC Counters (`FIX 06`)**:
   * **(1) `accountingRevenueCadMinor`** (pre-tax `subtotalMinor` of non-voided sales minus refunded subtotals),
   * **(2) `grossSaleValueCadMinor`** (`grossCollectedMinor` across all active sales),
   * **(3) `pendingExternalReceivablesCadMinor`** (`MARKETPLACE_PAYOUT_PENDING` net eBay payouts + `BANK_SETTLEMENT_PENDING` unconfirmed e-Transfers/wires where `cashCustodyState === 'PENDING_EXTERNAL_RECEIVABLE'`),
   * **(4) `runningOperatorFloatCadMinor`** (`HELD_IN_OPERATOR_FLOAT` physical cash sales + cash scrap logs minus float expenses & bank sweeps),
   * **(5) `confirmedCorpBankCashCadMinor`** (released loan tranches + `BANK_SETTLEMENT_CONFIRMED` / `SETTLED_ORIGIN_CORP_BANK` sales & scrap + swept float transfers minus settled bank expenses, draws, and bank-settled refunds/chargebacks),
   * **(6) `estimatedDonorProfitCadMinor`** (donor-level accrual contribution margin, distinct from bank liquidity),
   * **(7) `availableWorkingCapitalCadMinor = confirmedCorpBankCashCadMinor - netHstTrustLiabilityCadMinor`** (deployable corporate bank liquidity),
   * **CRA GST/HST & ITC Counters (`RULE-TAX-HST-01`):** `directTaxCollectedNetOfRefundsCadMinor`, `buyerTaxRemittedByPlatformCadMinor` (nullable audit sum), `unverifiedPlatformFeeTaxAccruedCadMinor` ($\sum \text{estimatedPlatformFeeTaxCadMinor}$ where `!isFeeTaxInvoiceVerified`), `verifiedItcReceivableCadMinor` ($\sum \text{SaleTransaction.itcReceivableCadMinor}_{\text{isFeeTaxInvoiceVerified}} + \sum \text{Expense.itcReceivableCadMinor}_{\text{VERIFIED\_RECEIPT}}$), `netHstTrustLiabilityCadMinor = max(0, directTaxCollectedNetOfRefundsCadMinor - verifiedItcReceivableCadMinor)`, `deferredIntercompanyAccrualCadMinor`, and `distributableRealizedProfitPoolCadMinor`.
4. `src/app/api/shared/expenses/route.ts` — POST/GET/PATCH API endpoint for logging tiered/ITC/deferred-accrual expenses, attaching pending receipts, settling deferred accruals, recording bank sweeps, and querying the 7-metric organization-scoped subledger.
5. `src/app/(shared)/expenses/page.tsx` — Gloved-friendly ($56 \times 56\text{ px}$ per `NFR-ACC-01`) Mobile Tiered Receipt/Voucher Expense, Operator Float, Pending Marketplace/Bank Receivables, Confirmed Bank Cash, CRA GST/HST & Verified vs. Accrued ITC Trust, & Tranche Capital Subledger UI.
6. `src/modules/shared-ops/expenses/index.ts` — Barrel export of expense, deferred accrual settlement, cash custody transfer, and 7-metric subledger query services.
7. `src/modules/shared-ops/expenses/__tests__/expenses-and-float.test.ts` — Automated tests verifying: (a) `VERIFIED_RECEIPT` & `itcReceivableCadMinor` capture (and `0` ITC when `isGstHstRegistered === false` or `PETTY_CASH_VOUCHER`), (b) `PENDING_RECEIPT_UPLOAD -> VERIFIED_RECEIPT`, (c) generic `ITA s. 78(1)` accruals, (d) **7-metric separation (`FIX 05`: proving `MARKETPLACE_PAYOUT_PENDING`, `BANK_SETTLEMENT_PENDING`, and unswept `HELD_IN_OPERATOR_FLOAT` never inflate `confirmedCorpBankCashCadMinor` or `availableWorkingCapitalCadMinor` until bank settlement or `CashCustodyTransfer` sweep)**, (e) **verified vs. unverified seller-fee ITC ring-fencing (`FIX 06`)**, (f) liquidity-backed `PARTNER_PROFIT_DRAW` rejection when relying on pending receivables, and (g) cross-tenant `withTenantTransaction` isolation.

## 3. Headless Testability & Offline Fake Requirement
* Uses `InMemoryStorageAdapter` for private receipt and deposit slip uploads (`R2_PRIVATE_EVIDENCE_BUCKET`) and `withTenantTransaction`-compatible in-memory persistence so `expenses-and-float.test.ts` executes 100% offline in Vitest.

## 4. Automated Verification Gate
```bash
pnpm typecheck && pnpm verify:no-stubs && pnpm vitest run src/modules/shared-ops/expenses
```



Issue comments:


Design document:
# Issue #9 design

## Scope and evidence

Implement the supplied Issue #9 requirements for tiered expenses, deferred accrual settlement, compensation, receipt-backed cash sweeps, and the organization-scoped seven-metric subledger. The supplied issue has no comments or separately labelled Anchored Design, Non-goals, or Acceptance Criteria beyond its deliverables and verification gate; those deliverables are the acceptance contract.

Inspected baseline: commit 386da7a, with a clean working tree before this planning artifact. GitHub read-only status confirms blockers #3, #5, #7, and #8 are CLOSED, and their implementations are present in history. Read AGENTS.md, docs/agents/{domain,issue-tracker}.md, ARCHITECTURE.md, PRD.md, DOMAIN-RULES.md, README.md, GLOSSARY.md, handoff-inventory-phase1a.md, and ADRs 0003–0006, along with affected code and tests. CONTEXT.md is absent from this checkout. Only this worktree's .ai-orchestrator.json is used. The externally catalogued ce-plan skill has no worktree-local copy and was not accessed outside the permitted workspace.

Existing reusable contracts:

- src/core/domain/working-capital-and-compensation.ts exports computeSeparatedFinancialSnapshot, computeNetHstTrustLiabilityCadMinor, evaluatePieceRatePayout, and evaluatePartnerProfitDraw. Its tests already exercise settlement separation, evidence-gated ITCs, deferred accruals, and operator-specific draw offsets.
- src/modules/cfo-subledger/financial-snapshot.query.ts loads persisted sales, scrap, transfers, repatriations, and expenses within an existing transaction. Preserve querySeparatedFinancialSnapshot and loadPersistedFinancialSnapshot for existing intake consumers.
- src/infrastructure/db/tenant-transaction.ts uses parameterized tx.$queryRaw, live membership verification, and READ COMMITTED. Its nested transaction support does not permit changing identity.
- Auth uses resolveAuthSessionContext, assertCapability, toTenantExecutionContext, trusted sessions, and existing RBAC/MFA rules. toTenantExecutionContext alone does not re-query membership; the repository transaction must perform the live check.
- Issue #8's part-strip repository provides organization advisory locks, row locks, deterministic AuditLog command receipts, lazy production composition, multipart uploads outside database transactions, and offline repository fakes. Follow this pattern instead of casting a fake into PrismaClient.
- IStoragePort and InMemoryStorageAdapter already upload private evidence with SHA-256 and immutable upload audit metadata, enforce organization prefixes, and generate audited presigned URLs with TTL <= 900 seconds. The generic in-memory phase1a store has no expense/transfer repository support; use a small expense-specific fake.

## Conflicts and explicit resolutions

1. The proposed seven files cannot implement the issue correctly on this baseline. ExpenseCategory lacks PARTNER_TIME_LOG_MEMO. Expense stores only loggedByUserId and a single paidFromCashCustody; it cannot represent a CFO recording a Hunter draw, or persist its split between float and bank. Expense and CashCustodyTransfer also lack the explicit per-organization idempotency keys described by the canonical handoff. Add a forward migration, schema fields, production repository/contracts, and separate client UI and verification files. This is a justified exception to the default ten-implementation-file budget: durable financial allocation, real database enforcement, and server/client separation belong to this atomic feature. Do not edit historical migrations or omit tests to satisfy a count.
2. evaluatePartnerProfitDraw and its current tests explicitly forbid every CFO bypass, including the reserve floor. The authoritative issue explicitly allows the reserve-cap exception. Change the pure guard narrowly: an authenticated CFO approval with a nonblank reason can waive the reserve-floor gate only. Profit-pool insufficiency, pending-receivable exclusion, tenant authorization, ITC evidence, and protection against disbursing more than actual working capital remain hard limits. Update the existing conflicting tests; document the change in the guard. A caller-supplied role or approver ID is never an approval.
3. The persisted loader currently supplies no donorVehicles or refundAdjustments and sets priorPartnerDrawsCadMinor to zero. The pure snapshot's defaults must not become an apparently complete live report. Populate donor summaries from persisted vehicle, part, sale-line, scrap, and expense data; consume linked sale reversals with explicit account attribution. Prior draws are already Expense rows: leave the extra prior-draw parameter at zero to avoid double subtraction.
4. The trigger allows a first receipt attachment and a first accrual settlement, but does not adequately freeze payment custody after settlement. Extend its protection for new draw allocation/recipient fields and settled payment source; preserve the permitted first attachment and first settlement transitions.
5. Destination-vault sweeps are explicitly requested, although vault operations are Phase 3. Represent and record the two permitted transfer pairs generically, with role checks and evidence. A destination-bank transfer never credits Canadian corporate bank cash or working capital. Do not build vault sales, FX repatriation workflows, or an overseas UI; unknown destination holdings fail closed rather than becoming a fabricated balance.

## Module and transaction design

Keep application commands and projections under shared-ops/expenses and financial arithmetic in core/domain. Introduce ExpenseRepository and ExpenseTx contracts, implemented by a Prisma adapter and an offline fake in tests. Every entry point accepts a trusted AuthSessionContext. Production repository operations run inside withTenantTransaction(prisma, toTenantExecutionContext(session), callback); no database reads or policy lookups escape tenant scope. Resolve policy with JsonPolicyConfigAdapter using the transaction's Organization.policyConfigJson reader, not a baseline-only production adapter.

Expose a composed ExpenseService with logExpense(session, command), attachExpenseReceipt(session, expenseId, receiptStorageKey, itcReceivableCadMinor?, commandMetadata), settleDeferredAccrual(session, expenseId, settlement, commandMetadata), recordCashCustodyTransfer(session, command), and queryOperatorFloatSubledger(session, options). Commands carry an Idempotency-Key and normalized payload; clock and ID generation are injectable. Exact exported DTOs and errors live in expenses.contracts.ts. Query DTOs contain safe data and evidence availability, never permanent evidence URLs.

Use the same organization advisory lock key derivation as Issue #8, then acquire entity locks in stable order. All expense, draw, and sweep writers use it, covering cap checks, balance reads, and writes atomically. Queries take that lock for a coherent READ COMMITTED projection; do not independently read changing balances in separate transactions. Intake and scrap writers already using the shared lock remain coordinated. Publish the lock contract for future checkout writers; proving future checkout implementation is not part of this PR.

After locking, check idempotency before applying business rules. Create expense/transfer idempotency keys with composite organization uniqueness; use deterministic AuditLog command receipt IDs for all operations, including PATCH. Compare stored operation, actor, target, and normalized payload fingerprint. Same command returns the original safe result; reuse with different content returns 409 IDEMPOTENCY_KEY_REUSED. Upload fingerprints use exact file bytes/hash and metadata, not newly generated R2 keys. Atomically commit business rows, audit before/after state, override details, result receipt, and organization-scoped outbox intent. Exceptions roll everything back. Upload storage outside the transaction, then recheck live membership and finalize; an upload orphan must not cause a financial write or a retry duplicate.

## Persistence additions

Add PARTNER_TIME_LOG_MEMO to ExpenseCategory. Add nullable recipientUserId and an organization-membership relation keyed by organizationId/userId (plus Prisma inverse relation), immutable floatOffsetAppliedCadMinor defaulting to zero, and nullable custodyHolderUserId with same-organization membership linkage. The logger remains the authenticated actor; the recipient and float holder are independent. Add nullable idempotencyKey to Expense and CashCustodyTransfer with @@unique([organizationId, idempotencyKey]); historical nulls remain valid, while new service commands require keys. Add a transfer custodyHolderUserId so a CFO can record another operator's deposit without misattribution.

For a draw, amountCadMinor is the total authorized draw, floatOffsetAppliedCadMinor is its physical float settlement, and bank debit is their difference. No synthetic CashCustodyTransfer represents a draw: that would incorrectly credit bank cash. Modify SnapshotExpenseRow and persisted mappings to represent the split, and deduct the full draw exactly once from distributable profit. Existing expenses retain zero offset and their existing payment-source behavior. Validate offset <= amount, CAD-only draw amounts, valid founder recipient membership, and zero ITC on compensation; protect new fields with CHECKs and immutability. Memo rows have amountOriginalMinor = amountCadMinor = itcReceivableCadMinor = 0, no payment source, no deferral, and no float/bank/profit impact. Represent them with PENDING_RECEIPT_UPLOAD plus explanatory voucherReason as a deliberate zero-value memo exception; the UI must label them as memos and exclude them from missing-receipt queues.

## Expense and evidence rules

- Validate integer minor units within Prisma Int bounds, currency, timestamps, nonblank vendor/description, category, and same-tenant vehicle/shipment references. Reject client identity/org/settlement-field injection. Phase 1A UI uses CAD; foreign amounts require explicit original currency and a nonzero CAD equivalent, never implicit 1:1 conversion or floating-point rounding.
- Omitted receipt state defaults to VERIFIED_RECEIPT. Missing/blank evidence returns 422 RECEIPT_REQUIRED. A supplied key must be a canonical same-tenant private evidence key with a matching PRIVATE_EVIDENCE_UPLOADED AuditLog record; load SHA-256 from that trusted metadata. Public media, arbitrary prefixed strings, foreign keys, or caller-provided hashes cannot establish verification. Reuse existing storage access for viewing; raw bucket paths are never public links.
- Capture a supplied ITC only for VERIFIED_RECEIPT and the owning policy's isGstHstRegistered = true; default omitted ITC to zero and force zero otherwise. Validate nonnegative integer ITC <= expense amount. Do not infer ITC by applying a flat 13% or automatically promote platform fee estimates. Compensation/memos do not claim purchase ITCs.
- PETTY_CASH_VOUCHER permits <= 5000 CAD cents, requires a trimmed reason of >= 5 characters, and always has zero ITC. Use the policy limits with defaults 5000/25000. Cap per organization and authenticated operator over [serverNow - 30 days, serverNow], using createdAt to prevent backdating evasion. Sum unreversed vouchers and the proposed amount under the lock. Exactly 25000 is allowed; an excess requires trusted CFO approval. Per-item 5000 and reason/evidence requirements cannot be overridden.
- PENDING_RECEIPT_UPLOAD requires a >= 5-character reason and has zero ITC. Ordinary pending rows represent already-paid field outlays, defaulting to the actor's operator float, so they reduce that float immediately. Receipt attachment changes evidence and eligible ITC, never charges cash again. Deferred accruals may use a pending-evidence state independently of cash payment. Attach only to pending rows; a conflicting repeat returns 409 EXPENSE_RECEIPT_ALREADY_ATTACHED, while exact idempotent replay returns its original result.
- A deferred row starts with accrualSettledAt null and reduces accrual profit, not bank/float cash. settleDeferredAccrual is CFO-authorized, full settlement only, stamps server time and the validated payment source under the lock, and cannot repeat or backdate payment. It decreases bank cash exactly once without charging profit twice. No counterparty names, tax-year add-back automation, Form T2047 filing, or tax deductibility decision is embedded.

## Compensation and transfer rules

Require FR-EXP-02:approve and existing AAL2 for compensation authorization. Load piece-rate evidence from current same-tenant donor/parts under lock, call evaluatePieceRatePayout, and require its configured authorized payout rather than a caller-chosen rate. Return 422 PIECE_RATE_GATE_UNMET for missing vehicle/drainage/qualifying parts; do not reinterpret WARN_ONLY environmental agility as a compensation waiver. Prevent a second unreversed piece-rate payout for the same donor. PARTNER_TIME_LOG_MEMO persists descriptive time work without cash accounting.

For founder draws, resolve recipient membership and role in the database. Call the amended evaluatePartnerProfitDraw on the persisted snapshot, with the recipient's own float. Persist the float offset and bank remainder together. Pending eBay payouts and bank transfers cannot fund distributable profit. A valid reserve override does not permit bank payout exceeding max(0, availableWorkingCapitalCadMinor), does not alter HST trust calculations, and never overrides INSUFFICIENT_REALIZED_PROFIT_POOL.

Transfers require positive amounts, a canonical private deposit slip backed by trusted upload audit, a same-organization cash holder, and exactly one of HELD_IN_OPERATOR_FLOAT -> SETTLED_ORIGIN_CORP_BANK (DOMESTIC_ORIGIN, CAD, amountMinor = equivalentCadMinor) or HELD_IN_DESTINATION_VAULT -> DEPOSITED_DESTINATION_BANK. Bound the sweep by that holder's available source cash under lock; partial deposits are allowed. Keep original sale/scrap custody rows as history and record the transfer debit/credit once. Destination transfers retain their original currency and explicit CAD equivalent for audit, but never count as repatriation. Reject impossible pairs, wrong currency, over-sweeps, and replay conflicts with deterministic 422/409 outcomes.

## Projection semantics

Reuse and extend the existing snapshot input and calculator, so expense commands and the existing acquisition gate see identical balances. The response includes all seven named metrics, released tranche breakdown, operator balances, pending expense rows, deferred balances/aging, distributable profit, and tax counters.

Accounting revenue is active pre-tax sales less linked refund subtotals. Gross sale value is active grossCollectedMinor less refund gross amounts. Pending receivables are net eBay payout or gross direct unconfirmed payments with PENDING_EXTERNAL_RECEIVABLE custody. Float is physical cash sales/scrap less holder-attributed expenses, draw offsets, refunds, and sweeps. Bank cash is released tranches plus cleared CAD deposits/scrap/sweeps/repatriations less bank-paid expenses, net draw payments, and actual bank refunds. Unsettled accruals never drain cash. Estimated donor profit uses per-donor acquisition/strip expenses, realized sale-line proceeds, remaining-part compBaselineCadMinor estimates, and scrap recovery once; expose warnings for missing estimates rather than pretending a zero estimate is verified value. This projection cannot feed bank liquidity.

Extend the pure tax calculation to return directTaxCollectedNetOfRefundsCadMinor, verifiedItcReceivableCadMinor, and netHstTrustLiabilityCadMinor together, while preserving the old scalar function. Expense and sale reversals must reduce their associated ITCs once. Report unverifiedPlatformFeeTaxAccruedCadMinor separately. buyerTaxRemittedByPlatformCadMinor remains null if no authoritative marketplace amount is known; sum only reported CAD amounts and include an incompleteness indicator if some remain unknown. Ignore unverified ITCs even if an imported row contains a positive amount. availableWorkingCapitalCadMinor = bank cash - max(0, direct tax - verified ITCs); excess ITCs never fabricate cash.

Map persisted reversal SaleTransaction rows by reversesSaleTxId into the calculator's existing refundAdjustment input; do not treat them as new positive sales. Use the reversal's settlement/custody source for refund cash attribution. Preserve original earned proceeds before applying the signed adjustment, exclude wholly void originals without a paid refund, and reject ambiguous/malformed reversal links rather than silently asserting bank liquidity. Issue #9 reads and tests these existing representable records; checkout refund commands and any richer partial-refund persistence belong to #10. Document this normalized read contract for that consumer.

## API, UI, authorization, and phase boundaries

Use a thin Node runtime API route backed by an injectable handler. POST accepts log-expense and record-transfer discriminated actions; PATCH accepts attach-receipt and settle-accrual. Support bounded multipart evidence plus JSON metadata so the UI can actually upload receipts/slips using existing IStoragePort; accept already-uploaded keys only after trusted upload verification. GET selects subledger/history or an authorized short-lived evidence URL. Require Idempotency-Key on mutations; reject malformed JSON/actions, oversized files, unknown fields, and invalid amounts. Responses use private/no-store headers and sanitized structured errors: 401 unauthenticated, 403 revoked/forbidden, 404 inaccessible target, 409 replay/state conflict, and 422 deterministic business validation. Validate Origin on browser mutations consistently with existing handlers.

Keep existing RBAC grants. CFO gets organization-wide financial views, settlement/sweep actions and approvals; Hunter gets existing expense-create/read and own-float grants, with pending-receipt completion for their own rows as part of their original create workflow. Do not grant general financial update access. Stripper has only own-piece-rate access; vault staff's restricted port-fee grant is not organization-wide finance access. Return only each capability's safe projection; the requested complete seven-metric report requires CFO financial access. Test the restricted projections instead of relying on hidden UI controls.

Use an authenticated server page and a separate client expense form. Present receipt/voucher/pending choices, receipt attachment, deferred accrual status/settlement, authorized sweep and draw forms, and distinct revenue, gross value, pending receivables, operator cash, bank cash, donor estimate, working capital, trust/ITC, and released-tranche cards. Never label float or pending payouts as spendable bank funds. Controls are >= 56 by 56 px, with high contrast, visible text/icon status, accessible error/live regions and progressive haptic/audio feedback. Disable repeated submissions and retain the same command key across network retries; discard stale responses and reload state on organization switch.

Non-goals: real eBay/bank integrations, checkout mutation APIs, tranche-release workflows, actual bank payment initiation, statutory GL sync workers, vault activation, cannabis application services/routes, tax filings, retention purge infrastructure, or phase-completion sign-off. Outbox contracts and persisted tax/settlement inputs enable future #10 and Phase 2A consumers; this PR does not have to execute those consumers, validate real providers, produce locked-SHA operational runs, or certify a downstream exit gate.

## Risks and readiness

The principal risks are changing an established guard, incorrect refund interpretation, expense/float attribution drift, duplicate cash movement on retry, and policy changes between evidence upload and finalization. Address them with explicit contracts, forward migration checks, shared locks, post-upload authorization, calculator reuse, deterministic replays, and real PostgreSQL tests. The design supplies the missing implementation decisions; it does not claim the original seven-file issue was fully machine-ready merely because dependencies closed. The safe default for unavailable evidence, unknown destination holdings, or malformed ledger history is a named error/incomplete projection, never inferred cash. Actual tax registration and lease verification remain operator/CPA decisions recorded in the canonical handoff, not implementation prerequisites invented for this PR.

Implementation plan:
# Issue #9 implementation plan

## 1. Anchor contracts and schema

Work from the current branch without implementing downstream #10. Add expenses.contracts.ts with command/action DTOs, safe read projections, error codes, repository/transaction methods, injectable clock/IDs, upload metadata, and normalized idempotency receipts. Define all state transitions and capability checks described in the design before route work. Use Issue #8's lock and audit-receipt pattern.

Update prisma/schema.prisma and add a new forward migration (for example 0003_expense_allocation_and_idempotency/migration.sql). Add the memo enum value, recipient/holder membership links, draw float offset, and organization-scoped nullable idempotency keys for historical compatibility. Add amount/offset/memo CHECKs, cap-query indexes, and extend the existing financial immutability function to protect new allocations and freeze paidFromCashCustody after settlement. Preserve RLS, grants, current constraints, and first receipt/settlement updates. Do not add new tenant tables unless later evidence makes them necessary. Confirm Prisma enum migration ordering before using the new enum value in CHECKs. Update the SQL constraints manifest only if these new constraints enter its enumerated contract.

## 2. Complete the shared financial projection

Extend working-capital-and-compensation.ts for recipient-attributed draw splits and the narrowly scoped reserve override, preserving public exports. Factor reusable pure tax counter output so scalar HST trust and the UI cannot diverge. Ensure memo rows have zero cash/profit impact and mixed draw allocations charge float/bank/profit once.

Extend financial-snapshot.query.ts instead of creating another full ledger loader. Load new fields, donor data and sale lines, and normalize linked sale reversals into refund adjustments. Load all rows inside the caller's verified, locked tenant transaction. Define donor arithmetic using actual available fields: per-vehicle acquisition/strip expenses, associated sale item proceeds, non-sold remaining parts' comp baselines, and scrap recovery, excluding partner draws/memos from donor costs. Do not add sale price and net payout as two revenues, or both rolled-up and stream scrap proceeds. Keep priorPartnerDrawsCadMinor = 0 when all draws are already included as expenses.

Keep existing intake snapshot consumers compatible; regression-test their outputs. Add explicit tests for ledger grossCollectedMinor versus subtotal-plus-tax, tax reversals, zero/unverified/verified ITCs, missing donor estimates, memo rows, and draw allocation.

## 3. Build real transaction adapters and expense commands

Implement expenses.repository.ts with lazy Prisma/storage composition, scoped policy lookup, same organization advisory lock used by Issue #8, entity locks, deterministic command receipts, and atomic audit/outbox writes. Repository reads include live recipient membership, donor/parts, voucher totals, evidence upload metadata, expense/history, and shared snapshot inputs. Translate revoked membership to the existing 403 auth error. Every read and write uses withTenantTransaction and parameterized SQL.

Implement log-expense.use-case.ts with logExpense, attachExpenseReceipt, and settleDeferredAccrual. Validate receipt defaults, canonical private evidence and trusted hashes, ITC policy, voucher item/rolling cap boundaries, pending holds, deferred cash exclusion, piece-rate eligibility/duplicate donor payouts, zero memos, founder profit-pool checks and durable draw splits. Require final transaction authorization after uploads. Rejected commands have no business row, command receipt, outbox intent, or cash impact.

Implement record-cash-custody-transfer.use-case.ts with allowed pairs, currency normalization, receipt verification, source-holder checks, available-balance checks and replay protection. A sweep never mutates the original cash sale/scrap into a second bank credit. Destination bank transfers remain outside Canadian bank capital.

Implement operator-float-subledger.query.ts as the authorization-aware, transaction-owning read service around the enhanced shared snapshot and counters, with safe role-restricted history/pending/deferred views. Export composed commands, query and types through index.ts. Keep production factories callable without forcing database or R2 connections on import.

## 4. Add the API and functional mobile UI

Add expenses-route.handler.ts with injectable session/service dependencies, bounded multipart uploads and key-only JSON commands, strict discriminated request validation, Idempotency-Key enforcement, structured errors, no-store responses, and authorized evidence URL access. Keep src/app/api/shared/expenses/route.ts to Node runtime GET/POST/PATCH delegates; never export arbitrary test helpers from a Next route module.

Add src/app/(shared)/expenses/page.tsx as the authenticated server entry and expense-form.tsx as the client UI. Connect every requested action through the API, include receipt/slip file selection and retry handling, and render only authorized projections. Cover 56 px controls, text/icon cues, inline errors and confirmation, pending upload queue, generic deferred aging, seven separate financial metrics, trust and estimated-vs-verified ITCs, and tranche status. CFO override UI sends intent/reason; server determines identity and authority. Do not expose dormant cannabis or vault application screens.

## 5. Offline verification

Add src/modules/shared-ops/expenses/__tests__/expenses-and-float.test.ts with a small transactional ExpenseRepository fake implementing live membership checks, organization isolation, serialized writes, rollback, injected time, and command replay. Use InMemoryStorageAdapter with injected StorageSecurityRepository; never let its default security dependency resolve a live Prisma connection. Exercise actual use cases and injectable handlers with zero network and no PostgreSQL.

Deterministic scenarios:

- Missing/default verified receipt -> 422 RECEIPT_REQUIRED; actual private upload succeeds with persisted hash. Reject public, foreign, absent and malformed evidence keys.
- Registered verified invoice captures supplied ITC; unregistered, voucher, pending, memo and compensation ITCs are zero. No arbitrary flat-rate tax calculation. Invalid/overflow values fail.
- Voucher 5000 allowed, 5001 rejected; trimmed 4-character reason rejected; 25000 rolling total allowed and 25001 rejected without valid CFO approval. Boundary timestamps, organizations/operators, backdating, reversals and concurrent cap crossing are covered.
- Pending receipt upload transitions once and changes ITC/trust without paying cash twice. Repeated matching commands replay; conflicting attachments fail. Membership revoked between upload and final commit denies access.
- Deferred 10000-cent expense reduces distributable profit but not bank cash; settlement decreases bank cash by 10000 exactly once and preserves original amount/identity. Generic vendor names work.
- Seed-only capital has zero distributable profit. Pending marketplace/bank money cannot support draws. Piece-rate gates cover drainage, 34/35 qualifying parts, missing photos/bin barcode, wrong donor and duplicate payout.
- A 10000 draw against 4000 of the target Hunter's float consumes 4000 float and 6000 bank, deducts 10000 profit once, and leaves other operators' float unchanged. CFO recording it is not treated as recipient. Reserve breach rejects normally; trusted CFO reason permits the reserve exception only with enough real capital and profit. Forged approval, insufficient profit and attempts to spend HST trust remain rejected.
- Pending eBay 100000-cent net payout and pending 113000-cent direct transfer leave bank cash/working capital unchanged. Physical cash 113000 increases float; a 60000 sweep moves precisely 60000 from float to bank without changing revenue/profit. Over-sweep, duplicate receipt, and concurrent draw/sweep races fail deterministically.
- Tax counters separate authoritative marketplace buyer tax, unverified fee tax, verified fee ITC and expense ITCs. All-unknown buyer tax remains null. Refund fixtures reverse subtotal, gross, bank/float source and tax once; malformed links fail closed. Estimated donor profit never becomes bank cash.
- All commands, evidence reads, projected views, vehicle/shipment/recipient references, revocation and same-key use across organizations obey tenant/capability restrictions. Same-key changed-payload replay returns 409; transaction failure rolls back all financial/audit/outbox state.

Add expenses-ui.test.tsx using the repository's jsdom/Testing Library conventions. Verify actual form actions/uploads, authorization-limited rendering, visible metrics, 56 px controls, accessible feedback, retained retry keys, and workspace/stale-response isolation. Composition tests invoke the production factory with injected adapters; no route or page silently uses an in-memory adapter in production.

## 6. Real PostgreSQL verification and regression checks

Add expenses.integration.test.ts following part-strip.integration.test.ts: use TEST_DATABASE_URL for erp_app_user and DIRECT_URL only for admin fixture setup; clearly skip when unavailable in offline runs. With PostgreSQL configured, verify runtime role NOBYPASSRLS, actual service writes, forced tenant isolation including the cannabis fixture, composite recipient/asset FKs, membership revocation, unique idempotency constraints, concurrent cap/draw/sweep serialization, rollback, receipt/settlement update allowances and forbidden financial mutations. No cannabis business workflow tests are introduced.

Update the existing domain compensation tests to reflect the issue-authorized reserve override while retaining hard profit/tax/real-cash invariants. Run existing intake and part-strip financial regressions and storage/auth tests as part of the full suite. An offline fake demonstrates application behavior only; it cannot prove RLS, SQL triggers, pooling or concurrent database behavior.

Commands after implementation, all from this worktree:

1. pnpm db:generate
2. pnpm typecheck && pnpm verify:no-stubs && pnpm vitest run src/modules/shared-ops/expenses
3. pnpm vitest run src/core/domain/__tests__/working-capital-and-compensation.test.ts
4. With configured migration/admin and runtime test URLs: pnpm db:migrate, then pnpm vitest run src/modules/shared-ops/expenses/__tests__/expenses.integration.test.ts
5. pnpm test and pnpm test:db:rls using the respective URLs and complete validation commands in .ai-orchestrator.json. Verify integration suites executed rather than treating skipped tests as success. The configured pnpm test:db:rls command covers the existing pooled context isolation/revocation suite; keep its real PostgreSQL requirement.

Record actual results and environment limitations. Planning did not execute implementation tests or migrations and makes no passing-test claim. No real R2/eBay/bank provider verification, downstream checkout execution, locked-SHA operational proof, or phase completion sign-off is required to accept this issue's local contracts.

## Expected ownership and size exception

Primary additions are the seven issue-named files, plus expenses.contracts.ts, expenses.repository.ts, expenses-route.handler.ts, expense-form.tsx, expenses-ui.test.tsx and expenses.integration.test.ts. Necessary modifications are prisma/schema.prisma, a new migration, core/domain/working-capital-and-compensation.ts and its existing test, and cfo-subledger/financial-snapshot.query.ts. This is approximately 18 files including tests, exceeding ten implementation units when schema and composition are counted. The reason is concrete baseline contract gaps, not optional abstraction: a seven-file patch would hide financial allocation in ad hoc JSON, conflate logger with recipient, omit real persistence or mix server/client responsibilities. Keep contracts narrow and the fake local to tests. Additional file changes are allowed when required by generated types, constraints manifests or existing test fixtures; explain each rather than treating this estimate as a brittle allowlist.

## Acceptance traceability and handoff

FR-EXP-01 maps to actual persisted expense tiers, evidence, ITCs and deferred settlement tests. FR-EXP-02/RULE-PAY-001–003 map to piece-rate, memo, draw split, profit/reserve and replay tests. FIX 05 maps to seven-metric fixtures and persisted projection parity. FIX 06 maps to tax counters, evidence checks and refund normalization. NFR-SEC-01/02, NFR-IDEM-01 and NFR-CI-01 map to private storage/auth, immutable receipts, SQL constraints and executed PostgreSQL verification. NFR-ACC-01 maps to the functional mobile UI tests. NFR-RET-01 preserves existing no-delete financial/audit behavior and private evidence retention; no new purge feature is needed.

Future #10 can consume the persisted snapshot, refund-normalization input and organization lock contracts; Phase 2A can consume organization-scoped outbox intents and PENDING_SYNC fields. These are future capabilities enabled by this design, not present verification obligations for checkout providers, external GL delivery or operational exit gates.

Accumulated review findings ledger:

```
### UNRESOLVED BLOCKING FINDINGS:
- **[AC-1] [HIGH]** Failed requirement: Expose a composed ExpenseService with logExpense(session, command), attachExpenseReceipt(session, expenseId, receiptStorageKey, itcReceivableCadMinor?, commandMetadata), settleDeferredAccrual(session, expenseId, settlement, commandMetadata), recordCashCustodyTransfer(session, command), and queryOperatorFloatSubledger(session, options). Commands carry an Idempotency-Key and normalized payload; clock and ID generation are injectable. Exact exported DTOs and errors live in expenses.contracts.ts. Query DTOs contain safe data and evidence availability, never permanent evidence URLs.
  Evidence: In src/modules/shared-ops/expenses/expenses.repository.ts (lines 929-956) and src/modules/shared-ops/expenses/log-expense.use-case.ts (lines 1066-1069, 1377-1380), ExpenseService.attachExpenseReceipt and LogExpenseUseCase.attachExpenseReceipt only accept the 2-argument object signature (session: AuthSessionContext, rawInput: AttachExpenseReceiptCommand), and ExpenseService.settleDeferredAccrual and LogExpenseUseCase.settleDeferredAccrual only accept (session: AuthSessionContext, rawInput: SettleDeferredAccrualCommand). Neither ExpenseService nor LogExpenseUseCase supports the positional signatures required by DESIGN-2 and Issue #9 Deliverable 1: attachExpenseReceipt(session, expenseId, receiptStorageKey, itcReceivableCadMinor?, commandMetadata) and settleDeferredAccrual(session, expenseId, settlement, commandMetadata). Furthermore, the standalone helper functions attachExpenseReceipt and settleDeferredAccrual in src/modules/shared-ops/expenses/log-expense.use-case.ts (lines 1589-1623) require useCase: LogExpenseUseCase as a leading first argument prior to session.
  Required Fix: Implement requirement to satisfy: Expose a composed ExpenseService with logExpense(session, command), attachExpenseReceipt(session, expenseId, receiptStorageKey, itcReceivableCadMinor?, commandMetadata), settleDeferredAccrual(session, expenseId, settlement, commandMetadata), recordCashCustodyTransfer(session, command), and queryOperatorFloatSubledger(session, options). Commands carry an Idempotency-Key and normalized payload; clock and ID generation are injectable. Exact exported DTOs and errors live in expenses.contracts.ts. Query DTOs contain safe data and evidence availability, never permanent evidence URLs.
  Source: spec-review (iteration 0)

- **[AC-2] [HIGH]** Failed requirement: Use the same organization advisory lock key derivation as Issue #8, then acquire entity locks in stable order. All expense, draw, and sweep writers use it, covering cap checks, balance reads, and writes atomically. Queries take that lock for a coherent READ COMMITTED projection; do not independently read changing balances in separate transactions. Intake and scrap writers already using the shared lock remain coordinated. Publish the lock contract for future checkout writers; proving future checkout implementation is not part of this PR.
  Evidence: organizationAdvisoryLockKeys in src/modules/shared-ops/expenses/expenses.contracts.ts (lines 829-836) matches Issue #8 and is exported for downstream consumers, and executeCommit / query acquire the organization advisory lock. However, in the multipart binary upload preflight transactions (preflightReplay in src/modules/shared-ops/expenses/log-expense.use-case.ts lines 833-853 and 1222-1242, and src/modules/shared-ops/expenses/record-cash-custody-transfer.use-case.ts lines 339-359), repository.withTenantTransaction executes evaluateAndValidateInTx(tx), validateTargetExpense(tx), and validateFundsInTx(tx) — which acquire FOR UPDATE row locks on Vehicle, Part, and Expense and read voucher caps and snapshot balances — WITHOUT first calling tx.acquireOrganizationLock(organizationId). Similarly, getEvidencePresignedUrl in src/modules/shared-ops/expenses/operator-float-subledger.query.ts (line 362) acquires a FOR UPDATE lock on Expense via tx.findAndLockExpense without acquiring the organization advisory lock.
  Required Fix: Implement requirement to satisfy: Use the same organization advisory lock key derivation as Issue #8, then acquire entity locks in stable order. All expense, draw, and sweep writers use it, covering cap checks, balance reads, and writes atomically. Queries take that lock for a coherent READ COMMITTED projection; do not independently read changing balances in separate transactions. Intake and scrap writers already using the shared lock remain coordinated. Publish the lock contract for future checkout writers; proving future checkout implementation is not part of this PR.
  Source: spec-review (iteration 0)

- **[AC-3] [HIGH]** Failed requirement: After locking, check idempotency before applying business rules. Create expense/transfer idempotency keys with composite organization uniqueness; use deterministic AuditLog command receipt IDs for all operations, including PATCH. Compare stored operation, actor, target, and normalized payload fingerprint. Same command returns the original safe result; reuse with different content returns 409 IDEMPOTENCY_KEY_REUSED. Upload fingerprints use exact file bytes/hash and metadata, not newly generated R2 keys. Atomically commit business rows, audit before/after state, override details, result receipt, and organization-scoped outbox intent. Exceptions roll everything back. Upload storage outside the transaction, then recheck live membership and finalize; an upload orphan must not cause a financial write or a retry duplicate.
  Evidence: 1. In src/modules/shared-ops/expenses/log-expense.use-case.ts (lines 341-540, 1132-1137) and src/modules/shared-ops/expenses/record-cash-custody-transfer.use-case.ts (lines 154-266), domain business rules (RECEIPT_REQUIRED -> 422, VOUCHER_REASON_REQUIRED -> 422, DEPOSIT_SLIP_REQUIRED -> 422, INVALID_TRANSFER_PAIR -> 422, CFO_OVERRIDE_REASON_REQUIRED -> 422, CFO_OVERRIDE_UNAUTHORIZED -> 403, and memo/draw/piece-rate constraints) are evaluated BEFORE entering withTenantTransaction, BEFORE acquiring the organization lock, and BEFORE checking tx.findCommandReceipt / resolveIdempotentExpenseReplay. 2. In resolveIdempotentExpenseReplay callers, logExpense/attachExpenseReceipt/settleDeferredAccrual only check tx.findExpenseByIdempotencyKey (ignoring tx.findTransferByIdempotencyKey), and recordCashCustodyTransfer only checks tx.findTransferByIdempotencyKey (ignoring tx.findExpenseByIdempotencyKey). 3. In addition, the live PostgreSQL integration test suite (src/modules/shared-ops/expenses/__tests__/expenses.integration.test.ts) fails with exit code 1 when run via the effective validation command in .ai-orchestrator.json because afterAll attempts to DELETE FROM shared.OrganizationMembership without checking NOT EXISTS on shared.Expense and shared.CashCustodyTransfer (which reference OrganizationMembership with ON DELETE RESTRICT).
  Required Fix: Implement requirement to satisfy: After locking, check idempotency before applying business rules. Create expense/transfer idempotency keys with composite organization uniqueness; use deterministic AuditLog command receipt IDs for all operations, including PATCH. Compare stored operation, actor, target, and normalized payload fingerprint. Same command returns the original safe result; reuse with different content returns 409 IDEMPOTENCY_KEY_REUSED. Upload fingerprints use exact file bytes/hash and metadata, not newly generated R2 keys. Atomically commit business rows, audit before/after state, override details, result receipt, and organization-scoped outbox intent. Exceptions roll everything back. Upload storage outside the transaction, then recheck live membership and finalize; an upload orphan must not cause a financial write or a retry duplicate.
  Source: spec-review (iteration 0)

- **[AC-4] [HIGH]** Failed requirement: Issue 10: Zero-Typing Domestic Syndication + B2B Mechanic Sheet (FR-MKT-00) & Ontario CAD Checkout with Channel-Split HST / eBay Billing Agent (FR-CHK-01)
  Evidence: 1. In src/core/domain/working-capital-and-compensation.ts (lines 912-930), computeSeparatedFinancialSnapshot only enters the corporate bank settlement branch when `sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' && sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'`. When a bank-settled SaleTransaction transitions to `paymentSettlementState = 'REFUNDED_OR_CHARGED_BACK'` (`isVoidedOrReversed = true`, as required by the SQL CHECK constraint `sale_settlement_custody_consistency` and Issue #10's `recordSaleRefundOrChargeback`) AND has a linked reversal SaleTransaction (`reversesSaleTxId`, mapped by `buildPersistedLedgerProjection` into `refundAdjustments` so `hasExplicitAdjustments === true`), `isFullImplicitReversal` is false, yet line 913 skips the sale completely because `paymentSettlementState` is `'REFUNDED_OR_CHARGED_BACK'` rather than `'BANK_SETTLEMENT_CONFIRMED'`. Consequently, original `bankCleared` proceeds, `adjBankRefund`, `adjFloatRefund`, `netRealizedCad`, and `adjNetRealized` are all silently dropped from `confirmedCorpBankCashCadMinor` and `distributableRealizedProfitPoolCadMinor` while `accountingRevenueCadMinor` and `directTaxCollectedNetOfRefundsCadMinor` still include them. 2. In src/core/domain/working-capital-and-compensation.ts (line 879), `grossSaleValueCadMinor` is computed from `BigInt(subtotal + taxOrVat) + adjGross` rather than `BigInt(grossCollected) + adjGross`, which diverges from `grossCollectedMinor` when checkout discounts or shipping charges are present.
  Required Fix: Implement requirement to satisfy: Issue 10: Zero-Typing Domestic Syndication + B2B Mechanic Sheet (FR-MKT-00) & Ontario CAD Checkout with Channel-Split HST / eBay Billing Agent (FR-CHK-01)
  Source: spec-review (iteration 0)

- **[F-b5a3ee24] [CRITICAL]** Migration `0004_expense_allocation_and_idempotency/migration.sql` added `ON DELETE RESTRICT` composite foreign keys from `shared.Expense` (`recipientUserId`, `custodyHolderUserId`) and `shared.CashCustodyTransfer` (`custodyHolderUserId`) to `shared.OrganizationMembership(organizationId, userId)`. Because `shared.Expense`, `shared.CashCustodyTransfer`, `salvage.SaleTransaction`, and `shared.AuditLog` are protected by no-delete triggers (`lock_expense_delete`, `lock_cash_transfer_mutation`, `lock_sale_tx_delete`, `lock_audit_log`), rows created in those tables during the test remain persisted. Unconditionally deleting `OrganizationMembership` rows (and deleting `User` / `Organization` rows without checking all referencing tables) causes `pnpm test` to fail under the configured PostgreSQL environment and CI.
  Files: src/modules/shared-ops/expenses/__tests__/expenses.integration.test.ts
  Evidence: In `src/modules/shared-ops/expenses/__tests__/expenses.integration.test.ts` (lines 88-108), `afterAll` executes:
```ts
if (createdMembershipIds.length > 0) {
  await ownerPrisma.$executeRaw`
    DELETE FROM "shared"."OrganizationMembership"
    WHERE "id" = ANY(${createdMembershipIds}::uuid[])
  `;
}
```
Running the effective validation command from `.ai-orchestrator.json` (`DIRECT_URL=postgresql://postgres:postgres@localhost:5432/salvage_erp_test DATABASE_URL=postgresql://erp_app_user:erp_app_test_pw@localhost:5432/salvage_erp_test?pgbouncer=true TEST_DATABASE_URL=postgresql://erp_app_user:erp_app_test_pw@localhost:5432/salvage_erp_test?pgbouncer=true pnpm test`) fails with exit code 1:
`PrismaClientKnownRequestError: Raw query failed. Code: 23001. Message: ERROR: update or delete on table "OrganizationMembership" violates RESTRICT setting of foreign key constraint "Expense_organizationId_custodyHolderUserId_fkey" on table "Expense"`.
  Required Fix: In `src/modules/shared-ops/expenses/__tests__/expenses.integration.test.ts` `afterAll`: (1) guard `DELETE FROM "shared"."OrganizationMembership" m` with `AND NOT EXISTS (SELECT 1 FROM "shared"."Expense" e WHERE e."organizationId" = m."organizationId" AND (e."recipientUserId" = m."userId" OR e."custodyHolderUserId" = m."userId"))` and `AND NOT EXISTS (SELECT 1 FROM "shared"."CashCustodyTransfer" ct WHERE ct."organizationId" = m."organizationId" AND ct."custodyHolderUserId" = m."userId")`; (2) guard `DELETE FROM "shared"."User" u` with `NOT EXISTS` checks for `OrganizationMembership`, `SaleTransaction` (`soldByUserId`, `verifiedByAdminId`), `CashCustodyTransfer` (`recordedByUserId`), `Expense`, and `AuditLog`; and (3) guard `DELETE FROM "shared"."Organization" o` with `NOT EXISTS` checks for `OrganizationMembership`, `SaleTransaction`, `Expense`, `CashCustodyTransfer`, and `AuditLog`.
  Source: spec-review (iteration 0)

- **[F-9c6abedb] [HIGH]** Violates `[DESIGN-2]` (`Expose a composed ExpenseService with logExpense(session, command), attachExpenseReceipt(session, expenseId, receiptStorageKey, itcReceivableCadMinor?, commandMetadata), settleDeferredAccrual(session, expenseId, settlement, commandMetadata), recordCashCustodyTransfer(session, command), and queryOperatorFloatSubledger(session, options)`) and Issue #9 Deliverable 1 (`attachExpenseReceipt(session, expenseId, receiptStorageKey, itcReceivableCadMinor?)`). Calling `service.attachExpenseReceipt(session, expenseId, receiptStorageKey, itcReceivableCadMinor?, commandMetadata?)` or `service.settleDeferredAccrual(session, expenseId, settlement?, commandMetadata?)` fails at runtime with `400 INVALID_EXPENSE_INPUT`.
  Files: src/modules/shared-ops/expenses/log-expense.use-case.ts, src/modules/shared-ops/expenses/expenses.repository.ts, src/modules/shared-ops/expenses/expenses.contracts.ts
  Evidence: In `src/modules/shared-ops/expenses/expenses.repository.ts` (lines 929-956) and `src/modules/shared-ops/expenses/log-expense.use-case.ts` (lines 1066-1069, 1377-1380), `ExpenseService.attachExpenseReceipt` and `LogExpenseUseCase.attachExpenseReceipt` only accept `(session: AuthSessionContext, rawInput: AttachExpenseReceiptCommand)`, and `ExpenseService.settleDeferredAccrual` and `LogExpenseUseCase.settleDeferredAccrual` only accept `(session: AuthSessionContext, rawInput: SettleDeferredAccrualCommand)`. Additionally, the standalone functions `attachExpenseReceipt` and `settleDeferredAccrual` in `log-expense.use-case.ts` (lines 1589-1623) require `useCase: LogExpenseUseCase` as their first parameter.
  Required Fix: Support both the object-command form and the positional signature on `LogExpenseUseCase.attachExpenseReceipt` and `ExpenseService.attachExpenseReceipt` (`(session, command)` and `(session, expenseId, receiptStorageKey, itcReceivableCadMinor?, commandMetadata?)`), and on `LogExpenseUseCase.settleDeferredAccrual` and `ExpenseService.settleDeferredAccrual` (`(session, command)` and `(session, expenseId, settlement?, commandMetadata?)`). Also overload the standalone `attachExpenseReceipt` and `settleDeferredAccrual` functions so they accept either `(session, expenseId, ...)` or `(useCaseOrService, session, expenseId, ...)`.
  Source: spec-review (iteration 0)

- **[F-e34165a2] [HIGH]** Violates `[DESIGN-3]` (`Use the same organization advisory lock key derivation as Issue #8, then acquire entity locks in stable order. All expense, draw, and sweep writers use it, covering cap checks, balance reads, and writes atomically`) and `[DESIGN-4]` (`After locking, check idempotency before applying business rules... Same command returns the original safe result; reuse with different content returns 409 IDEMPOTENCY_KEY_REUSED`). When an already-committed `Idempotency-Key` is reused with a mutated payload that triggers any pre-lock business rule check (e.g., missing receipt, short voucher reason, missing deposit slip, or invalid transfer pair), the use case throws `422` instead of `409 IDEMPOTENCY_KEY_REUSED`.
  Files: src/modules/shared-ops/expenses/log-expense.use-case.ts, src/modules/shared-ops/expenses/record-cash-custody-transfer.use-case.ts, src/modules/shared-ops/expenses/operator-float-subledger.query.ts
  Evidence: 1. In `src/modules/shared-ops/expenses/log-expense.use-case.ts` (lines 341-540, 1132-1137) and `src/modules/shared-ops/expenses/record-cash-custody-transfer.use-case.ts` (lines 154-266), business rule validations (`RECEIPT_REQUIRED` -> 422, `VOUCHER_REASON_REQUIRED` -> 422, `DEPOSIT_SLIP_REQUIRED` -> 422, `INVALID_TRANSFER_PAIR` -> 422, `CFO_OVERRIDE_REASON_REQUIRED` -> 422, `CFO_OVERRIDE_UNAUTHORIZED` -> 403, and memo/draw/piece-rate rules) execute before entering `withTenantTransaction`, before `tx.acquireOrganizationLock(organizationId)`, and before `tx.findCommandReceipt(organizationId, receiptAuditId)`.
2. In `log-expense.use-case.ts` (lines 833-853, 1222-1242) and `record-cash-custody-transfer.use-case.ts` (lines 339-359), the `preflightReplay` transactions execute `evaluateAndValidateInTx`, `validateTargetExpense`, and `validateFundsInTx` (which lock `Vehicle`, `Part`, and `Expense` rows `FOR UPDATE` and read balances/caps) without first calling `await tx.acquireOrganizationLock(organizationId)`. In `operator-float-subledger.query.ts` (line 362), `getEvidencePresignedUrl` also calls `tx.findAndLockExpense` without acquiring the organization advisory lock.
3. In `log-expense.use-case.ts` (lines 836, 875, 1225, 1263, 1447) and `record-cash-custody-transfer.use-case.ts` (lines 342, 380, 511), `hasConflictingRow` only checks one table (`findExpenseByIdempotencyKey` or `findTransferByIdempotencyKey`) instead of both.
  Required Fix: 1. Acquire `await tx.acquireOrganizationLock(organizationId)` at the start of every `preflightReplay` transaction (and in `getEvidencePresignedUrl` if locking `Expense`). 2. Check `tx.findCommandReceipt`, `tx.findExpenseByIdempotencyKey`, and `tx.findTransferByIdempotencyKey` inside the locked transaction (or preflight transaction) and run `resolveIdempotentExpenseReplay` before throwing business-rule validation errors (`RECEIPT_REQUIRED`, `VOUCHER_REASON_REQUIRED`, `DEPOSIT_SLIP_REQUIRED`, `INVALID_TRANSFER_PAIR`, `CFO_OVERRIDE_REASON_REQUIRED`, etc.) so any reuse of a committed `Idempotency-Key` with different action, actor, target, or payload deterministically returns `409 IDEMPOTENCY_KEY_REUSED`.
  Source: spec-review (iteration 0)

- **[F-afdb8dba] [HIGH]** Violates `design.md` Projection semantics (`Gross sale value is active grossCollectedMinor less refund gross amounts... Map persisted reversal SaleTransaction rows by reversesSaleTxId into the calculator's existing refundAdjustment input... Preserve original earned proceeds before applying the signed adjustment, exclude wholly void originals without a paid refund`) and `[CONSUMER-10-REQ-1]` (`DOMAIN-RULES.md` §4.3: `When a SaleTransaction transitions to REFUNDED_OR_CHARGED_BACK (isVoidedOrReversed = true with a linked reversal entry)`). When a bank-settled sale (`cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'`) transitions to `paymentSettlementState = 'REFUNDED_OR_CHARGED_BACK'` (`isVoidedOrReversed = true`) and has a linked reversal `SaleTransaction` (`reversesSaleTxId`, so `hasExplicitAdjustments === true`), it does not match `sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED'` at line 913 and is skipped completely: neither `bankCleared + adjBankRefund` nor `adjFloatRefund` nor `netRealizedCad + adjNetRealized` is applied to `confirmedCorpBankCash`, `operatorFloat`, or `realizedSaleProfitContribution`. In addition, line 879 uses `subtotal + taxOrVat` instead of `grossCollected` when computing `grossSaleValueCadMinor`.
  Files: src/core/domain/working-capital-and-compensation.ts, src/modules/shared-ops/expenses/__tests__/expenses-and-float.test.ts
  Evidence: In `src/core/domain/working-capital-and-compensation.ts` (lines 879 and 912-930):
```ts
const activeGrossForValue = BigInt(subtotal + taxOrVat) + adjGross;
...
} else if (
  sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' &&
  sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'
) {
  ...
  confirmedCorpBankCash += bankCleared + adjBankRefund;
  realizedSaleProfitContribution += BigInt(netRealizedCad) + adjNetRealized;
}
```
  Required Fix: In `src/core/domain/working-capital-and-compensation.ts`: (1) at line 879, compute `const activeGrossForValue = BigInt(grossCollected) + adjGross;`; (2) at line 913, include `(sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' || (hasExplicitAdjustments && sale.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK')) && sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'`, and apply `operatorFloat += adjFloatRefund` alongside `confirmedCorpBankCash += bankCleared + adjBankRefund`; and (3) add a test in `expenses-and-float.test.ts` where the refunded parent bank sale has `paymentSettlementState: PaymentSettlementState.REFUNDED_OR_CHARGED_BACK` and `isVoidedOrReversed: true` with a linked reversal `SaleTransaction`.
  Source: spec-review (iteration 0)

- **[F-90565432] [HIGH]** Migration `0004_expense_allocation_and_idempotency` adds `ON DELETE RESTRICT` composite foreign keys `Expense_organizationId_recipientUserId_fkey`, `Expense_organizationId_custodyHolderUserId_fkey`, and `CashCustodyTransfer_organizationId_custodyHolderUserId_fkey` referencing `shared.OrganizationMembership(organizationId, userId)`. Because the integration test logs an `Expense` and a `CashCustodyTransfer` with `custodyHolderUserId = hunterId`, and those tables are protected from deletion by the `prevent_financial_or_audit_delete` trigger, `afterAll` fails with a PostgreSQL `23503` foreign-key constraint violation when running `pnpm test` with `TEST_DATABASE_URL`.
  Files: src/modules/shared-ops/expenses/__tests__/expenses.integration.test.ts
  Evidence: In `afterAll` (lines 88-108), `DELETE FROM "shared"."OrganizationMembership" WHERE "id" = ANY(${createdMembershipIds}::uuid[])` executes unconditionally without `NOT EXISTS` guards for `shared.Expense` (`recipientUserId`, `custodyHolderUserId`) or `shared.CashCustodyTransfer` (`custodyHolderUserId`), and `DELETE FROM "shared"."User"` omits `NOT EXISTS` guards for remaining `OrganizationMembership`, `SaleTransaction`, and `CashCustodyTransfer` references.
  Required Fix: In `src/modules/shared-ops/expenses/__tests__/expenses.integration.test.ts` `afterAll`, add `AND NOT EXISTS` subqueries checking `shared.Expense` (`recipientUserId` and `custodyHolderUserId`) and `shared.CashCustodyTransfer` (`custodyHolderUserId`) to the `DELETE FROM "shared"."OrganizationMembership"` statement, and add `AND NOT EXISTS` subqueries for `OrganizationMembership`, `SaleTransaction`, and `CashCustodyTransfer` to the `DELETE FROM "shared"."User"` statement.
  Source: quality-review (iteration 0)

- **[F-2daaa36a] [HIGH]** Issue Deliverable 1 and the Design document (`## Module and transaction design`) specify `attachExpenseReceipt(session, expenseId, receiptStorageKey, itcReceivableCadMinor?, commandMetadata)` and `settleDeferredAccrual(session, expenseId, settlement, commandMetadata)` on `ExpenseService` / `log-expense.use-case.ts`. Callers invoking those positional signatures fail at runtime with `INVALID_EXPENSE_INPUT`.
  Files: src/modules/shared-ops/expenses/log-expense.use-case.ts, src/modules/shared-ops/expenses/expenses.repository.ts, src/modules/shared-ops/expenses/expenses.contracts.ts
  Evidence: `LogExpenseUseCase.prototype.attachExpenseReceipt(session, rawInput)` (lines 1066-1079) and `ExpenseService.attachExpenseReceipt` (`expenses.repository.ts` lines 930, 945-946) only accept a 2-argument `(session, commandObject)` signature and throw `400 INVALID_EXPENSE_INPUT` when called with positional arguments `(session, expenseId, receiptStorageKey, itcReceivableCadMinor?, commandMetadata?)`. Similarly, `LogExpenseUseCase.prototype.settleDeferredAccrual` (lines 1377-1398) and `ExpenseService.settleDeferredAccrual` reject positional `(session, expenseId, settlement?, commandMetadata?)` calls, and the standalone exported `attachExpenseReceipt(useCase, session, ...)` (lines 1589-1603) requires `useCase` as its first argument.
  Required Fix: Support overloaded call signatures on `LogExpenseUseCase.prototype.attachExpenseReceipt`, `LogExpenseUseCase.prototype.settleDeferredAccrual`, `ExpenseService.attachExpenseReceipt`, `ExpenseService.settleDeferredAccrual`, and the standalone `attachExpenseReceipt` / `settleDeferredAccrual` helpers so both `(session, commandObject)` and positional `(session, expenseId, ...)` invocations are normalized and accepted.
  Source: quality-review (iteration 0)

- **[F-ceb8db86] [HIGH]** Acquiring entity `FOR UPDATE` locks in `preflightReplay` without first acquiring the organization advisory lock (`pg_advisory_xact_lock`) violates the repository lock ordering contract (`organization advisory lock -> entity FOR UPDATE locks`), creating deadlock risk under concurrent writes. Furthermore, running business-rule validations before checking command receipts causes a reused `Idempotency-Key` with a mutated invalid payload to fail with `422`/`400`/`403` instead of `409 IDEMPOTENCY_KEY_REUSED`.
  Files: src/modules/shared-ops/expenses/log-expense.use-case.ts, src/modules/shared-ops/expenses/record-cash-custody-transfer.use-case.ts
  Evidence: In `LogExpenseUseCase.execute` (lines 833-854), `LogExpenseUseCase.attachExpenseReceipt` (lines 1222-1242), and `RecordCashCustodyTransferUseCase.execute` (lines 339-360), the `preflightReplay` transaction executes `evaluateAndValidateInTx(tx)`, `validateTargetExpense(tx)`, or `validateFundsInTx(tx)` (including `FOR UPDATE` row locks on `Vehicle`, `Part`, and `Expense`) without calling `await tx.acquireOrganizationLock(organizationId)`. In addition, business-rule checks (`RECEIPT_REQUIRED`, `VOUCHER_REASON_REQUIRED`, `DEPOSIT_SLIP_REQUIRED`, `INVALID_TRANSFER_PAIR`, `CFO_OVERRIDE_UNAUTHORIZED`, `CFO_OVERRIDE_REASON_REQUIRED`, etc.) run before acquiring the organization lock and checking `findCommandReceipt`.
  Required Fix: Call `await tx.acquireOrganizationLock(organizationId)` at the beginning of every `preflightReplay` and commit transaction, and evaluate `findCommandReceipt` / `resolveIdempotentExpenseReplay` under the lock before throwing business-rule validation errors.
  Source: quality-review (iteration 0)

- **[F-efc12517] [HIGH]** (1) Computing `grossSaleValueCadMinor` from `subtotal + taxOrVat` rather than `grossCollectedMinor` produces wrong totals whenever `grossCollectedMinor` differs from `subtotalMinor + taxOrVatMinor`. (2) When a `SETTLED_ORIGIN_CORP_BANK` sale is partially or fully refunded via a linked reversal `SaleTransaction` (generating explicit `refundAdjustments`) and the original sale's `paymentSettlementState` is `REFUNDED_OR_CHARGED_BACK`, `isFullImplicitReversal` is `false` (line 790), but line 912 skips the sale—dropping original `bankCleared` proceeds, `adjBankRefund`, `adjFloatRefund`, and `BigInt(netRealizedCad) + adjNetRealized` from corporate bank cash, operator float, and distributable realized profit.
  Files: src/core/domain/working-capital-and-compensation.ts
  Evidence: In `computeSeparatedFinancialSnapshot` (`src/core/domain/working-capital-and-compensation.ts`): (1) line 879 computes `const activeGrossForValue = BigInt(subtotal + taxOrVat) + adjGross;` instead of using `grossCollected`; and (2) lines 912-930 require `sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' && sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'` and do not apply `adjFloatRefund` to `operatorFloat`.
  Required Fix: In `computeSeparatedFinancialSnapshot`, set `activeGrossForValue = BigInt(grossCollected) + adjGross`, update the corporate bank settlement branch condition to include `sale.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK'` when `sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'` (and apply `operatorFloat += adjFloatRefund`), and add unit tests covering `grossCollectedMinor` vs `subtotal + taxOrVat` and refunded `SETTLED_ORIGIN_CORP_BANK` sales with explicit `refundAdjustments`.
  Source: quality-review (iteration 0)

```

Deterministic validation evidence:

```
Validation result: passed (fingerprint: 0024ceca55ec)
```



Complete branch diff against base:

```diff
diff --git a/prisma/schema.prisma b/prisma/schema.prisma
index e3bab1b..8307e33 100644
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -71,6 +71,7 @@ enum ExpenseCategory {
   PROCESSING_SOLVENTS_AND_CONSUMABLES
   EXCISE_STAMP_AND_DUTY
   PARTNER_PROFIT_DRAW                 // Realized-profit partner draw gated by RULE-PAY-002 & RULE-PAY-003
+  PARTNER_TIME_LOG_MEMO               // Zero-cash descriptive partner time log memo (no float/bank/profit impact)
 
   @@schema("shared")
 }
@@ -221,6 +222,10 @@ model OrganizationMembership {
   createdAt          DateTime     @default(now())
   updatedAt          DateTime     @updatedAt
 
+  recipientExpenses    Expense[]             @relation("ExpenseRecipientMembership")
+  custodyHeldExpenses  Expense[]             @relation("ExpenseCustodyHolderMembership")
+  custodyHeldTransfers CashCustodyTransfer[] @relation("TransferCustodyHolderMembership")
+
   @@unique([organizationId, id])
   @@unique([organizationId, userId])
   @@index([userId, isActive])
@@ -298,6 +303,12 @@ model Expense {
   cannabisLot           CannabisLot?         @relation(fields: [organizationId, cannabisLotId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
   loggedByUserId        String               @db.Uuid
   loggedByUser          User                 @relation("LoggedByUser", fields: [loggedByUserId], references: [id])
+  recipientUserId       String?              @db.Uuid
+  recipientMembership   OrganizationMembership? @relation("ExpenseRecipientMembership", fields: [organizationId, recipientUserId], references: [organizationId, userId], onDelete: Restrict, onUpdate: Cascade)
+  floatOffsetAppliedCadMinor Int             @default(0)
+  custodyHolderUserId   String?              @db.Uuid
+  custodyHolderMembership OrganizationMembership? @relation("ExpenseCustodyHolderMembership", fields: [organizationId, custodyHolderUserId], references: [organizationId, userId], onDelete: Restrict, onUpdate: Cascade)
+  idempotencyKey        String?
 
   category                      ExpenseCategory
   vendorName                    String
@@ -329,7 +340,11 @@ model Expense {
   createdAt             DateTime             @default(now())
 
   @@unique([organizationId, id])
+  @@unique([organizationId, idempotencyKey])
   @@index([organizationId, incurredAt])
+  @@index([organizationId, loggedByUserId, receiptVerificationState, createdAt])
+  @@index([organizationId, recipientUserId])
+  @@index([organizationId, custodyHolderUserId])
   @@index([vehicleId])
   @@index([shipmentId])
   @@index([cannabisLotId])
@@ -352,13 +367,18 @@ model CashCustodyTransfer {
   depositSlipStorageKey  String               // Mandatory private R2 key (enforced non-empty via SQL CHECK)
   recordedByUserId       String               @db.Uuid
   recordedByUser         User                 @relation("TransferRecordedByUser", fields: [recordedByUserId], references: [id])
+  custodyHolderUserId    String?              @db.Uuid
+  custodyHolderMembership OrganizationMembership? @relation("TransferCustodyHolderMembership", fields: [organizationId, custodyHolderUserId], references: [organizationId, userId], onDelete: Restrict, onUpdate: Cascade)
+  idempotencyKey         String?
   accountingSyncStatus   AccountingSyncStatus @default(PENDING_SYNC)
   externalGlJournalId    String?
   transferredAt          DateTime             @default(now())
   createdAt              DateTime             @default(now())
 
   @@unique([organizationId, id])
+  @@unique([organizationId, idempotencyKey])
   @@index([organizationId, transferredAt])
+  @@index([organizationId, custodyHolderUserId])
   @@index([marketNode, fromCustodyState, toCustodyState])
   @@index([commercialBankName])
   @@schema("shared")
diff --git a/src/core/domain/__tests__/working-capital-and-compensation.test.ts b/src/core/domain/__tests__/working-capital-and-compensation.test.ts
index 1052ac1..e5fc9c0 100644
--- a/src/core/domain/__tests__/working-capital-and-compensation.test.ts
+++ b/src/core/domain/__tests__/working-capital-and-compensation.test.ts
@@ -1,5 +1,6 @@
 import { describe, expect, it } from 'vitest';
 import {
+  computeDetailedTaxCounters,
   computeNetHstTrustLiabilityCadMinor,
   computeSeparatedFinancialSnapshot,
   evaluatePartnerProfitDraw,
@@ -1467,8 +1468,25 @@ describe('3-Rule Compensation Protocol (RULE-PAY-001 to RULE-PAY-003)', () => {
         },
       ],
     });
-    // Profit pool is 800,000, bank is 800,000, reserve floor is 750,000 -> bank draw max = 50,000
-    const reserveLockedDraw = evaluatePartnerProfitDraw(
+    // Profit pool is 800,000, bank is 800,000, reserve floor is 750,000 -> bank draw max without override = 50,000
+    const reserveBlockedWithoutOverride = evaluatePartnerProfitDraw(
+      {
+        organizationId: ORG_SALVAGE,
+        targetUserId: 'cfo-1',
+        targetUserRole: 'ARCHITECT_CFO',
+        requestedDrawCadMinor: 50_001,
+        snapshotInput: lowBankReserveInput,
+        actor: { actorUserId: 'cfo-1', actorRole: 'ARCHITECT_CFO' },
+      },
+      policy,
+    );
+    expect(reserveBlockedWithoutOverride.allowed).toBe(false);
+    expect(reserveBlockedWithoutOverride.blockingCodes).toContain(
+      'INSUFFICIENT_LIQUID_RESERVE_CAPACITY',
+    );
+
+    // Valid authenticated CFO override with nonblank reason waives ONLY the reserve-floor gate (up to availableWorkingCapitalCadMinor)
+    const reserveOverrideAllowed = evaluatePartnerProfitDraw(
       {
         organizationId: ORG_SALVAGE,
         targetUserId: 'cfo-1',
@@ -1480,15 +1498,311 @@ describe('3-Rule Compensation Protocol (RULE-PAY-001 to RULE-PAY-003)', () => {
           approved: true,
           approvedById: 'cfo-1',
           approverRole: 'ARCHITECT_CFO',
-          reasonNote: 'Attempt to breach bank reserve via CFO override',
+          reasonNote: 'CFO authorized temporary reserve-floor dip for quarterly partner distribution.',
         },
       },
       policy,
     );
-    expect(reserveLockedDraw.allowed).toBe(false);
-    expect(reserveLockedDraw.overrideApplied).toBe(false);
-    expect(reserveLockedDraw.blockingCodes).toContain(
+    expect(reserveOverrideAllowed.allowed).toBe(true);
+    expect(reserveOverrideAllowed.overrideApplied).toBe(true);
+    expect(reserveOverrideAllowed.warnings).toContain(
+      'WORKING_CAPITAL_RESERVE_BREACHED',
+    );
+    expect(reserveOverrideAllowed.cfoOverrideAudit).toEqual({
+      overrideApplied: true,
+      approvedById: 'cfo-1',
+      reasonNote:
+        'CFO authorized temporary reserve-floor dip for quarterly partner distribution.',
+    });
+
+    // Forged non-CFO actor cannot waive reserve floor even with spoofed cfoOverride fields
+    const forgedReserveOverride = evaluatePartnerProfitDraw(
+      {
+        organizationId: ORG_SALVAGE,
+        targetUserId: 'hunter-1',
+        targetUserRole: 'HUNTER_MECHANIC',
+        requestedDrawCadMinor: 50_001,
+        snapshotInput: lowBankReserveInput,
+        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
+        cfoOverride: {
+          approved: true,
+          approvedById: 'cfo-1',
+          approverRole: 'ARCHITECT_CFO',
+          reasonNote: 'Spoofed CFO override by hunter',
+        },
+      },
+      policy,
+    );
+    expect(forgedReserveOverride.allowed).toBe(false);
+    expect(forgedReserveOverride.overrideApplied).toBe(false);
+    expect(forgedReserveOverride.blockingCodes).toContain(
+      'CFO_OVERRIDE_UNAUTHORIZED',
+    );
+    expect(forgedReserveOverride.blockingCodes).toContain(
       'INSUFFICIENT_LIQUID_RESERVE_CAPACITY',
     );
+
+    // Hard liquidity cap: even valid CFO override CANNOT disburse more than actual availableWorkingCapitalCadMinor (protects HST trust!)
+    const hstProtectedInput = makeBaseSnapshotInput({
+      tranches: [
+        {
+          trancheCode: 'TRANCHE_1_LAUNCH',
+          principalCadMinor: 0,
+          unlocked: true,
+        },
+      ],
+      sales: [
+        {
+          id: 's-hst-protected',
+          organizationId: ORG_SALVAGE,
+          marketNode: 'DOMESTIC_ORIGIN',
+          domesticChannel: 'FB_MARKETPLACE_LOCAL',
+          paymentCurrency: 'CAD',
+          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+          subtotalMinor: 800_000,
+          gstHstTaxCadMinor: 104_000,
+          provincialTaxCadMinor: 0,
+          taxOrVatMinor: 104_000,
+          platformFeeMinor: 0,
+          shippingCostMinor: 0,
+          estimatedPlatformFeeTaxCadMinor: 0,
+          itcReceivableCadMinor: 0,
+          isFeeTaxInvoiceVerified: false,
+          grossCollectedMinor: 904_000,
+          netRealizedCadMinor: 800_000,
+          bankClearedCadMinor: 904_000,
+          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
+          cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
+          bankSettledAt: '2026-04-06T12:00:00Z',
+          bankDepositReference: 'INT-3',
+          isVoidedOrReversed: false,
+        },
+      ],
+    });
+    // Profit pool = 800,000 - 104,000 = 696,000; availableWorkingCapital = 904,000 - 104,000 = 800,000
+    // Trying 800,001 exceeds both profit pool AND hard working capital (attempting to spend HST trust)
+    const hardCapDraw = evaluatePartnerProfitDraw(
+      {
+        organizationId: ORG_SALVAGE,
+        targetUserId: 'cfo-1',
+        targetUserRole: 'ARCHITECT_CFO',
+        requestedDrawCadMinor: 800_001,
+        snapshotInput: hstProtectedInput,
+        actor: { actorUserId: 'cfo-1', actorRole: 'ARCHITECT_CFO' },
+        cfoOverride: {
+          approved: true,
+          approvedById: 'cfo-1',
+          approverRole: 'ARCHITECT_CFO',
+          reasonNote: 'Attempt to spend HST trust or exceed actual working capital',
+        },
+      },
+      policy,
+    );
+    expect(hardCapDraw.allowed).toBe(false);
+    expect(hardCapDraw.overrideApplied).toBe(false);
+    expect(hardCapDraw.blockingCodes).toContain(
+      'INSUFFICIENT_REALIZED_PROFIT_POOL',
+    );
+  });
+
+  it('computes DetailedTaxCounters, zero-impact PARTNER_TIME_LOG_MEMO, and mixed float/bank draw split without double deduction', () => {
+    const policy = makePolicy();
+    const counters = computeDetailedTaxCounters({
+      organizationId: ORG_SALVAGE,
+      sales: [
+        {
+          id: 's-1',
+          organizationId: ORG_SALVAGE,
+          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+          gstHstTaxCadMinor: 13_000,
+          itcReceivableCadMinor: 0,
+          isFeeTaxInvoiceVerified: false,
+          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
+        },
+      ],
+      expenses: [
+        {
+          id: 'e-1',
+          organizationId: ORG_SALVAGE,
+          itcReceivableCadMinor: 1_300,
+          receiptVerificationState: 'VERIFIED_RECEIPT',
+          receiptStorageKey: 'org/evidence/1',
+        },
+      ],
+    });
+    expect(counters).toEqual({
+      directTaxCollectedNetOfRefundsCadMinor: 13_000,
+      verifiedItcReceivableCadMinor: 1_300,
+      netHstTrustLiabilityCadMinor: 11_700,
+    });
+
+    const snapshot = computeSeparatedFinancialSnapshot(
+      makeBaseSnapshotInput({
+        sales: [
+          {
+            id: 's-cash-hunter',
+            organizationId: ORG_SALVAGE,
+            marketNode: 'DOMESTIC_ORIGIN',
+            domesticChannel: 'LOCAL_WALK_IN_CASH',
+            paymentCurrency: 'CAD',
+            taxCollectionMode: 'NOT_REGISTERED_NO_TAX',
+            subtotalMinor: 4_000,
+            gstHstTaxCadMinor: 0,
+            taxOrVatMinor: 0,
+            platformFeeMinor: 0,
+            shippingCostMinor: 0,
+            itcReceivableCadMinor: 0,
+            isFeeTaxInvoiceVerified: false,
+            grossCollectedMinor: 4_000,
+            netRealizedCadMinor: 4_000,
+            paymentSettlementState: 'PAYMENT_CONFIRMED',
+            cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
+            custodyHolderUserId: 'hunter-1',
+            isVoidedOrReversed: false,
+          },
+          {
+            id: 's-bank-sale',
+            organizationId: ORG_SALVAGE,
+            marketNode: 'DOMESTIC_ORIGIN',
+            domesticChannel: 'FB_MARKETPLACE_LOCAL',
+            paymentCurrency: 'CAD',
+            taxCollectionMode: 'NOT_REGISTERED_NO_TAX',
+            subtotalMinor: 20_000,
+            gstHstTaxCadMinor: 0,
+            taxOrVatMinor: 0,
+            platformFeeMinor: 0,
+            shippingCostMinor: 0,
+            itcReceivableCadMinor: 0,
+            isFeeTaxInvoiceVerified: false,
+            grossCollectedMinor: 20_000,
+            netRealizedCadMinor: 20_000,
+            bankClearedCadMinor: 20_000,
+            paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
+            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
+            bankSettledAt: '2026-04-06T12:00:00Z',
+            bankDepositReference: 'DEP-1',
+            isVoidedOrReversed: false,
+          },
+        ],
+        expenses: [
+          {
+            id: 'memo-1',
+            organizationId: ORG_SALVAGE,
+            category: 'PARTNER_TIME_LOG_MEMO',
+            currencyOriginal: 'CAD',
+            amountOriginalMinor: 0,
+            amountCadMinor: 0,
+            itcReceivableCadMinor: 0,
+            paidFromCashCustody: null,
+            isDeferredIntercompanyAccrual: false,
+            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
+          },
+          {
+            id: 'draw-split-1',
+            organizationId: ORG_SALVAGE,
+            category: 'PARTNER_PROFIT_DRAW',
+            currencyOriginal: 'CAD',
+            amountOriginalMinor: 10_000,
+            amountCadMinor: 10_000,
+            floatOffsetAppliedCadMinor: 4_000,
+            recipientUserId: 'hunter-1',
+            custodyHolderUserId: 'hunter-1',
+            loggedByUserId: 'cfo-1',
+            itcReceivableCadMinor: 0,
+            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
+            isDeferredIntercompanyAccrual: false,
+            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
+          },
+        ],
+      }),
+      policy,
+    );
+    // Float: 4,000 - 4,000 = 0; Bank: 2,200,000 + 20,000 - 6,000 = 2,214,000; Profit: 24,000 - 10,000 = 14,000
+    expect(snapshot.runningOperatorFloatCadMinor).toBe(0);
+    expect(snapshot.operatorFloatByUserId['hunter-1']).toBe(0);
+    expect(snapshot.confirmedCorpBankCashCadMinor).toBe(2_214_000);
+    expect(snapshot.distributableRealizedProfitPoolCadMinor).toBe(14_000);
+  });
+
+  it('uses grossCollectedMinor for grossSaleValueCadMinor and normalizes REFUNDED_OR_CHARGED_BACK bank-settled sales with explicit refundAdjustments', () => {
+    const policy = makePolicy();
+
+    const snapshot = computeSeparatedFinancialSnapshot(
+      makeBaseSnapshotInput({
+        sales: [
+          {
+            id: 'sale-bank-with-shipping',
+            organizationId: ORG_SALVAGE,
+            marketNode: 'DOMESTIC_ORIGIN',
+            domesticChannel: 'FB_MARKETPLACE_LOCAL',
+            paymentCurrency: 'CAD',
+            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+            subtotalMinor: 10_000,
+            gstHstTaxCadMinor: 1_300,
+            taxOrVatMinor: 1_300,
+            platformFeeMinor: 0,
+            shippingCostMinor: 1_500,
+            itcReceivableCadMinor: 0,
+            isFeeTaxInvoiceVerified: false,
+            // Buyer paid $128.00 ($100 part + $13 tax + $15 shipping)
+            grossCollectedMinor: 12_800,
+            netRealizedCadMinor: 12_800,
+            bankClearedCadMinor: 12_800,
+            paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
+            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
+            bankSettledAt: '2026-04-06T12:00:00Z',
+            bankDepositReference: 'DEP-SHIP-1',
+            isVoidedOrReversed: false,
+          },
+          {
+            id: 'sale-bank-refunded-explicit',
+            organizationId: ORG_SALVAGE,
+            marketNode: 'DOMESTIC_ORIGIN',
+            domesticChannel: 'FB_MARKETPLACE_LOCAL',
+            paymentCurrency: 'CAD',
+            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+            subtotalMinor: 20_000,
+            gstHstTaxCadMinor: 2_600,
+            taxOrVatMinor: 2_600,
+            platformFeeMinor: 0,
+            shippingCostMinor: 0,
+            itcReceivableCadMinor: 0,
+            isFeeTaxInvoiceVerified: false,
+            grossCollectedMinor: 22_600,
+            netRealizedCadMinor: 20_000,
+            bankClearedCadMinor: 22_600,
+            paymentSettlementState: 'REFUNDED_OR_CHARGED_BACK',
+            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
+            bankSettledAt: '2026-04-06T12:00:00Z',
+            bankDepositReference: 'DEP-REF-1',
+            isVoidedOrReversed: true,
+          },
+        ],
+        refundAdjustments: [
+          {
+            id: 'adj-bank-full-refund',
+            organizationId: ORG_SALVAGE,
+            originalSaleId: 'sale-bank-refunded-explicit',
+            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+            subtotalAdjustmentMinor: -20_000,
+            gstHstAdjustmentCadMinor: -2_600,
+            provincialTaxAdjustmentCadMinor: 0,
+            itcAdjustmentCadMinor: 0,
+            grossAdjustmentMinor: -22_600,
+            netRealizedCadAdjustmentMinor: -20_000,
+            refundSettlementAccount: 'CORP_BANK',
+          },
+        ],
+      }),
+      policy,
+    );
+
+    expect(snapshot.accountingRevenueCadMinor).toBe(10_000);
+    expect(snapshot.grossSaleValueCadMinor).toBe(12_800);
+    // Bank: 2,200,000 + 12,800 + (22,600 - 22,600) = 2,212,800
+    expect(snapshot.confirmedCorpBankCashCadMinor).toBe(2_212_800);
+    expect(snapshot.netHstTrustLiabilityCadMinor).toBe(1_300);
+    // Profit: (12,800) + (20,000 - 20,000) - 1,300 = 11,500
+    expect(snapshot.distributableRealizedProfitPoolCadMinor).toBe(11_500);
   });
 });
diff --git a/src/core/domain/index.ts b/src/core/domain/index.ts
index bda5c71..27241a2 100644
--- a/src/core/domain/index.ts
+++ b/src/core/domain/index.ts
@@ -107,12 +107,14 @@ export {
 } from './vault-pricing-and-checkout-corridor';
 
 export {
+  computeDetailedTaxCounters,
   computeNetHstTrustLiabilityCadMinor,
   computeSeparatedFinancialSnapshot,
   evaluatePartnerProfitDraw,
   evaluatePieceRatePayout,
   evaluateTrancheMilestoneEligibility,
   evaluateWorkingCapitalGate,
+  type DetailedTaxCounters,
   type FinancialSnapshotInput,
   type LoanTrancheStatusRow,
   type NetHstTrustLiabilityInput,
diff --git a/src/core/domain/working-capital-and-compensation.ts b/src/core/domain/working-capital-and-compensation.ts
index 09cd9f3..9a7c8f4 100644
--- a/src/core/domain/working-capital-and-compensation.ts
+++ b/src/core/domain/working-capital-and-compensation.ts
@@ -78,6 +78,12 @@ export interface NetHstTrustLiabilityInput {
   readonly refundAdjustments?: readonly TaxRefundAdjustmentRow[];
 }
 
+export interface DetailedTaxCounters {
+  readonly directTaxCollectedNetOfRefundsCadMinor: number;
+  readonly verifiedItcReceivableCadMinor: number;
+  readonly netHstTrustLiabilityCadMinor: number;
+}
+
 export interface LoanTrancheStatusRow {
   readonly trancheCode: string;
   readonly principalCadMinor: number;
@@ -170,6 +176,8 @@ export interface SnapshotExpenseRow {
   readonly itcReceivableCadMinor: number;
   readonly paidFromCashCustody?: CashCustodyState | null;
   readonly custodyHolderUserId?: string | null;
+  readonly recipientUserId?: string | null;
+  readonly floatOffsetAppliedCadMinor?: number;
   readonly loggedByUserId?: string | null;
   readonly isDeferredIntercompanyAccrual: boolean;
   readonly accrualSettledAt?: string | Date | null;
@@ -389,20 +397,9 @@ function resolveDirectGstHstForSale(sale: TaxSaleLedgerRow): number {
   return assertNonNegativeSafeInt(sale.gstHstTaxCadMinor, 'gstHstTaxCadMinor');
 }
 
-/**
- * Pure CRA GST/HST trust liability calculator (`RULE-TAX-HST-01` / `FIX 06`).
- *
- * Strictly ring-fences:
- * - Direct seller-collected CRA GST/HST (`DIRECT_SELLER_COLLECTED`), excluding standalone
- *   provincial QST/PST (`provincialTaxCadMinor`) and marketplace-remitted buyer taxes.
- * - Verified seller-fee tax ITCs (`isFeeTaxInvoiceVerified === true` + non-empty storage key)
- *   and `VERIFIED_RECEIPT` expense ITCs, ignoring unverified estimates even if populated.
- * - Normalizes `refundAdjustments` against `REFUNDED_OR_CHARGED_BACK` sales without double-deducting.
- * - Clamps at `0` so excess ITC claims never fabricate spendable bank working capital.
- */
-export function computeNetHstTrustLiabilityCadMinor(
+export function computeDetailedTaxCounters(
   input: NetHstTrustLiabilityInput,
-): number {
+): DetailedTaxCounters {
   const organizationId = assertNonEmptyTrimmedString(
     input.organizationId,
     'INVALID_INPUT',
@@ -549,14 +546,47 @@ export function computeNetHstTrustLiabilityCadMinor(
     verifiedItcTotal += BigInt(exp.isReversalEntry ? -expItc : expItc);
   }
 
-  if (directTaxCollected <= 0n || directTaxCollected <= verifiedItcTotal) {
-    return 0;
-  }
+  const directClamped =
+    directTaxCollected > 0n
+      ? bigIntToSafeNumber(
+          directTaxCollected,
+          'directTaxCollectedNetOfRefundsCadMinor',
+        )
+      : 0;
+  const itcClamped =
+    verifiedItcTotal > 0n
+      ? bigIntToSafeNumber(verifiedItcTotal, 'verifiedItcReceivableCadMinor')
+      : 0;
+  const netLiability =
+    directTaxCollected <= 0n || directTaxCollected <= verifiedItcTotal
+      ? 0
+      : bigIntToSafeNumber(
+          directTaxCollected - verifiedItcTotal,
+          'netHstTrustLiabilityCadMinor',
+        );
 
-  return bigIntToSafeNumber(
-    directTaxCollected - verifiedItcTotal,
-    'netHstTrustLiabilityCadMinor',
-  );
+  return {
+    directTaxCollectedNetOfRefundsCadMinor: directClamped,
+    verifiedItcReceivableCadMinor: itcClamped,
+    netHstTrustLiabilityCadMinor: netLiability,
+  };
+}
+
+/**
+ * Pure CRA GST/HST trust liability calculator (`RULE-TAX-HST-01` / `FIX 06`).
+ *
+ * Strictly ring-fences:
+ * - Direct seller-collected CRA GST/HST (`DIRECT_SELLER_COLLECTED`), excluding standalone
+ *   provincial QST/PST (`provincialTaxCadMinor`) and marketplace-remitted buyer taxes.
+ * - Verified seller-fee tax ITCs (`isFeeTaxInvoiceVerified === true` + non-empty storage key)
+ *   and `VERIFIED_RECEIPT` expense ITCs, ignoring unverified estimates even if populated.
+ * - Normalizes `refundAdjustments` against `REFUNDED_OR_CHARGED_BACK` sales without double-deducting.
+ * - Clamps at `0` so excess ITC claims never fabricate spendable bank working capital.
+ */
+export function computeNetHstTrustLiabilityCadMinor(
+  input: NetHstTrustLiabilityInput,
+): number {
+  return computeDetailedTaxCounters(input).netHstTrustLiabilityCadMinor;
 }
 
 function addUserFloatDelta(
@@ -846,7 +876,7 @@ export function computeSeparatedFinancialSnapshot(
     }
 
     const activeSubtotal = BigInt(subtotal) + adjSubtotal;
-    const activeGrossForValue = BigInt(subtotal + taxOrVat) + adjGross;
+    const activeGrossForValue = BigInt(grossCollected) + adjGross;
     if (sale.paymentCurrency === 'CAD') {
       accountingRevenue += activeSubtotal;
       grossSaleValue += activeGrossForValue > 0n ? activeGrossForValue : 0n;
@@ -880,7 +910,9 @@ export function computeSeparatedFinancialSnapshot(
       confirmedCorpBankCash += adjBankRefund;
       realizedSaleProfitContribution += BigInt(netRealizedCad) + adjNetRealized;
     } else if (
-      sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' &&
+      (sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' ||
+        (hasExplicitAdjustments &&
+          sale.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK')) &&
       sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'
     ) {
       const bankCleared =
@@ -896,6 +928,7 @@ export function computeSeparatedFinancialSnapshot(
             (sale.shippingDeductedFromPayout === true ? BigInt(shippingCost) : 0n);
 
       confirmedCorpBankCash += bankCleared + adjBankRefund;
+      operatorFloat += adjFloatRefund;
       realizedSaleProfitContribution += BigInt(netRealizedCad) + adjNetRealized;
     }
   }
@@ -940,6 +973,36 @@ export function computeSeparatedFinancialSnapshot(
       exp.amountCadMinor,
       `expense[${exp.id}].amountCadMinor`,
     );
+    const floatOffset = assertNonNegativeSafeInt(
+      exp.floatOffsetAppliedCadMinor ?? 0,
+      `expense[${exp.id}].floatOffsetAppliedCadMinor`,
+    );
+    if (floatOffset > amt) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Expense "${exp.id}" floatOffsetAppliedCadMinor (${floatOffset}) exceeds amountCadMinor (${amt}).`,
+      );
+    }
+    if (floatOffset > 0 && exp.category !== 'PARTNER_PROFIT_DRAW') {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Non-draw expense "${exp.id}" cannot carry floatOffsetAppliedCadMinor.`,
+      );
+    }
+    if (exp.category === 'PARTNER_TIME_LOG_MEMO') {
+      if (
+        amt !== 0 ||
+        (exp.amountOriginalMinor ?? 0) !== 0 ||
+        exp.itcReceivableCadMinor !== 0 ||
+        exp.isDeferredIntercompanyAccrual
+      ) {
+        throw new DomainRuleError(
+          'INVALID_INPUT',
+          `PARTNER_TIME_LOG_MEMO "${exp.id}" must carry zero financial amounts and zero deferral.`,
+        );
+      }
+      continue;
+    }
     if (exp.currencyOriginal !== 'CAD' && amt === 0 && (exp.amountOriginalMinor ?? 0) > 0) {
       throw new DomainRuleError(
         'UNCONVERTED_NON_CAD_AMOUNT',
@@ -963,11 +1026,25 @@ export function computeSeparatedFinancialSnapshot(
       continue;
     }
 
-    if (exp.paidFromCashCustody === 'HELD_IN_OPERATOR_FLOAT') {
+    if (exp.category === 'PARTNER_PROFIT_DRAW' && floatOffset > 0) {
+      const signedFloatOffset = BigInt(
+        exp.isReversalEntry ? -floatOffset : floatOffset,
+      );
+      const signedBankRemainder = signedAmt - signedFloatOffset;
+      operatorFloat -= signedFloatOffset;
+      addUserFloatDelta(
+        userFloatMap,
+        exp.custodyHolderUserId ?? exp.recipientUserId ?? exp.loggedByUserId,
+        -signedFloatOffset,
+      );
+      if (signedBankRemainder !== 0n) {
+        confirmedCorpBankCash -= signedBankRemainder;
+      }
+    } else if (exp.paidFromCashCustody === 'HELD_IN_OPERATOR_FLOAT') {
       operatorFloat -= signedAmt;
       addUserFloatDelta(
         userFloatMap,
-        exp.custodyHolderUserId ?? exp.loggedByUserId,
+        exp.custodyHolderUserId ?? exp.recipientUserId ?? exp.loggedByUserId,
         -signedAmt,
       );
     } else {
@@ -1357,8 +1434,12 @@ export function evaluatePieceRatePayout(
  * Pure `RULE-PAY-002` & `RULE-PAY-003` evaluator for `PARTNER_PROFIT_DRAW`:
  * - Ring-fences loan tranches, pending receivables, accrued expenses, and `NetHstTrustLiability_CAD`.
  * - Offsets `HUNTER_MECHANIC` draws strictly against that operator's own float first.
- * - Caps bank disbursement by `AvailableWorkingCapital_CAD - minCashReserveFloorCadMinor`.
- * - Non-overridable (`cfoOverride` cannot bypass profit pool, verified-tax, or bank reserve invariants).
+ * - Caps bank disbursement by `max(0, AvailableWorkingCapital_CAD - minCashReserveFloorCadMinor)`.
+ * - Narrow reserve-floor exception: an authenticated `ARCHITECT_CFO` (`input.actor`) with a
+ *   non-blank `cfoOverride.reasonNote` may waive ONLY the `minCashReserveFloorCadMinor` reserve
+ *   gate. Profit-pool sufficiency (`distributableRealizedProfitPoolCadMinor`), hard liquidity
+ *   (`max(0, availableWorkingCapitalCadMinor)` protecting `NetHstTrustLiability_CAD`), and
+ *   caller-supplied role/ID forgery checks remain strictly non-overridable.
  */
 export function evaluatePartnerProfitDraw(
   input: PartnerProfitDrawInput,
@@ -1410,6 +1491,10 @@ export function evaluatePartnerProfitDraw(
       'maxBankDisbursementAllowedCadMinor',
     ),
   );
+  const hardBankWorkingCapitalCapCadMinor = Math.max(
+    0,
+    snapshot.availableWorkingCapitalCadMinor,
+  );
 
   const rawTargetFloat =
     input.targetOperatorFloatOverrideCadMinor !== undefined
@@ -1435,14 +1520,59 @@ export function evaluatePartnerProfitDraw(
   const blockingCodes: DomainRuleErrorCode[] = [];
   const warnings: string[] = [];
 
-  if (requestedDrawCadMinor > profitPool) {
+  const profitPoolInsufficient = requestedDrawCadMinor > profitPool;
+  const exceedsHardWorkingCapital =
+    netCashDisbursedFromBankCadMinor > hardBankWorkingCapitalCapCadMinor;
+  const breachesReserveFloorOnly =
+    !exceedsHardWorkingCapital &&
+    netCashDisbursedFromBankCadMinor > maxBankDisbursementAllowedCadMinor;
+
+  if (profitPoolInsufficient) {
     blockingCodes.push('INSUFFICIENT_REALIZED_PROFIT_POOL');
   }
-  if (netCashDisbursedFromBankCadMinor > maxBankDisbursementAllowedCadMinor) {
+  if (exceedsHardWorkingCapital) {
     blockingCodes.push('INSUFFICIENT_LIQUID_RESERVE_CAPACITY');
   }
 
-  if (input.cfoOverride?.approved === true && blockingCodes.length > 0) {
+  const overrideEval = evaluateCfoOverride(input.actor, input.cfoOverride);
+  const actorIsAuthenticatedCfo =
+    input.actor?.actorRole === 'ARCHITECT_CFO' &&
+    isNonEmptyTrimmedString(input.actor.actorUserId);
+  const trustedCfoOverrideValid =
+    overrideEval.requested &&
+    overrideEval.valid &&
+    actorIsAuthenticatedCfo &&
+    overrideEval.audit.approvedById === input.actor!.actorUserId.trim();
+
+  if (overrideEval.requested && !trustedCfoOverrideValid) {
+    const failureCode =
+      overrideEval.failureCode ?? 'CFO_OVERRIDE_UNAUTHORIZED';
+    if (!blockingCodes.includes(failureCode)) {
+      blockingCodes.push(failureCode);
+    }
+  }
+
+  let overrideApplied = false;
+  let cfoOverrideAudit = {
+    overrideApplied: false,
+    approvedById: null as string | null,
+    reasonNote: null as string | null,
+  };
+
+  if (breachesReserveFloorOnly) {
+    if (trustedCfoOverrideValid && !profitPoolInsufficient) {
+      overrideApplied = true;
+      cfoOverrideAudit = overrideEval.audit;
+      warnings.push('WORKING_CAPITAL_RESERVE_BREACHED');
+    } else {
+      blockingCodes.push('INSUFFICIENT_LIQUID_RESERVE_CAPACITY');
+    }
+  }
+
+  if (
+    overrideEval.requested &&
+    (profitPoolInsufficient || exceedsHardWorkingCapital)
+  ) {
     warnings.push('CFO_OVERRIDE_IGNORED_FOR_SOLVENCY_INVARIANT');
   }
 
@@ -1450,12 +1580,8 @@ export function evaluatePartnerProfitDraw(
     allowed: blockingCodes.length === 0,
     blockingCodes,
     warnings,
-    overrideApplied: false,
-    cfoOverrideAudit: {
-      overrideApplied: false,
-      approvedById: null,
-      reasonNote: null,
-    },
+    overrideApplied,
+    cfoOverrideAudit,
     requestedDrawCadMinor,
     distributableRealizedProfitPoolCadMinor: profitPool,
     availableWorkingCapitalCadMinor: snapshot.availableWorkingCapitalCadMinor,
diff --git a/src/modules/cfo-subledger/financial-snapshot.query.ts b/src/modules/cfo-subledger/financial-snapshot.query.ts
index ba52ef0..8e8073a 100644
--- a/src/modules/cfo-subledger/financial-snapshot.query.ts
+++ b/src/modules/cfo-subledger/financial-snapshot.query.ts
@@ -1,141 +1,347 @@
-import type { Prisma } from '@prisma/client';
+import type {
+  CashCustodyState,
+  CurrencyCode,
+  DomesticSaleChannel,
+  ExpenseCategory,
+  ExportSaleChannel,
+  InventoryAvailabilityState,
+  PartCustodyState,
+  PaymentSettlementState,
+  Prisma,
+  ReceiptVerificationState,
+  SaleMarketNode,
+  TaxCollectionMode,
+} from '@prisma/client';
 import {
   bigIntToSafeNumber,
+  computeDetailedTaxCounters,
   computeSeparatedFinancialSnapshot,
   DomainRuleError,
   type FinancialSnapshotInput,
   type SeparatedFinancialSnapshot,
   type SnapshotCashTransferRow,
+  type SnapshotDonorVehicleSummaryRow,
   type SnapshotExpenseRow,
+  type SnapshotRefundAdjustmentRow,
   type SnapshotRepatriationRow,
   type SnapshotSaleRow,
   type SnapshotScrapRow,
   type WorkingCapitalPolicySlice,
 } from '@/core/domain';
 
+const ALLOWLISTED_DIRECT_DONOR_EXPENSE_CATEGORIES: ReadonlySet<ExpenseCategory> =
+  new Set<ExpenseCategory>([
+    'AUCTION_BUYER_FEE',
+    'TOWING_AND_RECOVERY',
+    'YARD_STRIPPER_PIECE_RATE',
+    'RAMSAYVILLE_SHOP_LABOR',
+    'REFRIGERANT_EVAC_AND_PREP',
+  ]);
+
+export interface PersistedSaleLedgerRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly marketNode: SaleMarketNode;
+  readonly domesticChannel: DomesticSaleChannel | null;
+  readonly exportChannel: ExportSaleChannel | null;
+  readonly paymentCurrency: CurrencyCode;
+  readonly taxCollectionMode: TaxCollectionMode;
+  readonly subtotalMinor: number;
+  readonly taxOrVatMinor: number;
+  readonly buyerTaxRemittedByPlatformMinor: number | null;
+  readonly platformFeeMinor: number;
+  readonly shippingCostMinor: number;
+  readonly estimatedPlatformFeeTaxCadMinor: number;
+  readonly itcReceivableCadMinor: number;
+  readonly isFeeTaxInvoiceVerified: boolean;
+  readonly feeTaxInvoiceStorageKey: string | null;
+  readonly grossCollectedMinor: number;
+  readonly netRealizedCadMinor: number;
+  readonly paymentSettlementState: PaymentSettlementState;
+  readonly cashCustodyState: CashCustodyState;
+  readonly bankSettledAt: Date | string | null;
+  readonly bankDepositReference: string | null;
+  readonly soldByUserId: string;
+  readonly isVoidedOrReversed: boolean;
+  readonly reversesSaleTxId?: string | null;
+  readonly brokerCommissionMinor?: number;
+  readonly isBrokerCommissionDeductedAtCounter?: boolean;
+}
+
+export interface PersistedScrapLedgerRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly vehicleId: string;
+  readonly payoutCadMinor: number;
+  readonly cashCustodyState: CashCustodyState;
+  readonly recordedByUserId: string;
+}
+
+export interface PersistedCashTransferLedgerRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly marketNode: SaleMarketNode;
+  readonly fromCustodyState: CashCustodyState;
+  readonly toCustodyState: CashCustodyState;
+  readonly currency: CurrencyCode;
+  readonly amountMinor: number;
+  readonly equivalentCadMinor: number;
+  readonly depositSlipStorageKey: string;
+  readonly recordedByUserId: string;
+  readonly custodyHolderUserId?: string | null;
+}
+
+export interface PersistedCurrencySettlementRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly targetCurrency: CurrencyCode;
+  readonly totalTargetSettledMinor: bigint | number;
+  readonly settledInCanadaAt: Date | string | null;
+}
+
+export interface PersistedExpenseLedgerRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly category: ExpenseCategory;
+  readonly vehicleId: string | null;
+  readonly currencyOriginal: CurrencyCode;
+  readonly amountOriginalMinor: number;
+  readonly amountCadMinor: number;
+  readonly itcReceivableCadMinor: number;
+  readonly paidFromCashCustody: CashCustodyState | null;
+  readonly loggedByUserId: string;
+  readonly recipientUserId?: string | null;
+  readonly floatOffsetAppliedCadMinor?: number;
+  readonly custodyHolderUserId?: string | null;
+  readonly isDeferredIntercompanyAccrual: boolean;
+  readonly accrualSettledAt: Date | string | null;
+  readonly receiptVerificationState: ReceiptVerificationState;
+  readonly receiptStorageKey: string | null;
+  readonly isReversalEntry: boolean;
+  readonly reversesExpenseId?: string | null;
+}
+
+export interface PersistedDonorVehicleRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly actualPurchasePriceCadMinor: number;
+  readonly scrapRecoveryCadMinor: number;
+}
+
+export interface PersistedDonorPartRow {
+  readonly id: string;
+  readonly donorVehicleId: string;
+  readonly compBaselineCadMinor: number | null;
+  readonly availabilityState: InventoryAvailabilityState;
+  readonly custodyState: PartCustodyState;
+}
+
+export interface PersistedSalePartItemRow {
+  readonly saleTransactionId: string;
+  readonly partId: string;
+  readonly soldPriceMinor: number;
+  readonly isActiveSale: boolean;
+}
+
+export interface PersistedTaxAndLiquidityCounters {
+  readonly directTaxCollectedNetOfRefundsCadMinor: number;
+  readonly buyerTaxRemittedByPlatformCadMinor: number | null;
+  readonly hasUnknownMarketplaceBuyerTax: boolean;
+  readonly unverifiedPlatformFeeTaxAccruedCadMinor: number;
+  readonly verifiedItcReceivableCadMinor: number;
+  readonly netHstTrustLiabilityCadMinor: number;
+}
+
 export interface PersistedLedgerProjection {
   readonly snapshotInput: FinancialSnapshotInput;
   readonly snapshot: SeparatedFinancialSnapshot;
+  readonly taxCounters: PersistedTaxAndLiquidityCounters;
+  readonly destinationVaultCashByCurrency: Readonly<Record<string, number>>;
+}
+
+function normalizeSignedMagnitude(
+  value: number,
+  expectedDirection: 'NON_NEGATIVE' | 'NON_POSITIVE',
+  fieldLabel: string,
+): number {
+  if (!Number.isSafeInteger(value)) {
+    throw new DomainRuleError(
+      'INVALID_MONETARY_AMOUNT',
+      `${fieldLabel} must be a finite safe integer.`,
+    );
+  }
+  if (expectedDirection === 'NON_NEGATIVE' && value < 0) {
+    throw new DomainRuleError(
+      'INVALID_INPUT',
+      `${fieldLabel} has mixed sign inside reversal SaleTransaction.`,
+    );
+  }
+  if (expectedDirection === 'NON_POSITIVE' && value > 0) {
+    throw new DomainRuleError(
+      'INVALID_INPUT',
+      `${fieldLabel} has mixed sign inside reversal SaleTransaction.`,
+    );
+  }
+  return -Math.abs(value);
 }
 
 /**
- * Reads persisted ledger tables within an active `withTenantTransaction` (`tx`)
- * and delegates all 7-metric liquidity, pending-receivable, float, and CRA HST
- * trust calculations to `computeSeparatedFinancialSnapshot`.
+ * Pure normalization contract converting persisted database rows (including linked
+ * `SaleTransaction.reversesSaleTxId` reversals, donor vehicle/part projections, and
+ * tax/ITC counters) into `SeparatedFinancialSnapshot` inputs.
+ *
+ * Contract for downstream checkout consumers (Issue #10):
+ * - A persisted reversal `SaleTransaction` MUST set `reversesSaleTxId` to a non-reversal
+ *   parent sale in the same organization with matching `marketNode`, `paymentCurrency`, and
+ *   `taxCollectionMode`, and MUST NOT set `isVoidedOrReversed = true` on the reversal row itself.
+ * - Reversal monetary fields (`subtotalMinor`, `taxOrVatMinor`, `grossCollectedMinor`,
+ *   `netRealizedCadMinor`, `itcReceivableCadMinor`) may be stored as non-negative magnitudes
+ *   or signed negative integers (never mixed signs within one row) and are normalized into
+ *   negative `SnapshotRefundAdjustmentRow` values attributed to the reversal's custody/settlement state.
  */
-export async function querySeparatedFinancialSnapshot(
-  tx: Prisma.TransactionClient,
-  organizationId: string,
-  policy: WorkingCapitalPolicySlice,
-): Promise<SeparatedFinancialSnapshot> {
-  const projection = await loadPersistedFinancialSnapshot(
-    tx,
-    organizationId,
-    policy,
+export function buildPersistedLedgerProjection(params: {
+  readonly organizationId: string;
+  readonly policy: WorkingCapitalPolicySlice;
+  readonly saleRows: readonly PersistedSaleLedgerRow[];
+  readonly scrapRows: readonly PersistedScrapLedgerRow[];
+  readonly transferRows: readonly PersistedCashTransferLedgerRow[];
+  readonly settlementRows: readonly PersistedCurrencySettlementRow[];
+  readonly expenseRows: readonly PersistedExpenseLedgerRow[];
+  readonly vehicleRows?: readonly PersistedDonorVehicleRow[];
+  readonly partRows?: readonly PersistedDonorPartRow[];
+  readonly salePartItemRows?: readonly PersistedSalePartItemRow[];
+}): PersistedLedgerProjection {
+  const normalizedOrgId = params.organizationId.toLowerCase();
+  const baseSaleRows: PersistedSaleLedgerRow[] = [];
+  const reversalRows: PersistedSaleLedgerRow[] = [];
+
+  for (const row of params.saleRows) {
+    if (row.organizationId.toLowerCase() !== normalizedOrgId) {
+      throw new DomainRuleError(
+        'ORGANIZATION_MISMATCH',
+        `SaleTransaction "${row.id}" belongs to a different organization.`,
+      );
+    }
+    if (row.reversesSaleTxId) {
+      reversalRows.push(row);
+    } else {
+      baseSaleRows.push(row);
+    }
+  }
+
+  const baseSaleMap = new Map(
+    baseSaleRows.map((row) => [row.id.toLowerCase(), row]),
   );
-  return projection.snapshot;
-}
 
-export async function loadPersistedFinancialSnapshot(
-  tx: Prisma.TransactionClient,
-  organizationId: string,
-  policy: WorkingCapitalPolicySlice,
-): Promise<PersistedLedgerProjection> {
-  const [saleRows, scrapRows, transferRows, settlementRows, expenseRows] =
-    await Promise.all([
-      tx.saleTransaction.findMany({
-        where: { organizationId },
-        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          marketNode: true,
-          domesticChannel: true,
-          exportChannel: true,
-          paymentCurrency: true,
-          taxCollectionMode: true,
-          subtotalMinor: true,
-          taxOrVatMinor: true,
-          buyerTaxRemittedByPlatformMinor: true,
-          platformFeeMinor: true,
-          shippingCostMinor: true,
-          estimatedPlatformFeeTaxCadMinor: true,
-          itcReceivableCadMinor: true,
-          isFeeTaxInvoiceVerified: true,
-          feeTaxInvoiceStorageKey: true,
-          grossCollectedMinor: true,
-          netRealizedCadMinor: true,
-          paymentSettlementState: true,
-          cashCustodyState: true,
-          bankSettledAt: true,
-          bankDepositReference: true,
-          soldByUserId: true,
-          isVoidedOrReversed: true,
-        },
-      }),
-      tx.scrapComponentLog.findMany({
-        where: { organizationId },
-        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          vehicleId: true,
-          payoutCadMinor: true,
-          cashCustodyState: true,
-          recordedByUserId: true,
-        },
-      }),
-      tx.cashCustodyTransfer.findMany({
-        where: { organizationId },
-        orderBy: [{ transferredAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          marketNode: true,
-          fromCustodyState: true,
-          toCustodyState: true,
-          currency: true,
-          amountMinor: true,
-          equivalentCadMinor: true,
-          depositSlipStorageKey: true,
-          recordedByUserId: true,
-        },
-      }),
-      tx.currencySettlement.findMany({
-        where: { organizationId },
-        orderBy: [{ initiatedAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          targetCurrency: true,
-          totalTargetSettledMinor: true,
-          settledInCanadaAt: true,
-        },
-      }),
-      tx.expense.findMany({
-        where: { organizationId },
-        orderBy: [{ incurredAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          category: true,
-          vehicleId: true,
-          currencyOriginal: true,
-          amountOriginalMinor: true,
-          amountCadMinor: true,
-          itcReceivableCadMinor: true,
-          paidFromCashCustody: true,
-          loggedByUserId: true,
-          isDeferredIntercompanyAccrual: true,
-          accrualSettledAt: true,
-          receiptVerificationState: true,
-          receiptStorageKey: true,
-          isReversalEntry: true,
-        },
-      }),
-    ]);
+  const refundAdjustments: SnapshotRefundAdjustmentRow[] = [];
+  const reversalsByOriginalSaleId = new Map<string, PersistedSaleLedgerRow[]>();
+
+  for (const rev of reversalRows) {
+    const revId = rev.id.toLowerCase();
+    const targetId = rev.reversesSaleTxId!.toLowerCase();
+    if (revId === targetId) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `SaleTransaction "${rev.id}" cannot reverse itself.`,
+      );
+    }
+    if (rev.isVoidedOrReversed) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Reversal SaleTransaction "${rev.id}" cannot itself be voided or reversed.`,
+      );
+    }
+    const original = baseSaleMap.get(targetId);
+    if (!original) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Reversal SaleTransaction "${rev.id}" references missing or chained sale "${rev.reversesSaleTxId}".`,
+      );
+    }
+    if (
+      rev.marketNode !== original.marketNode ||
+      rev.paymentCurrency !== original.paymentCurrency ||
+      rev.taxCollectionMode !== original.taxCollectionMode
+    ) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Reversal SaleTransaction "${rev.id}" mismatches original sale node, currency, or tax collection mode.`,
+      );
+    }
 
-  const sales: SnapshotSaleRow[] = saleRows.map((row) => ({
+    const direction: 'NON_NEGATIVE' | 'NON_POSITIVE' =
+      rev.subtotalMinor < 0 ||
+      rev.grossCollectedMinor < 0 ||
+      rev.taxOrVatMinor < 0 ||
+      rev.netRealizedCadMinor < 0
+        ? 'NON_POSITIVE'
+        : 'NON_NEGATIVE';
+
+    const subtotalAdj = normalizeSignedMagnitude(
+      rev.subtotalMinor,
+      direction,
+      `reversal[${rev.id}].subtotalMinor`,
+    );
+    const taxAdj = normalizeSignedMagnitude(
+      rev.taxOrVatMinor,
+      direction,
+      `reversal[${rev.id}].taxOrVatMinor`,
+    );
+    const grossAdj = normalizeSignedMagnitude(
+      rev.grossCollectedMinor,
+      direction,
+      `reversal[${rev.id}].grossCollectedMinor`,
+    );
+    const netAdj = normalizeSignedMagnitude(
+      rev.netRealizedCadMinor,
+      direction,
+      `reversal[${rev.id}].netRealizedCadMinor`,
+    );
+    const itcAdj = normalizeSignedMagnitude(
+      rev.itcReceivableCadMinor,
+      direction,
+      `reversal[${rev.id}].itcReceivableCadMinor`,
+    );
+
+    const refundSettlementAccount: SnapshotRefundAdjustmentRow['refundSettlementAccount'] =
+      rev.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK' ||
+      rev.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED'
+        ? 'CORP_BANK'
+        : rev.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT' ||
+            rev.paymentSettlementState === 'PAYMENT_CONFIRMED'
+          ? 'OPERATOR_FLOAT'
+          : 'PENDING_EXTERNAL_RECEIVABLE';
+
+    const originalFeeTaxVerified =
+      original.isFeeTaxInvoiceVerified === true &&
+      typeof original.feeTaxInvoiceStorageKey === 'string' &&
+      original.feeTaxInvoiceStorageKey.trim().length > 0;
+
+    refundAdjustments.push({
+      id: revId,
+      organizationId: normalizedOrgId,
+      originalSaleId: targetId,
+      taxCollectionMode: rev.taxCollectionMode,
+      gstHstAdjustmentCadMinor:
+        rev.marketNode === 'DOMESTIC_ORIGIN' &&
+        rev.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
+          ? taxAdj
+          : 0,
+      itcAdjustmentCadMinor: itcAdj,
+      isFeeTaxInvoiceVerified: originalFeeTaxVerified,
+      subtotalAdjustmentMinor: subtotalAdj,
+      grossAdjustmentMinor: grossAdj,
+      netRealizedCadAdjustmentMinor: netAdj,
+      refundSettlementAccount,
+      custodyHolderUserId: rev.soldByUserId.toLowerCase(),
+    });
+
+    const list = reversalsByOriginalSaleId.get(targetId) ?? [];
+    list.push(rev);
+    reversalsByOriginalSaleId.set(targetId, list);
+  }
+
+  const sales: SnapshotSaleRow[] = baseSaleRows.map((row) => ({
     id: row.id.toLowerCase(),
     organizationId: row.organizationId.toLowerCase(),
     marketNode: row.marketNode,
@@ -167,7 +373,7 @@ export async function loadPersistedFinancialSnapshot(
     isVoidedOrReversed: row.isVoidedOrReversed,
   }));
 
-  const scrapLogs: SnapshotScrapRow[] = scrapRows.map((row) => ({
+  const scrapLogs: SnapshotScrapRow[] = params.scrapRows.map((row) => ({
     id: row.id.toLowerCase(),
     organizationId: row.organizationId.toLowerCase(),
     vehicleId: row.vehicleId.toLowerCase(),
@@ -176,21 +382,25 @@ export async function loadPersistedFinancialSnapshot(
     custodyHolderUserId: row.recordedByUserId.toLowerCase(),
   }));
 
-  const cashTransfers: SnapshotCashTransferRow[] = transferRows.map((row) => ({
-    id: row.id.toLowerCase(),
-    organizationId: row.organizationId.toLowerCase(),
-    marketNode: row.marketNode,
-    fromCustodyState: row.fromCustodyState,
-    toCustodyState: row.toCustodyState,
-    currency: row.currency,
-    amountMinor: row.amountMinor,
-    equivalentCadMinor: row.equivalentCadMinor,
-    depositSlipStorageKey: row.depositSlipStorageKey,
-    operatorUserId: row.recordedByUserId.toLowerCase(),
-  }));
+  const cashTransfers: SnapshotCashTransferRow[] = params.transferRows.map(
+    (row) => ({
+      id: row.id.toLowerCase(),
+      organizationId: row.organizationId.toLowerCase(),
+      marketNode: row.marketNode,
+      fromCustodyState: row.fromCustodyState,
+      toCustodyState: row.toCustodyState,
+      currency: row.currency,
+      amountMinor: row.amountMinor,
+      equivalentCadMinor: row.equivalentCadMinor,
+      depositSlipStorageKey: row.depositSlipStorageKey,
+      operatorUserId: (
+        row.custodyHolderUserId ?? row.recordedByUserId
+      ).toLowerCase(),
+    }),
+  );
 
-  const repatriationSettlements: SnapshotRepatriationRow[] = settlementRows.map(
-    (row) => {
+  const repatriationSettlements: SnapshotRepatriationRow[] =
+    params.settlementRows.map((row) => {
       if (row.settledInCanadaAt !== null && row.targetCurrency !== 'CAD') {
         throw new DomainRuleError(
           'UNCONVERTED_NON_CAD_AMOUNT',
@@ -200,19 +410,21 @@ export async function loadPersistedFinancialSnapshot(
       return {
         id: row.id.toLowerCase(),
         organizationId: row.organizationId.toLowerCase(),
-        targetSettledCadMinor: bigIntToSafeNumber(
-          row.totalTargetSettledMinor,
-          `currencySettlement[${row.id}].totalTargetSettledMinor`,
-        ),
+        targetSettledCadMinor:
+          typeof row.totalTargetSettledMinor === 'number'
+            ? row.totalTargetSettledMinor
+            : bigIntToSafeNumber(
+                row.totalTargetSettledMinor,
+                `currencySettlement[${row.id}].totalTargetSettledMinor`,
+              ),
         cashCustodyState:
           row.settledInCanadaAt !== null
             ? 'SETTLED_ORIGIN_CORP_BANK'
             : 'PENDING_EXTERNAL_RECEIVABLE',
       };
-    },
-  );
+    });
 
-  const expenses: SnapshotExpenseRow[] = expenseRows.map((row) => ({
+  const expenses: SnapshotExpenseRow[] = params.expenseRows.map((row) => ({
     id: row.id.toLowerCase(),
     organizationId: row.organizationId.toLowerCase(),
     category: row.category,
@@ -222,6 +434,13 @@ export async function loadPersistedFinancialSnapshot(
     amountCadMinor: row.amountCadMinor,
     itcReceivableCadMinor: row.itcReceivableCadMinor,
     paidFromCashCustody: row.paidFromCashCustody,
+    custodyHolderUserId: row.custodyHolderUserId
+      ? row.custodyHolderUserId.toLowerCase()
+      : null,
+    recipientUserId: row.recipientUserId
+      ? row.recipientUserId.toLowerCase()
+      : null,
+    floatOffsetAppliedCadMinor: row.floatOffsetAppliedCadMinor ?? 0,
     loggedByUserId: row.loggedByUserId.toLowerCase(),
     isDeferredIntercompanyAccrual: row.isDeferredIntercompanyAccrual,
     accrualSettledAt: row.accrualSettledAt,
@@ -230,21 +449,495 @@ export async function loadPersistedFinancialSnapshot(
     isReversalEntry: row.isReversalEntry,
   }));
 
+  // Build donor vehicle summaries when vehicle rows are supplied
+  const extraWarnings: string[] = [];
+  const donorVehicles: SnapshotDonorVehicleSummaryRow[] = [];
+
+  if (params.vehicleRows && params.vehicleRows.length > 0) {
+    const scrapByVehicle = new Map<string, number>();
+    for (const s of scrapLogs) {
+      scrapByVehicle.set(
+        s.vehicleId,
+        (scrapByVehicle.get(s.vehicleId) ?? 0) + s.payoutCadMinor,
+      );
+    }
+
+    const directExpensesByVehicle = new Map<string, number>();
+    const expenseById = new Map(
+      params.expenseRows.map((e) => [e.id.toLowerCase(), e]),
+    );
+    const reversedAmountByExpenseId = new Map<string, number>();
+    for (const e of params.expenseRows) {
+      if (e.isReversalEntry && e.reversesExpenseId) {
+        const targetId = e.reversesExpenseId.toLowerCase();
+        reversedAmountByExpenseId.set(
+          targetId,
+          (reversedAmountByExpenseId.get(targetId) ?? 0) + e.amountCadMinor,
+        );
+      }
+    }
+    for (const e of params.expenseRows) {
+      if (
+        e.isReversalEntry ||
+        !e.vehicleId ||
+        !ALLOWLISTED_DIRECT_DONOR_EXPENSE_CATEGORIES.has(e.category)
+      ) {
+        continue;
+      }
+      const vehId = e.vehicleId.toLowerCase();
+      const reversed = reversedAmountByExpenseId.get(e.id.toLowerCase()) ?? 0;
+      const net = Math.max(0, e.amountCadMinor - reversed);
+      directExpensesByVehicle.set(
+        vehId,
+        (directExpensesByVehicle.get(vehId) ?? 0) + net,
+      );
+    }
+    void expenseById;
+
+    const activeCadSaleIds = new Set(
+      baseSaleRows
+        .filter(
+          (s) =>
+            s.paymentCurrency === 'CAD' &&
+            !s.isVoidedOrReversed &&
+            s.paymentSettlementState !== 'REFUNDED_OR_CHARGED_BACK',
+        )
+        .map((s) => s.id.toLowerCase()),
+    );
+
+    const partById = new Map(
+      (params.partRows ?? []).map((p) => [p.id.toLowerCase(), p]),
+    );
+    const activeSoldPartIds = new Set<string>();
+    const realizedPartsByVehicle = new Map<string, number>();
+
+    for (const item of params.salePartItemRows ?? []) {
+      if (!item.isActiveSale) {
+        continue;
+      }
+      const saleId = item.saleTransactionId.toLowerCase();
+      const partId = item.partId.toLowerCase();
+      activeSoldPartIds.add(partId);
+      if (!activeCadSaleIds.has(saleId)) {
+        continue;
+      }
+      const part = partById.get(partId);
+      if (!part) {
+        continue;
+      }
+      const vehId = part.donorVehicleId.toLowerCase();
+      realizedPartsByVehicle.set(
+        vehId,
+        (realizedPartsByVehicle.get(vehId) ?? 0) + item.soldPriceMinor,
+      );
+    }
+
+    const projectedRemainingByVehicle = new Map<string, number>();
+    let hasMissingCompBaseline = false;
+    for (const part of params.partRows ?? []) {
+      const partId = part.id.toLowerCase();
+      const vehId = part.donorVehicleId.toLowerCase();
+      const isSoldOrScrapped =
+        activeSoldPartIds.has(partId) ||
+        part.availabilityState === 'PAID_SETTLED' ||
+        part.custodyState === 'SOLD_AND_RELEASED' ||
+        part.custodyState === 'SCRAPPED_OR_DAMAGED';
+      if (isSoldOrScrapped) {
+        continue;
+      }
+      if (part.compBaselineCadMinor === null) {
+        hasMissingCompBaseline = true;
+        continue;
+      }
+      projectedRemainingByVehicle.set(
+        vehId,
+        (projectedRemainingByVehicle.get(vehId) ?? 0) +
+          part.compBaselineCadMinor,
+      );
+    }
+    if (hasMissingCompBaseline) {
+      extraWarnings.push('DONOR_MISSING_PART_COMP_BASELINE');
+    }
+
+    for (const veh of params.vehicleRows) {
+      const vehId = veh.id.toLowerCase();
+      const scrapTotal = scrapByVehicle.has(vehId)
+        ? scrapByVehicle.get(vehId)!
+        : veh.scrapRecoveryCadMinor;
+      donorVehicles.push({
+        id: vehId,
+        organizationId: normalizedOrgId,
+        totalAcquisitionAndStripCostCadMinor:
+          veh.actualPurchasePriceCadMinor +
+          (directExpensesByVehicle.get(vehId) ?? 0),
+        scrapRecoveryCadMinor: scrapTotal,
+        realizedPartSalesCadMinor: realizedPartsByVehicle.get(vehId) ?? 0,
+        projectedRemainingPartsCadMinor:
+          projectedRemainingByVehicle.get(vehId) ?? 0,
+      });
+    }
+  }
+
   const snapshotInput: FinancialSnapshotInput = {
-    organizationId: organizationId.toLowerCase(),
-    tranches: policy.operationalGates.workingCapitalGate.tranches.map((t) => ({
-      trancheCode: t.trancheCode,
-      principalCadMinor: t.principalCadMinor,
-      unlocked: t.unlocked,
-    })),
+    organizationId: normalizedOrgId,
+    tranches: params.policy.operationalGates.workingCapitalGate.tranches.map(
+      (t) => ({
+        trancheCode: t.trancheCode,
+        principalCadMinor: t.principalCadMinor,
+        unlocked: t.unlocked,
+      }),
+    ),
     sales,
+    refundAdjustments,
     scrapLogs,
     cashTransfers,
     repatriationSettlements,
     expenses,
+    donorVehicles,
     priorPartnerDrawsCadMinor: 0,
   };
 
-  const snapshot = computeSeparatedFinancialSnapshot(snapshotInput, policy);
-  return { snapshotInput, snapshot };
+  const baseSnapshot = computeSeparatedFinancialSnapshot(
+    snapshotInput,
+    params.policy,
+  );
+  const snapshot: SeparatedFinancialSnapshot =
+    extraWarnings.length > 0
+      ? {
+          ...baseSnapshot,
+          warnings: [...baseSnapshot.warnings, ...extraWarnings],
+        }
+      : baseSnapshot;
+
+  const detailedTax = computeDetailedTaxCounters({
+    organizationId: normalizedOrgId,
+    sales: sales.map((s) => ({
+      id: s.id,
+      organizationId: s.organizationId,
+      taxCollectionMode: s.taxCollectionMode,
+      gstHstTaxCadMinor:
+        s.gstHstTaxCadMinor ??
+        (s.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
+          ? s.taxOrVatMinor
+          : 0),
+      provincialTaxCadMinor: s.provincialTaxCadMinor,
+      itcReceivableCadMinor: s.itcReceivableCadMinor,
+      estimatedPlatformFeeTaxCadMinor: s.estimatedPlatformFeeTaxCadMinor,
+      isFeeTaxInvoiceVerified: s.isFeeTaxInvoiceVerified,
+      feeTaxInvoiceStorageKey: s.feeTaxInvoiceStorageKey,
+      paymentSettlementState: s.paymentSettlementState,
+      isVoidedOrReversed: s.isVoidedOrReversed,
+    })),
+    expenses: expenses.map((e) => ({
+      id: e.id,
+      organizationId: e.organizationId,
+      itcReceivableCadMinor: e.itcReceivableCadMinor,
+      receiptVerificationState: e.receiptVerificationState,
+      receiptStorageKey: e.receiptStorageKey,
+      isReversalEntry: e.isReversalEntry,
+      isVoidedOrReversed: e.isVoidedOrReversed,
+    })),
+    refundAdjustments,
+  });
+
+  // Compute authoritative marketplace buyer tax sum (nullable) & unverified platform fee tax
+  let buyerTaxSum: number | null = null;
+  let hasUnknownMarketplaceBuyerTax = false;
+  let unverifiedPlatformFeeTaxAccruedCadMinor = 0;
+
+  for (const row of baseSaleRows) {
+    const saleId = row.id.toLowerCase();
+    const rowReversals = reversalsByOriginalSaleId.get(saleId) ?? [];
+    const isFullyReversedWithoutAdjustments =
+      rowReversals.length === 0 &&
+      (row.isVoidedOrReversed === true ||
+        row.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK');
+    if (isFullyReversedWithoutAdjustments) {
+      continue;
+    }
+
+    const isMarketplaceFacilitated =
+      row.taxCollectionMode === 'MARKETPLACE_FACILITATOR_COLLECTED' ||
+      row.domesticChannel === 'EBAY_MOTORS_SHIPPED';
+
+    if (isMarketplaceFacilitated && row.paymentCurrency === 'CAD') {
+      if (
+        row.buyerTaxRemittedByPlatformMinor !== null &&
+        row.buyerTaxRemittedByPlatformMinor !== undefined
+      ) {
+        let netBuyerTax = row.buyerTaxRemittedByPlatformMinor;
+        let reversedAllWithoutValue = false;
+        for (const rev of rowReversals) {
+          if (
+            rev.buyerTaxRemittedByPlatformMinor !== null &&
+            rev.buyerTaxRemittedByPlatformMinor !== undefined
+          ) {
+            netBuyerTax -= Math.abs(rev.buyerTaxRemittedByPlatformMinor);
+          } else if (row.isVoidedOrReversed) {
+            reversedAllWithoutValue = true;
+          }
+        }
+        const effectiveBuyerTax = reversedAllWithoutValue
+          ? 0
+          : Math.max(0, netBuyerTax);
+        buyerTaxSum = (buyerTaxSum ?? 0) + effectiveBuyerTax;
+      } else {
+        hasUnknownMarketplaceBuyerTax = true;
+      }
+    }
+
+    const feeInvoiceVerified =
+      row.isFeeTaxInvoiceVerified === true &&
+      typeof row.feeTaxInvoiceStorageKey === 'string' &&
+      row.feeTaxInvoiceStorageKey.trim().length > 0;
+
+    if (!feeInvoiceVerified && row.estimatedPlatformFeeTaxCadMinor > 0) {
+      let netUnverified = row.estimatedPlatformFeeTaxCadMinor;
+      for (const rev of rowReversals) {
+        netUnverified -= Math.abs(rev.estimatedPlatformFeeTaxCadMinor);
+      }
+      if (!row.isVoidedOrReversed || rowReversals.length > 0) {
+        unverifiedPlatformFeeTaxAccruedCadMinor += Math.max(0, netUnverified);
+      }
+    }
+  }
+
+  // Destination vault physical cash held per currency (fail-closed at 0 when no vault sales exist)
+  const destinationVaultCashByCurrency: Record<string, number> = {};
+  for (const row of baseSaleRows) {
+    if (
+      row.marketNode === 'DESTINATION_EXPORT_VAULT' &&
+      row.cashCustodyState === 'HELD_IN_DESTINATION_VAULT' &&
+      !row.isVoidedOrReversed &&
+      row.paymentSettlementState !== 'REFUNDED_OR_CHARGED_BACK'
+    ) {
+      const counterDeduction =
+        row.isBrokerCommissionDeductedAtCounter === true
+          ? (row.brokerCommissionMinor ?? 0)
+          : 0;
+      const netCounterCash = Math.max(
+        0,
+        row.grossCollectedMinor - counterDeduction,
+      );
+      destinationVaultCashByCurrency[row.paymentCurrency] =
+        (destinationVaultCashByCurrency[row.paymentCurrency] ?? 0) +
+        netCounterCash;
+    }
+  }
+  for (const t of params.transferRows) {
+    if (
+      t.fromCustodyState === 'HELD_IN_DESTINATION_VAULT' &&
+      t.toCustodyState === 'DEPOSITED_DESTINATION_BANK'
+    ) {
+      destinationVaultCashByCurrency[t.currency] =
+        (destinationVaultCashByCurrency[t.currency] ?? 0) - t.amountMinor;
+    }
+  }
+
+  return {
+    snapshotInput,
+    snapshot,
+    taxCounters: {
+      directTaxCollectedNetOfRefundsCadMinor:
+        detailedTax.directTaxCollectedNetOfRefundsCadMinor,
+      buyerTaxRemittedByPlatformCadMinor: buyerTaxSum,
+      hasUnknownMarketplaceBuyerTax,
+      unverifiedPlatformFeeTaxAccruedCadMinor,
+      verifiedItcReceivableCadMinor: detailedTax.verifiedItcReceivableCadMinor,
+      netHstTrustLiabilityCadMinor: detailedTax.netHstTrustLiabilityCadMinor,
+    },
+    destinationVaultCashByCurrency,
+  };
+}
+
+/**
+ * Reads persisted ledger tables within an active `withTenantTransaction` (`tx`)
+ * and delegates all 7-metric liquidity, pending-receivable, float, and CRA HST
+ * trust calculations to `computeSeparatedFinancialSnapshot`.
+ */
+export async function querySeparatedFinancialSnapshot(
+  tx: Prisma.TransactionClient,
+  organizationId: string,
+  policy: WorkingCapitalPolicySlice,
+): Promise<SeparatedFinancialSnapshot> {
+  const projection = await loadPersistedFinancialSnapshot(
+    tx,
+    organizationId,
+    policy,
+  );
+  return projection.snapshot;
+}
+
+export async function loadPersistedFinancialSnapshot(
+  tx: Prisma.TransactionClient,
+  organizationId: string,
+  policy: WorkingCapitalPolicySlice,
+): Promise<PersistedLedgerProjection> {
+  const hasDonorTables =
+    typeof (tx as unknown as { vehicle?: { findMany?: unknown } }).vehicle
+      ?.findMany === 'function' &&
+    typeof (tx as unknown as { part?: { findMany?: unknown } }).part
+      ?.findMany === 'function' &&
+    typeof (
+      tx as unknown as { saleTransactionPartItem?: { findMany?: unknown } }
+    ).saleTransactionPartItem?.findMany === 'function';
+
+  const [
+    saleRows,
+    scrapRows,
+    transferRows,
+    settlementRows,
+    expenseRows,
+    vehicleRows,
+    partRows,
+    salePartItemRows,
+  ] = await Promise.all([
+    tx.saleTransaction.findMany({
+      where: { organizationId },
+      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        marketNode: true,
+        domesticChannel: true,
+        exportChannel: true,
+        paymentCurrency: true,
+        taxCollectionMode: true,
+        subtotalMinor: true,
+        taxOrVatMinor: true,
+        buyerTaxRemittedByPlatformMinor: true,
+        platformFeeMinor: true,
+        shippingCostMinor: true,
+        estimatedPlatformFeeTaxCadMinor: true,
+        itcReceivableCadMinor: true,
+        isFeeTaxInvoiceVerified: true,
+        feeTaxInvoiceStorageKey: true,
+        grossCollectedMinor: true,
+        netRealizedCadMinor: true,
+        paymentSettlementState: true,
+        cashCustodyState: true,
+        bankSettledAt: true,
+        bankDepositReference: true,
+        soldByUserId: true,
+        isVoidedOrReversed: true,
+        reversesSaleTxId: true,
+        brokerCommissionMinor: true,
+        isBrokerCommissionDeductedAtCounter: true,
+      },
+    }),
+    tx.scrapComponentLog.findMany({
+      where: { organizationId },
+      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        vehicleId: true,
+        payoutCadMinor: true,
+        cashCustodyState: true,
+        recordedByUserId: true,
+      },
+    }),
+    tx.cashCustodyTransfer.findMany({
+      where: { organizationId },
+      orderBy: [{ transferredAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        marketNode: true,
+        fromCustodyState: true,
+        toCustodyState: true,
+        currency: true,
+        amountMinor: true,
+        equivalentCadMinor: true,
+        depositSlipStorageKey: true,
+        recordedByUserId: true,
+        custodyHolderUserId: true,
+      },
+    }),
+    tx.currencySettlement.findMany({
+      where: { organizationId },
+      orderBy: [{ initiatedAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        targetCurrency: true,
+        totalTargetSettledMinor: true,
+        settledInCanadaAt: true,
+      },
+    }),
+    tx.expense.findMany({
+      where: { organizationId },
+      orderBy: [{ incurredAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        category: true,
+        vehicleId: true,
+        currencyOriginal: true,
+        amountOriginalMinor: true,
+        amountCadMinor: true,
+        itcReceivableCadMinor: true,
+        paidFromCashCustody: true,
+        loggedByUserId: true,
+        recipientUserId: true,
+        floatOffsetAppliedCadMinor: true,
+        custodyHolderUserId: true,
+        isDeferredIntercompanyAccrual: true,
+        accrualSettledAt: true,
+        receiptVerificationState: true,
+        receiptStorageKey: true,
+        isReversalEntry: true,
+        reversesExpenseId: true,
+      },
+    }),
+    hasDonorTables
+      ? tx.vehicle.findMany({
+          where: { organizationId },
+          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
+          select: {
+            id: true,
+            organizationId: true,
+            actualPurchasePriceCadMinor: true,
+            scrapRecoveryCadMinor: true,
+          },
+        })
+      : Promise.resolve([]),
+    hasDonorTables
+      ? tx.part.findMany({
+          where: { organizationId },
+          orderBy: [{ strippedAt: 'asc' }, { id: 'asc' }],
+          select: {
+            id: true,
+            donorVehicleId: true,
+            compBaselineCadMinor: true,
+            availabilityState: true,
+            custodyState: true,
+          },
+        })
+      : Promise.resolve([]),
+    hasDonorTables
+      ? tx.saleTransactionPartItem.findMany({
+          where: { organizationId, isActiveSale: true },
+          select: {
+            saleTransactionId: true,
+            partId: true,
+            soldPriceMinor: true,
+            isActiveSale: true,
+          },
+        })
+      : Promise.resolve([]),
+  ]);
+
+  return buildPersistedLedgerProjection({
+    organizationId,
+    policy,
+    saleRows,
+    scrapRows,
+    transferRows,
+    settlementRows,
+    expenseRows,
+    vehicleRows,
+    partRows,
+    salePartItemRows,
+  });
 }
```

Fix diff since previous review:

```diff
diff --git a/prisma/schema.prisma b/prisma/schema.prisma
index e3bab1b..8307e33 100644
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -71,6 +71,7 @@ enum ExpenseCategory {
   PROCESSING_SOLVENTS_AND_CONSUMABLES
   EXCISE_STAMP_AND_DUTY
   PARTNER_PROFIT_DRAW                 // Realized-profit partner draw gated by RULE-PAY-002 & RULE-PAY-003
+  PARTNER_TIME_LOG_MEMO               // Zero-cash descriptive partner time log memo (no float/bank/profit impact)
 
   @@schema("shared")
 }
@@ -221,6 +222,10 @@ model OrganizationMembership {
   createdAt          DateTime     @default(now())
   updatedAt          DateTime     @updatedAt
 
+  recipientExpenses    Expense[]             @relation("ExpenseRecipientMembership")
+  custodyHeldExpenses  Expense[]             @relation("ExpenseCustodyHolderMembership")
+  custodyHeldTransfers CashCustodyTransfer[] @relation("TransferCustodyHolderMembership")
+
   @@unique([organizationId, id])
   @@unique([organizationId, userId])
   @@index([userId, isActive])
@@ -298,6 +303,12 @@ model Expense {
   cannabisLot           CannabisLot?         @relation(fields: [organizationId, cannabisLotId], references: [organizationId, id], onDelete: Restrict, onUpdate: Cascade)
   loggedByUserId        String               @db.Uuid
   loggedByUser          User                 @relation("LoggedByUser", fields: [loggedByUserId], references: [id])
+  recipientUserId       String?              @db.Uuid
+  recipientMembership   OrganizationMembership? @relation("ExpenseRecipientMembership", fields: [organizationId, recipientUserId], references: [organizationId, userId], onDelete: Restrict, onUpdate: Cascade)
+  floatOffsetAppliedCadMinor Int             @default(0)
+  custodyHolderUserId   String?              @db.Uuid
+  custodyHolderMembership OrganizationMembership? @relation("ExpenseCustodyHolderMembership", fields: [organizationId, custodyHolderUserId], references: [organizationId, userId], onDelete: Restrict, onUpdate: Cascade)
+  idempotencyKey        String?
 
   category                      ExpenseCategory
   vendorName                    String
@@ -329,7 +340,11 @@ model Expense {
   createdAt             DateTime             @default(now())
 
   @@unique([organizationId, id])
+  @@unique([organizationId, idempotencyKey])
   @@index([organizationId, incurredAt])
+  @@index([organizationId, loggedByUserId, receiptVerificationState, createdAt])
+  @@index([organizationId, recipientUserId])
+  @@index([organizationId, custodyHolderUserId])
   @@index([vehicleId])
   @@index([shipmentId])
   @@index([cannabisLotId])
@@ -352,13 +367,18 @@ model CashCustodyTransfer {
   depositSlipStorageKey  String               // Mandatory private R2 key (enforced non-empty via SQL CHECK)
   recordedByUserId       String               @db.Uuid
   recordedByUser         User                 @relation("TransferRecordedByUser", fields: [recordedByUserId], references: [id])
+  custodyHolderUserId    String?              @db.Uuid
+  custodyHolderMembership OrganizationMembership? @relation("TransferCustodyHolderMembership", fields: [organizationId, custodyHolderUserId], references: [organizationId, userId], onDelete: Restrict, onUpdate: Cascade)
+  idempotencyKey         String?
   accountingSyncStatus   AccountingSyncStatus @default(PENDING_SYNC)
   externalGlJournalId    String?
   transferredAt          DateTime             @default(now())
   createdAt              DateTime             @default(now())
 
   @@unique([organizationId, id])
+  @@unique([organizationId, idempotencyKey])
   @@index([organizationId, transferredAt])
+  @@index([organizationId, custodyHolderUserId])
   @@index([marketNode, fromCustodyState, toCustodyState])
   @@index([commercialBankName])
   @@schema("shared")
diff --git a/src/core/domain/__tests__/working-capital-and-compensation.test.ts b/src/core/domain/__tests__/working-capital-and-compensation.test.ts
index 1052ac1..e5fc9c0 100644
--- a/src/core/domain/__tests__/working-capital-and-compensation.test.ts
+++ b/src/core/domain/__tests__/working-capital-and-compensation.test.ts
@@ -1,5 +1,6 @@
 import { describe, expect, it } from 'vitest';
 import {
+  computeDetailedTaxCounters,
   computeNetHstTrustLiabilityCadMinor,
   computeSeparatedFinancialSnapshot,
   evaluatePartnerProfitDraw,
@@ -1467,8 +1468,25 @@ describe('3-Rule Compensation Protocol (RULE-PAY-001 to RULE-PAY-003)', () => {
         },
       ],
     });
-    // Profit pool is 800,000, bank is 800,000, reserve floor is 750,000 -> bank draw max = 50,000
-    const reserveLockedDraw = evaluatePartnerProfitDraw(
+    // Profit pool is 800,000, bank is 800,000, reserve floor is 750,000 -> bank draw max without override = 50,000
+    const reserveBlockedWithoutOverride = evaluatePartnerProfitDraw(
+      {
+        organizationId: ORG_SALVAGE,
+        targetUserId: 'cfo-1',
+        targetUserRole: 'ARCHITECT_CFO',
+        requestedDrawCadMinor: 50_001,
+        snapshotInput: lowBankReserveInput,
+        actor: { actorUserId: 'cfo-1', actorRole: 'ARCHITECT_CFO' },
+      },
+      policy,
+    );
+    expect(reserveBlockedWithoutOverride.allowed).toBe(false);
+    expect(reserveBlockedWithoutOverride.blockingCodes).toContain(
+      'INSUFFICIENT_LIQUID_RESERVE_CAPACITY',
+    );
+
+    // Valid authenticated CFO override with nonblank reason waives ONLY the reserve-floor gate (up to availableWorkingCapitalCadMinor)
+    const reserveOverrideAllowed = evaluatePartnerProfitDraw(
       {
         organizationId: ORG_SALVAGE,
         targetUserId: 'cfo-1',
@@ -1480,15 +1498,311 @@ describe('3-Rule Compensation Protocol (RULE-PAY-001 to RULE-PAY-003)', () => {
           approved: true,
           approvedById: 'cfo-1',
           approverRole: 'ARCHITECT_CFO',
-          reasonNote: 'Attempt to breach bank reserve via CFO override',
+          reasonNote: 'CFO authorized temporary reserve-floor dip for quarterly partner distribution.',
         },
       },
       policy,
     );
-    expect(reserveLockedDraw.allowed).toBe(false);
-    expect(reserveLockedDraw.overrideApplied).toBe(false);
-    expect(reserveLockedDraw.blockingCodes).toContain(
+    expect(reserveOverrideAllowed.allowed).toBe(true);
+    expect(reserveOverrideAllowed.overrideApplied).toBe(true);
+    expect(reserveOverrideAllowed.warnings).toContain(
+      'WORKING_CAPITAL_RESERVE_BREACHED',
+    );
+    expect(reserveOverrideAllowed.cfoOverrideAudit).toEqual({
+      overrideApplied: true,
+      approvedById: 'cfo-1',
+      reasonNote:
+        'CFO authorized temporary reserve-floor dip for quarterly partner distribution.',
+    });
+
+    // Forged non-CFO actor cannot waive reserve floor even with spoofed cfoOverride fields
+    const forgedReserveOverride = evaluatePartnerProfitDraw(
+      {
+        organizationId: ORG_SALVAGE,
+        targetUserId: 'hunter-1',
+        targetUserRole: 'HUNTER_MECHANIC',
+        requestedDrawCadMinor: 50_001,
+        snapshotInput: lowBankReserveInput,
+        actor: { actorUserId: 'hunter-1', actorRole: 'HUNTER_MECHANIC' },
+        cfoOverride: {
+          approved: true,
+          approvedById: 'cfo-1',
+          approverRole: 'ARCHITECT_CFO',
+          reasonNote: 'Spoofed CFO override by hunter',
+        },
+      },
+      policy,
+    );
+    expect(forgedReserveOverride.allowed).toBe(false);
+    expect(forgedReserveOverride.overrideApplied).toBe(false);
+    expect(forgedReserveOverride.blockingCodes).toContain(
+      'CFO_OVERRIDE_UNAUTHORIZED',
+    );
+    expect(forgedReserveOverride.blockingCodes).toContain(
       'INSUFFICIENT_LIQUID_RESERVE_CAPACITY',
     );
+
+    // Hard liquidity cap: even valid CFO override CANNOT disburse more than actual availableWorkingCapitalCadMinor (protects HST trust!)
+    const hstProtectedInput = makeBaseSnapshotInput({
+      tranches: [
+        {
+          trancheCode: 'TRANCHE_1_LAUNCH',
+          principalCadMinor: 0,
+          unlocked: true,
+        },
+      ],
+      sales: [
+        {
+          id: 's-hst-protected',
+          organizationId: ORG_SALVAGE,
+          marketNode: 'DOMESTIC_ORIGIN',
+          domesticChannel: 'FB_MARKETPLACE_LOCAL',
+          paymentCurrency: 'CAD',
+          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+          subtotalMinor: 800_000,
+          gstHstTaxCadMinor: 104_000,
+          provincialTaxCadMinor: 0,
+          taxOrVatMinor: 104_000,
+          platformFeeMinor: 0,
+          shippingCostMinor: 0,
+          estimatedPlatformFeeTaxCadMinor: 0,
+          itcReceivableCadMinor: 0,
+          isFeeTaxInvoiceVerified: false,
+          grossCollectedMinor: 904_000,
+          netRealizedCadMinor: 800_000,
+          bankClearedCadMinor: 904_000,
+          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
+          cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
+          bankSettledAt: '2026-04-06T12:00:00Z',
+          bankDepositReference: 'INT-3',
+          isVoidedOrReversed: false,
+        },
+      ],
+    });
+    // Profit pool = 800,000 - 104,000 = 696,000; availableWorkingCapital = 904,000 - 104,000 = 800,000
+    // Trying 800,001 exceeds both profit pool AND hard working capital (attempting to spend HST trust)
+    const hardCapDraw = evaluatePartnerProfitDraw(
+      {
+        organizationId: ORG_SALVAGE,
+        targetUserId: 'cfo-1',
+        targetUserRole: 'ARCHITECT_CFO',
+        requestedDrawCadMinor: 800_001,
+        snapshotInput: hstProtectedInput,
+        actor: { actorUserId: 'cfo-1', actorRole: 'ARCHITECT_CFO' },
+        cfoOverride: {
+          approved: true,
+          approvedById: 'cfo-1',
+          approverRole: 'ARCHITECT_CFO',
+          reasonNote: 'Attempt to spend HST trust or exceed actual working capital',
+        },
+      },
+      policy,
+    );
+    expect(hardCapDraw.allowed).toBe(false);
+    expect(hardCapDraw.overrideApplied).toBe(false);
+    expect(hardCapDraw.blockingCodes).toContain(
+      'INSUFFICIENT_REALIZED_PROFIT_POOL',
+    );
+  });
+
+  it('computes DetailedTaxCounters, zero-impact PARTNER_TIME_LOG_MEMO, and mixed float/bank draw split without double deduction', () => {
+    const policy = makePolicy();
+    const counters = computeDetailedTaxCounters({
+      organizationId: ORG_SALVAGE,
+      sales: [
+        {
+          id: 's-1',
+          organizationId: ORG_SALVAGE,
+          taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+          gstHstTaxCadMinor: 13_000,
+          itcReceivableCadMinor: 0,
+          isFeeTaxInvoiceVerified: false,
+          paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
+        },
+      ],
+      expenses: [
+        {
+          id: 'e-1',
+          organizationId: ORG_SALVAGE,
+          itcReceivableCadMinor: 1_300,
+          receiptVerificationState: 'VERIFIED_RECEIPT',
+          receiptStorageKey: 'org/evidence/1',
+        },
+      ],
+    });
+    expect(counters).toEqual({
+      directTaxCollectedNetOfRefundsCadMinor: 13_000,
+      verifiedItcReceivableCadMinor: 1_300,
+      netHstTrustLiabilityCadMinor: 11_700,
+    });
+
+    const snapshot = computeSeparatedFinancialSnapshot(
+      makeBaseSnapshotInput({
+        sales: [
+          {
+            id: 's-cash-hunter',
+            organizationId: ORG_SALVAGE,
+            marketNode: 'DOMESTIC_ORIGIN',
+            domesticChannel: 'LOCAL_WALK_IN_CASH',
+            paymentCurrency: 'CAD',
+            taxCollectionMode: 'NOT_REGISTERED_NO_TAX',
+            subtotalMinor: 4_000,
+            gstHstTaxCadMinor: 0,
+            taxOrVatMinor: 0,
+            platformFeeMinor: 0,
+            shippingCostMinor: 0,
+            itcReceivableCadMinor: 0,
+            isFeeTaxInvoiceVerified: false,
+            grossCollectedMinor: 4_000,
+            netRealizedCadMinor: 4_000,
+            paymentSettlementState: 'PAYMENT_CONFIRMED',
+            cashCustodyState: 'HELD_IN_OPERATOR_FLOAT',
+            custodyHolderUserId: 'hunter-1',
+            isVoidedOrReversed: false,
+          },
+          {
+            id: 's-bank-sale',
+            organizationId: ORG_SALVAGE,
+            marketNode: 'DOMESTIC_ORIGIN',
+            domesticChannel: 'FB_MARKETPLACE_LOCAL',
+            paymentCurrency: 'CAD',
+            taxCollectionMode: 'NOT_REGISTERED_NO_TAX',
+            subtotalMinor: 20_000,
+            gstHstTaxCadMinor: 0,
+            taxOrVatMinor: 0,
+            platformFeeMinor: 0,
+            shippingCostMinor: 0,
+            itcReceivableCadMinor: 0,
+            isFeeTaxInvoiceVerified: false,
+            grossCollectedMinor: 20_000,
+            netRealizedCadMinor: 20_000,
+            bankClearedCadMinor: 20_000,
+            paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
+            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
+            bankSettledAt: '2026-04-06T12:00:00Z',
+            bankDepositReference: 'DEP-1',
+            isVoidedOrReversed: false,
+          },
+        ],
+        expenses: [
+          {
+            id: 'memo-1',
+            organizationId: ORG_SALVAGE,
+            category: 'PARTNER_TIME_LOG_MEMO',
+            currencyOriginal: 'CAD',
+            amountOriginalMinor: 0,
+            amountCadMinor: 0,
+            itcReceivableCadMinor: 0,
+            paidFromCashCustody: null,
+            isDeferredIntercompanyAccrual: false,
+            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
+          },
+          {
+            id: 'draw-split-1',
+            organizationId: ORG_SALVAGE,
+            category: 'PARTNER_PROFIT_DRAW',
+            currencyOriginal: 'CAD',
+            amountOriginalMinor: 10_000,
+            amountCadMinor: 10_000,
+            floatOffsetAppliedCadMinor: 4_000,
+            recipientUserId: 'hunter-1',
+            custodyHolderUserId: 'hunter-1',
+            loggedByUserId: 'cfo-1',
+            itcReceivableCadMinor: 0,
+            paidFromCashCustody: 'SETTLED_ORIGIN_CORP_BANK',
+            isDeferredIntercompanyAccrual: false,
+            receiptVerificationState: 'PENDING_RECEIPT_UPLOAD',
+          },
+        ],
+      }),
+      policy,
+    );
+    // Float: 4,000 - 4,000 = 0; Bank: 2,200,000 + 20,000 - 6,000 = 2,214,000; Profit: 24,000 - 10,000 = 14,000
+    expect(snapshot.runningOperatorFloatCadMinor).toBe(0);
+    expect(snapshot.operatorFloatByUserId['hunter-1']).toBe(0);
+    expect(snapshot.confirmedCorpBankCashCadMinor).toBe(2_214_000);
+    expect(snapshot.distributableRealizedProfitPoolCadMinor).toBe(14_000);
+  });
+
+  it('uses grossCollectedMinor for grossSaleValueCadMinor and normalizes REFUNDED_OR_CHARGED_BACK bank-settled sales with explicit refundAdjustments', () => {
+    const policy = makePolicy();
+
+    const snapshot = computeSeparatedFinancialSnapshot(
+      makeBaseSnapshotInput({
+        sales: [
+          {
+            id: 'sale-bank-with-shipping',
+            organizationId: ORG_SALVAGE,
+            marketNode: 'DOMESTIC_ORIGIN',
+            domesticChannel: 'FB_MARKETPLACE_LOCAL',
+            paymentCurrency: 'CAD',
+            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+            subtotalMinor: 10_000,
+            gstHstTaxCadMinor: 1_300,
+            taxOrVatMinor: 1_300,
+            platformFeeMinor: 0,
+            shippingCostMinor: 1_500,
+            itcReceivableCadMinor: 0,
+            isFeeTaxInvoiceVerified: false,
+            // Buyer paid $128.00 ($100 part + $13 tax + $15 shipping)
+            grossCollectedMinor: 12_800,
+            netRealizedCadMinor: 12_800,
+            bankClearedCadMinor: 12_800,
+            paymentSettlementState: 'BANK_SETTLEMENT_CONFIRMED',
+            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
+            bankSettledAt: '2026-04-06T12:00:00Z',
+            bankDepositReference: 'DEP-SHIP-1',
+            isVoidedOrReversed: false,
+          },
+          {
+            id: 'sale-bank-refunded-explicit',
+            organizationId: ORG_SALVAGE,
+            marketNode: 'DOMESTIC_ORIGIN',
+            domesticChannel: 'FB_MARKETPLACE_LOCAL',
+            paymentCurrency: 'CAD',
+            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+            subtotalMinor: 20_000,
+            gstHstTaxCadMinor: 2_600,
+            taxOrVatMinor: 2_600,
+            platformFeeMinor: 0,
+            shippingCostMinor: 0,
+            itcReceivableCadMinor: 0,
+            isFeeTaxInvoiceVerified: false,
+            grossCollectedMinor: 22_600,
+            netRealizedCadMinor: 20_000,
+            bankClearedCadMinor: 22_600,
+            paymentSettlementState: 'REFUNDED_OR_CHARGED_BACK',
+            cashCustodyState: 'SETTLED_ORIGIN_CORP_BANK',
+            bankSettledAt: '2026-04-06T12:00:00Z',
+            bankDepositReference: 'DEP-REF-1',
+            isVoidedOrReversed: true,
+          },
+        ],
+        refundAdjustments: [
+          {
+            id: 'adj-bank-full-refund',
+            organizationId: ORG_SALVAGE,
+            originalSaleId: 'sale-bank-refunded-explicit',
+            taxCollectionMode: 'DIRECT_SELLER_COLLECTED',
+            subtotalAdjustmentMinor: -20_000,
+            gstHstAdjustmentCadMinor: -2_600,
+            provincialTaxAdjustmentCadMinor: 0,
+            itcAdjustmentCadMinor: 0,
+            grossAdjustmentMinor: -22_600,
+            netRealizedCadAdjustmentMinor: -20_000,
+            refundSettlementAccount: 'CORP_BANK',
+          },
+        ],
+      }),
+      policy,
+    );
+
+    expect(snapshot.accountingRevenueCadMinor).toBe(10_000);
+    expect(snapshot.grossSaleValueCadMinor).toBe(12_800);
+    // Bank: 2,200,000 + 12,800 + (22,600 - 22,600) = 2,212,800
+    expect(snapshot.confirmedCorpBankCashCadMinor).toBe(2_212_800);
+    expect(snapshot.netHstTrustLiabilityCadMinor).toBe(1_300);
+    // Profit: (12,800) + (20,000 - 20,000) - 1,300 = 11,500
+    expect(snapshot.distributableRealizedProfitPoolCadMinor).toBe(11_500);
   });
 });
diff --git a/src/core/domain/index.ts b/src/core/domain/index.ts
index bda5c71..27241a2 100644
--- a/src/core/domain/index.ts
+++ b/src/core/domain/index.ts
@@ -107,12 +107,14 @@ export {
 } from './vault-pricing-and-checkout-corridor';
 
 export {
+  computeDetailedTaxCounters,
   computeNetHstTrustLiabilityCadMinor,
   computeSeparatedFinancialSnapshot,
   evaluatePartnerProfitDraw,
   evaluatePieceRatePayout,
   evaluateTrancheMilestoneEligibility,
   evaluateWorkingCapitalGate,
+  type DetailedTaxCounters,
   type FinancialSnapshotInput,
   type LoanTrancheStatusRow,
   type NetHstTrustLiabilityInput,
diff --git a/src/core/domain/working-capital-and-compensation.ts b/src/core/domain/working-capital-and-compensation.ts
index 09cd9f3..9a7c8f4 100644
--- a/src/core/domain/working-capital-and-compensation.ts
+++ b/src/core/domain/working-capital-and-compensation.ts
@@ -78,6 +78,12 @@ export interface NetHstTrustLiabilityInput {
   readonly refundAdjustments?: readonly TaxRefundAdjustmentRow[];
 }
 
+export interface DetailedTaxCounters {
+  readonly directTaxCollectedNetOfRefundsCadMinor: number;
+  readonly verifiedItcReceivableCadMinor: number;
+  readonly netHstTrustLiabilityCadMinor: number;
+}
+
 export interface LoanTrancheStatusRow {
   readonly trancheCode: string;
   readonly principalCadMinor: number;
@@ -170,6 +176,8 @@ export interface SnapshotExpenseRow {
   readonly itcReceivableCadMinor: number;
   readonly paidFromCashCustody?: CashCustodyState | null;
   readonly custodyHolderUserId?: string | null;
+  readonly recipientUserId?: string | null;
+  readonly floatOffsetAppliedCadMinor?: number;
   readonly loggedByUserId?: string | null;
   readonly isDeferredIntercompanyAccrual: boolean;
   readonly accrualSettledAt?: string | Date | null;
@@ -389,20 +397,9 @@ function resolveDirectGstHstForSale(sale: TaxSaleLedgerRow): number {
   return assertNonNegativeSafeInt(sale.gstHstTaxCadMinor, 'gstHstTaxCadMinor');
 }
 
-/**
- * Pure CRA GST/HST trust liability calculator (`RULE-TAX-HST-01` / `FIX 06`).
- *
- * Strictly ring-fences:
- * - Direct seller-collected CRA GST/HST (`DIRECT_SELLER_COLLECTED`), excluding standalone
- *   provincial QST/PST (`provincialTaxCadMinor`) and marketplace-remitted buyer taxes.
- * - Verified seller-fee tax ITCs (`isFeeTaxInvoiceVerified === true` + non-empty storage key)
- *   and `VERIFIED_RECEIPT` expense ITCs, ignoring unverified estimates even if populated.
- * - Normalizes `refundAdjustments` against `REFUNDED_OR_CHARGED_BACK` sales without double-deducting.
- * - Clamps at `0` so excess ITC claims never fabricate spendable bank working capital.
- */
-export function computeNetHstTrustLiabilityCadMinor(
+export function computeDetailedTaxCounters(
   input: NetHstTrustLiabilityInput,
-): number {
+): DetailedTaxCounters {
   const organizationId = assertNonEmptyTrimmedString(
     input.organizationId,
     'INVALID_INPUT',
@@ -549,14 +546,47 @@ export function computeNetHstTrustLiabilityCadMinor(
     verifiedItcTotal += BigInt(exp.isReversalEntry ? -expItc : expItc);
   }
 
-  if (directTaxCollected <= 0n || directTaxCollected <= verifiedItcTotal) {
-    return 0;
-  }
+  const directClamped =
+    directTaxCollected > 0n
+      ? bigIntToSafeNumber(
+          directTaxCollected,
+          'directTaxCollectedNetOfRefundsCadMinor',
+        )
+      : 0;
+  const itcClamped =
+    verifiedItcTotal > 0n
+      ? bigIntToSafeNumber(verifiedItcTotal, 'verifiedItcReceivableCadMinor')
+      : 0;
+  const netLiability =
+    directTaxCollected <= 0n || directTaxCollected <= verifiedItcTotal
+      ? 0
+      : bigIntToSafeNumber(
+          directTaxCollected - verifiedItcTotal,
+          'netHstTrustLiabilityCadMinor',
+        );
 
-  return bigIntToSafeNumber(
-    directTaxCollected - verifiedItcTotal,
-    'netHstTrustLiabilityCadMinor',
-  );
+  return {
+    directTaxCollectedNetOfRefundsCadMinor: directClamped,
+    verifiedItcReceivableCadMinor: itcClamped,
+    netHstTrustLiabilityCadMinor: netLiability,
+  };
+}
+
+/**
+ * Pure CRA GST/HST trust liability calculator (`RULE-TAX-HST-01` / `FIX 06`).
+ *
+ * Strictly ring-fences:
+ * - Direct seller-collected CRA GST/HST (`DIRECT_SELLER_COLLECTED`), excluding standalone
+ *   provincial QST/PST (`provincialTaxCadMinor`) and marketplace-remitted buyer taxes.
+ * - Verified seller-fee tax ITCs (`isFeeTaxInvoiceVerified === true` + non-empty storage key)
+ *   and `VERIFIED_RECEIPT` expense ITCs, ignoring unverified estimates even if populated.
+ * - Normalizes `refundAdjustments` against `REFUNDED_OR_CHARGED_BACK` sales without double-deducting.
+ * - Clamps at `0` so excess ITC claims never fabricate spendable bank working capital.
+ */
+export function computeNetHstTrustLiabilityCadMinor(
+  input: NetHstTrustLiabilityInput,
+): number {
+  return computeDetailedTaxCounters(input).netHstTrustLiabilityCadMinor;
 }
 
 function addUserFloatDelta(
@@ -846,7 +876,7 @@ export function computeSeparatedFinancialSnapshot(
     }
 
     const activeSubtotal = BigInt(subtotal) + adjSubtotal;
-    const activeGrossForValue = BigInt(subtotal + taxOrVat) + adjGross;
+    const activeGrossForValue = BigInt(grossCollected) + adjGross;
     if (sale.paymentCurrency === 'CAD') {
       accountingRevenue += activeSubtotal;
       grossSaleValue += activeGrossForValue > 0n ? activeGrossForValue : 0n;
@@ -880,7 +910,9 @@ export function computeSeparatedFinancialSnapshot(
       confirmedCorpBankCash += adjBankRefund;
       realizedSaleProfitContribution += BigInt(netRealizedCad) + adjNetRealized;
     } else if (
-      sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' &&
+      (sale.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED' ||
+        (hasExplicitAdjustments &&
+          sale.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK')) &&
       sale.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK'
     ) {
       const bankCleared =
@@ -896,6 +928,7 @@ export function computeSeparatedFinancialSnapshot(
             (sale.shippingDeductedFromPayout === true ? BigInt(shippingCost) : 0n);
 
       confirmedCorpBankCash += bankCleared + adjBankRefund;
+      operatorFloat += adjFloatRefund;
       realizedSaleProfitContribution += BigInt(netRealizedCad) + adjNetRealized;
     }
   }
@@ -940,6 +973,36 @@ export function computeSeparatedFinancialSnapshot(
       exp.amountCadMinor,
       `expense[${exp.id}].amountCadMinor`,
     );
+    const floatOffset = assertNonNegativeSafeInt(
+      exp.floatOffsetAppliedCadMinor ?? 0,
+      `expense[${exp.id}].floatOffsetAppliedCadMinor`,
+    );
+    if (floatOffset > amt) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Expense "${exp.id}" floatOffsetAppliedCadMinor (${floatOffset}) exceeds amountCadMinor (${amt}).`,
+      );
+    }
+    if (floatOffset > 0 && exp.category !== 'PARTNER_PROFIT_DRAW') {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Non-draw expense "${exp.id}" cannot carry floatOffsetAppliedCadMinor.`,
+      );
+    }
+    if (exp.category === 'PARTNER_TIME_LOG_MEMO') {
+      if (
+        amt !== 0 ||
+        (exp.amountOriginalMinor ?? 0) !== 0 ||
+        exp.itcReceivableCadMinor !== 0 ||
+        exp.isDeferredIntercompanyAccrual
+      ) {
+        throw new DomainRuleError(
+          'INVALID_INPUT',
+          `PARTNER_TIME_LOG_MEMO "${exp.id}" must carry zero financial amounts and zero deferral.`,
+        );
+      }
+      continue;
+    }
     if (exp.currencyOriginal !== 'CAD' && amt === 0 && (exp.amountOriginalMinor ?? 0) > 0) {
       throw new DomainRuleError(
         'UNCONVERTED_NON_CAD_AMOUNT',
@@ -963,11 +1026,25 @@ export function computeSeparatedFinancialSnapshot(
       continue;
     }
 
-    if (exp.paidFromCashCustody === 'HELD_IN_OPERATOR_FLOAT') {
+    if (exp.category === 'PARTNER_PROFIT_DRAW' && floatOffset > 0) {
+      const signedFloatOffset = BigInt(
+        exp.isReversalEntry ? -floatOffset : floatOffset,
+      );
+      const signedBankRemainder = signedAmt - signedFloatOffset;
+      operatorFloat -= signedFloatOffset;
+      addUserFloatDelta(
+        userFloatMap,
+        exp.custodyHolderUserId ?? exp.recipientUserId ?? exp.loggedByUserId,
+        -signedFloatOffset,
+      );
+      if (signedBankRemainder !== 0n) {
+        confirmedCorpBankCash -= signedBankRemainder;
+      }
+    } else if (exp.paidFromCashCustody === 'HELD_IN_OPERATOR_FLOAT') {
       operatorFloat -= signedAmt;
       addUserFloatDelta(
         userFloatMap,
-        exp.custodyHolderUserId ?? exp.loggedByUserId,
+        exp.custodyHolderUserId ?? exp.recipientUserId ?? exp.loggedByUserId,
         -signedAmt,
       );
     } else {
@@ -1357,8 +1434,12 @@ export function evaluatePieceRatePayout(
  * Pure `RULE-PAY-002` & `RULE-PAY-003` evaluator for `PARTNER_PROFIT_DRAW`:
  * - Ring-fences loan tranches, pending receivables, accrued expenses, and `NetHstTrustLiability_CAD`.
  * - Offsets `HUNTER_MECHANIC` draws strictly against that operator's own float first.
- * - Caps bank disbursement by `AvailableWorkingCapital_CAD - minCashReserveFloorCadMinor`.
- * - Non-overridable (`cfoOverride` cannot bypass profit pool, verified-tax, or bank reserve invariants).
+ * - Caps bank disbursement by `max(0, AvailableWorkingCapital_CAD - minCashReserveFloorCadMinor)`.
+ * - Narrow reserve-floor exception: an authenticated `ARCHITECT_CFO` (`input.actor`) with a
+ *   non-blank `cfoOverride.reasonNote` may waive ONLY the `minCashReserveFloorCadMinor` reserve
+ *   gate. Profit-pool sufficiency (`distributableRealizedProfitPoolCadMinor`), hard liquidity
+ *   (`max(0, availableWorkingCapitalCadMinor)` protecting `NetHstTrustLiability_CAD`), and
+ *   caller-supplied role/ID forgery checks remain strictly non-overridable.
  */
 export function evaluatePartnerProfitDraw(
   input: PartnerProfitDrawInput,
@@ -1410,6 +1491,10 @@ export function evaluatePartnerProfitDraw(
       'maxBankDisbursementAllowedCadMinor',
     ),
   );
+  const hardBankWorkingCapitalCapCadMinor = Math.max(
+    0,
+    snapshot.availableWorkingCapitalCadMinor,
+  );
 
   const rawTargetFloat =
     input.targetOperatorFloatOverrideCadMinor !== undefined
@@ -1435,14 +1520,59 @@ export function evaluatePartnerProfitDraw(
   const blockingCodes: DomainRuleErrorCode[] = [];
   const warnings: string[] = [];
 
-  if (requestedDrawCadMinor > profitPool) {
+  const profitPoolInsufficient = requestedDrawCadMinor > profitPool;
+  const exceedsHardWorkingCapital =
+    netCashDisbursedFromBankCadMinor > hardBankWorkingCapitalCapCadMinor;
+  const breachesReserveFloorOnly =
+    !exceedsHardWorkingCapital &&
+    netCashDisbursedFromBankCadMinor > maxBankDisbursementAllowedCadMinor;
+
+  if (profitPoolInsufficient) {
     blockingCodes.push('INSUFFICIENT_REALIZED_PROFIT_POOL');
   }
-  if (netCashDisbursedFromBankCadMinor > maxBankDisbursementAllowedCadMinor) {
+  if (exceedsHardWorkingCapital) {
     blockingCodes.push('INSUFFICIENT_LIQUID_RESERVE_CAPACITY');
   }
 
-  if (input.cfoOverride?.approved === true && blockingCodes.length > 0) {
+  const overrideEval = evaluateCfoOverride(input.actor, input.cfoOverride);
+  const actorIsAuthenticatedCfo =
+    input.actor?.actorRole === 'ARCHITECT_CFO' &&
+    isNonEmptyTrimmedString(input.actor.actorUserId);
+  const trustedCfoOverrideValid =
+    overrideEval.requested &&
+    overrideEval.valid &&
+    actorIsAuthenticatedCfo &&
+    overrideEval.audit.approvedById === input.actor!.actorUserId.trim();
+
+  if (overrideEval.requested && !trustedCfoOverrideValid) {
+    const failureCode =
+      overrideEval.failureCode ?? 'CFO_OVERRIDE_UNAUTHORIZED';
+    if (!blockingCodes.includes(failureCode)) {
+      blockingCodes.push(failureCode);
+    }
+  }
+
+  let overrideApplied = false;
+  let cfoOverrideAudit = {
+    overrideApplied: false,
+    approvedById: null as string | null,
+    reasonNote: null as string | null,
+  };
+
+  if (breachesReserveFloorOnly) {
+    if (trustedCfoOverrideValid && !profitPoolInsufficient) {
+      overrideApplied = true;
+      cfoOverrideAudit = overrideEval.audit;
+      warnings.push('WORKING_CAPITAL_RESERVE_BREACHED');
+    } else {
+      blockingCodes.push('INSUFFICIENT_LIQUID_RESERVE_CAPACITY');
+    }
+  }
+
+  if (
+    overrideEval.requested &&
+    (profitPoolInsufficient || exceedsHardWorkingCapital)
+  ) {
     warnings.push('CFO_OVERRIDE_IGNORED_FOR_SOLVENCY_INVARIANT');
   }
 
@@ -1450,12 +1580,8 @@ export function evaluatePartnerProfitDraw(
     allowed: blockingCodes.length === 0,
     blockingCodes,
     warnings,
-    overrideApplied: false,
-    cfoOverrideAudit: {
-      overrideApplied: false,
-      approvedById: null,
-      reasonNote: null,
-    },
+    overrideApplied,
+    cfoOverrideAudit,
     requestedDrawCadMinor,
     distributableRealizedProfitPoolCadMinor: profitPool,
     availableWorkingCapitalCadMinor: snapshot.availableWorkingCapitalCadMinor,
diff --git a/src/modules/cfo-subledger/financial-snapshot.query.ts b/src/modules/cfo-subledger/financial-snapshot.query.ts
index ba52ef0..8e8073a 100644
--- a/src/modules/cfo-subledger/financial-snapshot.query.ts
+++ b/src/modules/cfo-subledger/financial-snapshot.query.ts
@@ -1,141 +1,347 @@
-import type { Prisma } from '@prisma/client';
+import type {
+  CashCustodyState,
+  CurrencyCode,
+  DomesticSaleChannel,
+  ExpenseCategory,
+  ExportSaleChannel,
+  InventoryAvailabilityState,
+  PartCustodyState,
+  PaymentSettlementState,
+  Prisma,
+  ReceiptVerificationState,
+  SaleMarketNode,
+  TaxCollectionMode,
+} from '@prisma/client';
 import {
   bigIntToSafeNumber,
+  computeDetailedTaxCounters,
   computeSeparatedFinancialSnapshot,
   DomainRuleError,
   type FinancialSnapshotInput,
   type SeparatedFinancialSnapshot,
   type SnapshotCashTransferRow,
+  type SnapshotDonorVehicleSummaryRow,
   type SnapshotExpenseRow,
+  type SnapshotRefundAdjustmentRow,
   type SnapshotRepatriationRow,
   type SnapshotSaleRow,
   type SnapshotScrapRow,
   type WorkingCapitalPolicySlice,
 } from '@/core/domain';
 
+const ALLOWLISTED_DIRECT_DONOR_EXPENSE_CATEGORIES: ReadonlySet<ExpenseCategory> =
+  new Set<ExpenseCategory>([
+    'AUCTION_BUYER_FEE',
+    'TOWING_AND_RECOVERY',
+    'YARD_STRIPPER_PIECE_RATE',
+    'RAMSAYVILLE_SHOP_LABOR',
+    'REFRIGERANT_EVAC_AND_PREP',
+  ]);
+
+export interface PersistedSaleLedgerRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly marketNode: SaleMarketNode;
+  readonly domesticChannel: DomesticSaleChannel | null;
+  readonly exportChannel: ExportSaleChannel | null;
+  readonly paymentCurrency: CurrencyCode;
+  readonly taxCollectionMode: TaxCollectionMode;
+  readonly subtotalMinor: number;
+  readonly taxOrVatMinor: number;
+  readonly buyerTaxRemittedByPlatformMinor: number | null;
+  readonly platformFeeMinor: number;
+  readonly shippingCostMinor: number;
+  readonly estimatedPlatformFeeTaxCadMinor: number;
+  readonly itcReceivableCadMinor: number;
+  readonly isFeeTaxInvoiceVerified: boolean;
+  readonly feeTaxInvoiceStorageKey: string | null;
+  readonly grossCollectedMinor: number;
+  readonly netRealizedCadMinor: number;
+  readonly paymentSettlementState: PaymentSettlementState;
+  readonly cashCustodyState: CashCustodyState;
+  readonly bankSettledAt: Date | string | null;
+  readonly bankDepositReference: string | null;
+  readonly soldByUserId: string;
+  readonly isVoidedOrReversed: boolean;
+  readonly reversesSaleTxId?: string | null;
+  readonly brokerCommissionMinor?: number;
+  readonly isBrokerCommissionDeductedAtCounter?: boolean;
+}
+
+export interface PersistedScrapLedgerRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly vehicleId: string;
+  readonly payoutCadMinor: number;
+  readonly cashCustodyState: CashCustodyState;
+  readonly recordedByUserId: string;
+}
+
+export interface PersistedCashTransferLedgerRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly marketNode: SaleMarketNode;
+  readonly fromCustodyState: CashCustodyState;
+  readonly toCustodyState: CashCustodyState;
+  readonly currency: CurrencyCode;
+  readonly amountMinor: number;
+  readonly equivalentCadMinor: number;
+  readonly depositSlipStorageKey: string;
+  readonly recordedByUserId: string;
+  readonly custodyHolderUserId?: string | null;
+}
+
+export interface PersistedCurrencySettlementRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly targetCurrency: CurrencyCode;
+  readonly totalTargetSettledMinor: bigint | number;
+  readonly settledInCanadaAt: Date | string | null;
+}
+
+export interface PersistedExpenseLedgerRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly category: ExpenseCategory;
+  readonly vehicleId: string | null;
+  readonly currencyOriginal: CurrencyCode;
+  readonly amountOriginalMinor: number;
+  readonly amountCadMinor: number;
+  readonly itcReceivableCadMinor: number;
+  readonly paidFromCashCustody: CashCustodyState | null;
+  readonly loggedByUserId: string;
+  readonly recipientUserId?: string | null;
+  readonly floatOffsetAppliedCadMinor?: number;
+  readonly custodyHolderUserId?: string | null;
+  readonly isDeferredIntercompanyAccrual: boolean;
+  readonly accrualSettledAt: Date | string | null;
+  readonly receiptVerificationState: ReceiptVerificationState;
+  readonly receiptStorageKey: string | null;
+  readonly isReversalEntry: boolean;
+  readonly reversesExpenseId?: string | null;
+}
+
+export interface PersistedDonorVehicleRow {
+  readonly id: string;
+  readonly organizationId: string;
+  readonly actualPurchasePriceCadMinor: number;
+  readonly scrapRecoveryCadMinor: number;
+}
+
+export interface PersistedDonorPartRow {
+  readonly id: string;
+  readonly donorVehicleId: string;
+  readonly compBaselineCadMinor: number | null;
+  readonly availabilityState: InventoryAvailabilityState;
+  readonly custodyState: PartCustodyState;
+}
+
+export interface PersistedSalePartItemRow {
+  readonly saleTransactionId: string;
+  readonly partId: string;
+  readonly soldPriceMinor: number;
+  readonly isActiveSale: boolean;
+}
+
+export interface PersistedTaxAndLiquidityCounters {
+  readonly directTaxCollectedNetOfRefundsCadMinor: number;
+  readonly buyerTaxRemittedByPlatformCadMinor: number | null;
+  readonly hasUnknownMarketplaceBuyerTax: boolean;
+  readonly unverifiedPlatformFeeTaxAccruedCadMinor: number;
+  readonly verifiedItcReceivableCadMinor: number;
+  readonly netHstTrustLiabilityCadMinor: number;
+}
+
 export interface PersistedLedgerProjection {
   readonly snapshotInput: FinancialSnapshotInput;
   readonly snapshot: SeparatedFinancialSnapshot;
+  readonly taxCounters: PersistedTaxAndLiquidityCounters;
+  readonly destinationVaultCashByCurrency: Readonly<Record<string, number>>;
+}
+
+function normalizeSignedMagnitude(
+  value: number,
+  expectedDirection: 'NON_NEGATIVE' | 'NON_POSITIVE',
+  fieldLabel: string,
+): number {
+  if (!Number.isSafeInteger(value)) {
+    throw new DomainRuleError(
+      'INVALID_MONETARY_AMOUNT',
+      `${fieldLabel} must be a finite safe integer.`,
+    );
+  }
+  if (expectedDirection === 'NON_NEGATIVE' && value < 0) {
+    throw new DomainRuleError(
+      'INVALID_INPUT',
+      `${fieldLabel} has mixed sign inside reversal SaleTransaction.`,
+    );
+  }
+  if (expectedDirection === 'NON_POSITIVE' && value > 0) {
+    throw new DomainRuleError(
+      'INVALID_INPUT',
+      `${fieldLabel} has mixed sign inside reversal SaleTransaction.`,
+    );
+  }
+  return -Math.abs(value);
 }
 
 /**
- * Reads persisted ledger tables within an active `withTenantTransaction` (`tx`)
- * and delegates all 7-metric liquidity, pending-receivable, float, and CRA HST
- * trust calculations to `computeSeparatedFinancialSnapshot`.
+ * Pure normalization contract converting persisted database rows (including linked
+ * `SaleTransaction.reversesSaleTxId` reversals, donor vehicle/part projections, and
+ * tax/ITC counters) into `SeparatedFinancialSnapshot` inputs.
+ *
+ * Contract for downstream checkout consumers (Issue #10):
+ * - A persisted reversal `SaleTransaction` MUST set `reversesSaleTxId` to a non-reversal
+ *   parent sale in the same organization with matching `marketNode`, `paymentCurrency`, and
+ *   `taxCollectionMode`, and MUST NOT set `isVoidedOrReversed = true` on the reversal row itself.
+ * - Reversal monetary fields (`subtotalMinor`, `taxOrVatMinor`, `grossCollectedMinor`,
+ *   `netRealizedCadMinor`, `itcReceivableCadMinor`) may be stored as non-negative magnitudes
+ *   or signed negative integers (never mixed signs within one row) and are normalized into
+ *   negative `SnapshotRefundAdjustmentRow` values attributed to the reversal's custody/settlement state.
  */
-export async function querySeparatedFinancialSnapshot(
-  tx: Prisma.TransactionClient,
-  organizationId: string,
-  policy: WorkingCapitalPolicySlice,
-): Promise<SeparatedFinancialSnapshot> {
-  const projection = await loadPersistedFinancialSnapshot(
-    tx,
-    organizationId,
-    policy,
+export function buildPersistedLedgerProjection(params: {
+  readonly organizationId: string;
+  readonly policy: WorkingCapitalPolicySlice;
+  readonly saleRows: readonly PersistedSaleLedgerRow[];
+  readonly scrapRows: readonly PersistedScrapLedgerRow[];
+  readonly transferRows: readonly PersistedCashTransferLedgerRow[];
+  readonly settlementRows: readonly PersistedCurrencySettlementRow[];
+  readonly expenseRows: readonly PersistedExpenseLedgerRow[];
+  readonly vehicleRows?: readonly PersistedDonorVehicleRow[];
+  readonly partRows?: readonly PersistedDonorPartRow[];
+  readonly salePartItemRows?: readonly PersistedSalePartItemRow[];
+}): PersistedLedgerProjection {
+  const normalizedOrgId = params.organizationId.toLowerCase();
+  const baseSaleRows: PersistedSaleLedgerRow[] = [];
+  const reversalRows: PersistedSaleLedgerRow[] = [];
+
+  for (const row of params.saleRows) {
+    if (row.organizationId.toLowerCase() !== normalizedOrgId) {
+      throw new DomainRuleError(
+        'ORGANIZATION_MISMATCH',
+        `SaleTransaction "${row.id}" belongs to a different organization.`,
+      );
+    }
+    if (row.reversesSaleTxId) {
+      reversalRows.push(row);
+    } else {
+      baseSaleRows.push(row);
+    }
+  }
+
+  const baseSaleMap = new Map(
+    baseSaleRows.map((row) => [row.id.toLowerCase(), row]),
   );
-  return projection.snapshot;
-}
 
-export async function loadPersistedFinancialSnapshot(
-  tx: Prisma.TransactionClient,
-  organizationId: string,
-  policy: WorkingCapitalPolicySlice,
-): Promise<PersistedLedgerProjection> {
-  const [saleRows, scrapRows, transferRows, settlementRows, expenseRows] =
-    await Promise.all([
-      tx.saleTransaction.findMany({
-        where: { organizationId },
-        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          marketNode: true,
-          domesticChannel: true,
-          exportChannel: true,
-          paymentCurrency: true,
-          taxCollectionMode: true,
-          subtotalMinor: true,
-          taxOrVatMinor: true,
-          buyerTaxRemittedByPlatformMinor: true,
-          platformFeeMinor: true,
-          shippingCostMinor: true,
-          estimatedPlatformFeeTaxCadMinor: true,
-          itcReceivableCadMinor: true,
-          isFeeTaxInvoiceVerified: true,
-          feeTaxInvoiceStorageKey: true,
-          grossCollectedMinor: true,
-          netRealizedCadMinor: true,
-          paymentSettlementState: true,
-          cashCustodyState: true,
-          bankSettledAt: true,
-          bankDepositReference: true,
-          soldByUserId: true,
-          isVoidedOrReversed: true,
-        },
-      }),
-      tx.scrapComponentLog.findMany({
-        where: { organizationId },
-        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          vehicleId: true,
-          payoutCadMinor: true,
-          cashCustodyState: true,
-          recordedByUserId: true,
-        },
-      }),
-      tx.cashCustodyTransfer.findMany({
-        where: { organizationId },
-        orderBy: [{ transferredAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          marketNode: true,
-          fromCustodyState: true,
-          toCustodyState: true,
-          currency: true,
-          amountMinor: true,
-          equivalentCadMinor: true,
-          depositSlipStorageKey: true,
-          recordedByUserId: true,
-        },
-      }),
-      tx.currencySettlement.findMany({
-        where: { organizationId },
-        orderBy: [{ initiatedAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          targetCurrency: true,
-          totalTargetSettledMinor: true,
-          settledInCanadaAt: true,
-        },
-      }),
-      tx.expense.findMany({
-        where: { organizationId },
-        orderBy: [{ incurredAt: 'asc' }, { id: 'asc' }],
-        select: {
-          id: true,
-          organizationId: true,
-          category: true,
-          vehicleId: true,
-          currencyOriginal: true,
-          amountOriginalMinor: true,
-          amountCadMinor: true,
-          itcReceivableCadMinor: true,
-          paidFromCashCustody: true,
-          loggedByUserId: true,
-          isDeferredIntercompanyAccrual: true,
-          accrualSettledAt: true,
-          receiptVerificationState: true,
-          receiptStorageKey: true,
-          isReversalEntry: true,
-        },
-      }),
-    ]);
+  const refundAdjustments: SnapshotRefundAdjustmentRow[] = [];
+  const reversalsByOriginalSaleId = new Map<string, PersistedSaleLedgerRow[]>();
+
+  for (const rev of reversalRows) {
+    const revId = rev.id.toLowerCase();
+    const targetId = rev.reversesSaleTxId!.toLowerCase();
+    if (revId === targetId) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `SaleTransaction "${rev.id}" cannot reverse itself.`,
+      );
+    }
+    if (rev.isVoidedOrReversed) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Reversal SaleTransaction "${rev.id}" cannot itself be voided or reversed.`,
+      );
+    }
+    const original = baseSaleMap.get(targetId);
+    if (!original) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Reversal SaleTransaction "${rev.id}" references missing or chained sale "${rev.reversesSaleTxId}".`,
+      );
+    }
+    if (
+      rev.marketNode !== original.marketNode ||
+      rev.paymentCurrency !== original.paymentCurrency ||
+      rev.taxCollectionMode !== original.taxCollectionMode
+    ) {
+      throw new DomainRuleError(
+        'INVALID_INPUT',
+        `Reversal SaleTransaction "${rev.id}" mismatches original sale node, currency, or tax collection mode.`,
+      );
+    }
 
-  const sales: SnapshotSaleRow[] = saleRows.map((row) => ({
+    const direction: 'NON_NEGATIVE' | 'NON_POSITIVE' =
+      rev.subtotalMinor < 0 ||
+      rev.grossCollectedMinor < 0 ||
+      rev.taxOrVatMinor < 0 ||
+      rev.netRealizedCadMinor < 0
+        ? 'NON_POSITIVE'
+        : 'NON_NEGATIVE';
+
+    const subtotalAdj = normalizeSignedMagnitude(
+      rev.subtotalMinor,
+      direction,
+      `reversal[${rev.id}].subtotalMinor`,
+    );
+    const taxAdj = normalizeSignedMagnitude(
+      rev.taxOrVatMinor,
+      direction,
+      `reversal[${rev.id}].taxOrVatMinor`,
+    );
+    const grossAdj = normalizeSignedMagnitude(
+      rev.grossCollectedMinor,
+      direction,
+      `reversal[${rev.id}].grossCollectedMinor`,
+    );
+    const netAdj = normalizeSignedMagnitude(
+      rev.netRealizedCadMinor,
+      direction,
+      `reversal[${rev.id}].netRealizedCadMinor`,
+    );
+    const itcAdj = normalizeSignedMagnitude(
+      rev.itcReceivableCadMinor,
+      direction,
+      `reversal[${rev.id}].itcReceivableCadMinor`,
+    );
+
+    const refundSettlementAccount: SnapshotRefundAdjustmentRow['refundSettlementAccount'] =
+      rev.cashCustodyState === 'SETTLED_ORIGIN_CORP_BANK' ||
+      rev.paymentSettlementState === 'BANK_SETTLEMENT_CONFIRMED'
+        ? 'CORP_BANK'
+        : rev.cashCustodyState === 'HELD_IN_OPERATOR_FLOAT' ||
+            rev.paymentSettlementState === 'PAYMENT_CONFIRMED'
+          ? 'OPERATOR_FLOAT'
+          : 'PENDING_EXTERNAL_RECEIVABLE';
+
+    const originalFeeTaxVerified =
+      original.isFeeTaxInvoiceVerified === true &&
+      typeof original.feeTaxInvoiceStorageKey === 'string' &&
+      original.feeTaxInvoiceStorageKey.trim().length > 0;
+
+    refundAdjustments.push({
+      id: revId,
+      organizationId: normalizedOrgId,
+      originalSaleId: targetId,
+      taxCollectionMode: rev.taxCollectionMode,
+      gstHstAdjustmentCadMinor:
+        rev.marketNode === 'DOMESTIC_ORIGIN' &&
+        rev.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
+          ? taxAdj
+          : 0,
+      itcAdjustmentCadMinor: itcAdj,
+      isFeeTaxInvoiceVerified: originalFeeTaxVerified,
+      subtotalAdjustmentMinor: subtotalAdj,
+      grossAdjustmentMinor: grossAdj,
+      netRealizedCadAdjustmentMinor: netAdj,
+      refundSettlementAccount,
+      custodyHolderUserId: rev.soldByUserId.toLowerCase(),
+    });
+
+    const list = reversalsByOriginalSaleId.get(targetId) ?? [];
+    list.push(rev);
+    reversalsByOriginalSaleId.set(targetId, list);
+  }
+
+  const sales: SnapshotSaleRow[] = baseSaleRows.map((row) => ({
     id: row.id.toLowerCase(),
     organizationId: row.organizationId.toLowerCase(),
     marketNode: row.marketNode,
@@ -167,7 +373,7 @@ export async function loadPersistedFinancialSnapshot(
     isVoidedOrReversed: row.isVoidedOrReversed,
   }));
 
-  const scrapLogs: SnapshotScrapRow[] = scrapRows.map((row) => ({
+  const scrapLogs: SnapshotScrapRow[] = params.scrapRows.map((row) => ({
     id: row.id.toLowerCase(),
     organizationId: row.organizationId.toLowerCase(),
     vehicleId: row.vehicleId.toLowerCase(),
@@ -176,21 +382,25 @@ export async function loadPersistedFinancialSnapshot(
     custodyHolderUserId: row.recordedByUserId.toLowerCase(),
   }));
 
-  const cashTransfers: SnapshotCashTransferRow[] = transferRows.map((row) => ({
-    id: row.id.toLowerCase(),
-    organizationId: row.organizationId.toLowerCase(),
-    marketNode: row.marketNode,
-    fromCustodyState: row.fromCustodyState,
-    toCustodyState: row.toCustodyState,
-    currency: row.currency,
-    amountMinor: row.amountMinor,
-    equivalentCadMinor: row.equivalentCadMinor,
-    depositSlipStorageKey: row.depositSlipStorageKey,
-    operatorUserId: row.recordedByUserId.toLowerCase(),
-  }));
+  const cashTransfers: SnapshotCashTransferRow[] = params.transferRows.map(
+    (row) => ({
+      id: row.id.toLowerCase(),
+      organizationId: row.organizationId.toLowerCase(),
+      marketNode: row.marketNode,
+      fromCustodyState: row.fromCustodyState,
+      toCustodyState: row.toCustodyState,
+      currency: row.currency,
+      amountMinor: row.amountMinor,
+      equivalentCadMinor: row.equivalentCadMinor,
+      depositSlipStorageKey: row.depositSlipStorageKey,
+      operatorUserId: (
+        row.custodyHolderUserId ?? row.recordedByUserId
+      ).toLowerCase(),
+    }),
+  );
 
-  const repatriationSettlements: SnapshotRepatriationRow[] = settlementRows.map(
-    (row) => {
+  const repatriationSettlements: SnapshotRepatriationRow[] =
+    params.settlementRows.map((row) => {
       if (row.settledInCanadaAt !== null && row.targetCurrency !== 'CAD') {
         throw new DomainRuleError(
           'UNCONVERTED_NON_CAD_AMOUNT',
@@ -200,19 +410,21 @@ export async function loadPersistedFinancialSnapshot(
       return {
         id: row.id.toLowerCase(),
         organizationId: row.organizationId.toLowerCase(),
-        targetSettledCadMinor: bigIntToSafeNumber(
-          row.totalTargetSettledMinor,
-          `currencySettlement[${row.id}].totalTargetSettledMinor`,
-        ),
+        targetSettledCadMinor:
+          typeof row.totalTargetSettledMinor === 'number'
+            ? row.totalTargetSettledMinor
+            : bigIntToSafeNumber(
+                row.totalTargetSettledMinor,
+                `currencySettlement[${row.id}].totalTargetSettledMinor`,
+              ),
         cashCustodyState:
           row.settledInCanadaAt !== null
             ? 'SETTLED_ORIGIN_CORP_BANK'
             : 'PENDING_EXTERNAL_RECEIVABLE',
       };
-    },
-  );
+    });
 
-  const expenses: SnapshotExpenseRow[] = expenseRows.map((row) => ({
+  const expenses: SnapshotExpenseRow[] = params.expenseRows.map((row) => ({
     id: row.id.toLowerCase(),
     organizationId: row.organizationId.toLowerCase(),
     category: row.category,
@@ -222,6 +434,13 @@ export async function loadPersistedFinancialSnapshot(
     amountCadMinor: row.amountCadMinor,
     itcReceivableCadMinor: row.itcReceivableCadMinor,
     paidFromCashCustody: row.paidFromCashCustody,
+    custodyHolderUserId: row.custodyHolderUserId
+      ? row.custodyHolderUserId.toLowerCase()
+      : null,
+    recipientUserId: row.recipientUserId
+      ? row.recipientUserId.toLowerCase()
+      : null,
+    floatOffsetAppliedCadMinor: row.floatOffsetAppliedCadMinor ?? 0,
     loggedByUserId: row.loggedByUserId.toLowerCase(),
     isDeferredIntercompanyAccrual: row.isDeferredIntercompanyAccrual,
     accrualSettledAt: row.accrualSettledAt,
@@ -230,21 +449,495 @@ export async function loadPersistedFinancialSnapshot(
     isReversalEntry: row.isReversalEntry,
   }));
 
+  // Build donor vehicle summaries when vehicle rows are supplied
+  const extraWarnings: string[] = [];
+  const donorVehicles: SnapshotDonorVehicleSummaryRow[] = [];
+
+  if (params.vehicleRows && params.vehicleRows.length > 0) {
+    const scrapByVehicle = new Map<string, number>();
+    for (const s of scrapLogs) {
+      scrapByVehicle.set(
+        s.vehicleId,
+        (scrapByVehicle.get(s.vehicleId) ?? 0) + s.payoutCadMinor,
+      );
+    }
+
+    const directExpensesByVehicle = new Map<string, number>();
+    const expenseById = new Map(
+      params.expenseRows.map((e) => [e.id.toLowerCase(), e]),
+    );
+    const reversedAmountByExpenseId = new Map<string, number>();
+    for (const e of params.expenseRows) {
+      if (e.isReversalEntry && e.reversesExpenseId) {
+        const targetId = e.reversesExpenseId.toLowerCase();
+        reversedAmountByExpenseId.set(
+          targetId,
+          (reversedAmountByExpenseId.get(targetId) ?? 0) + e.amountCadMinor,
+        );
+      }
+    }
+    for (const e of params.expenseRows) {
+      if (
+        e.isReversalEntry ||
+        !e.vehicleId ||
+        !ALLOWLISTED_DIRECT_DONOR_EXPENSE_CATEGORIES.has(e.category)
+      ) {
+        continue;
+      }
+      const vehId = e.vehicleId.toLowerCase();
+      const reversed = reversedAmountByExpenseId.get(e.id.toLowerCase()) ?? 0;
+      const net = Math.max(0, e.amountCadMinor - reversed);
+      directExpensesByVehicle.set(
+        vehId,
+        (directExpensesByVehicle.get(vehId) ?? 0) + net,
+      );
+    }
+    void expenseById;
+
+    const activeCadSaleIds = new Set(
+      baseSaleRows
+        .filter(
+          (s) =>
+            s.paymentCurrency === 'CAD' &&
+            !s.isVoidedOrReversed &&
+            s.paymentSettlementState !== 'REFUNDED_OR_CHARGED_BACK',
+        )
+        .map((s) => s.id.toLowerCase()),
+    );
+
+    const partById = new Map(
+      (params.partRows ?? []).map((p) => [p.id.toLowerCase(), p]),
+    );
+    const activeSoldPartIds = new Set<string>();
+    const realizedPartsByVehicle = new Map<string, number>();
+
+    for (const item of params.salePartItemRows ?? []) {
+      if (!item.isActiveSale) {
+        continue;
+      }
+      const saleId = item.saleTransactionId.toLowerCase();
+      const partId = item.partId.toLowerCase();
+      activeSoldPartIds.add(partId);
+      if (!activeCadSaleIds.has(saleId)) {
+        continue;
+      }
+      const part = partById.get(partId);
+      if (!part) {
+        continue;
+      }
+      const vehId = part.donorVehicleId.toLowerCase();
+      realizedPartsByVehicle.set(
+        vehId,
+        (realizedPartsByVehicle.get(vehId) ?? 0) + item.soldPriceMinor,
+      );
+    }
+
+    const projectedRemainingByVehicle = new Map<string, number>();
+    let hasMissingCompBaseline = false;
+    for (const part of params.partRows ?? []) {
+      const partId = part.id.toLowerCase();
+      const vehId = part.donorVehicleId.toLowerCase();
+      const isSoldOrScrapped =
+        activeSoldPartIds.has(partId) ||
+        part.availabilityState === 'PAID_SETTLED' ||
+        part.custodyState === 'SOLD_AND_RELEASED' ||
+        part.custodyState === 'SCRAPPED_OR_DAMAGED';
+      if (isSoldOrScrapped) {
+        continue;
+      }
+      if (part.compBaselineCadMinor === null) {
+        hasMissingCompBaseline = true;
+        continue;
+      }
+      projectedRemainingByVehicle.set(
+        vehId,
+        (projectedRemainingByVehicle.get(vehId) ?? 0) +
+          part.compBaselineCadMinor,
+      );
+    }
+    if (hasMissingCompBaseline) {
+      extraWarnings.push('DONOR_MISSING_PART_COMP_BASELINE');
+    }
+
+    for (const veh of params.vehicleRows) {
+      const vehId = veh.id.toLowerCase();
+      const scrapTotal = scrapByVehicle.has(vehId)
+        ? scrapByVehicle.get(vehId)!
+        : veh.scrapRecoveryCadMinor;
+      donorVehicles.push({
+        id: vehId,
+        organizationId: normalizedOrgId,
+        totalAcquisitionAndStripCostCadMinor:
+          veh.actualPurchasePriceCadMinor +
+          (directExpensesByVehicle.get(vehId) ?? 0),
+        scrapRecoveryCadMinor: scrapTotal,
+        realizedPartSalesCadMinor: realizedPartsByVehicle.get(vehId) ?? 0,
+        projectedRemainingPartsCadMinor:
+          projectedRemainingByVehicle.get(vehId) ?? 0,
+      });
+    }
+  }
+
   const snapshotInput: FinancialSnapshotInput = {
-    organizationId: organizationId.toLowerCase(),
-    tranches: policy.operationalGates.workingCapitalGate.tranches.map((t) => ({
-      trancheCode: t.trancheCode,
-      principalCadMinor: t.principalCadMinor,
-      unlocked: t.unlocked,
-    })),
+    organizationId: normalizedOrgId,
+    tranches: params.policy.operationalGates.workingCapitalGate.tranches.map(
+      (t) => ({
+        trancheCode: t.trancheCode,
+        principalCadMinor: t.principalCadMinor,
+        unlocked: t.unlocked,
+      }),
+    ),
     sales,
+    refundAdjustments,
     scrapLogs,
     cashTransfers,
     repatriationSettlements,
     expenses,
+    donorVehicles,
     priorPartnerDrawsCadMinor: 0,
   };
 
-  const snapshot = computeSeparatedFinancialSnapshot(snapshotInput, policy);
-  return { snapshotInput, snapshot };
+  const baseSnapshot = computeSeparatedFinancialSnapshot(
+    snapshotInput,
+    params.policy,
+  );
+  const snapshot: SeparatedFinancialSnapshot =
+    extraWarnings.length > 0
+      ? {
+          ...baseSnapshot,
+          warnings: [...baseSnapshot.warnings, ...extraWarnings],
+        }
+      : baseSnapshot;
+
+  const detailedTax = computeDetailedTaxCounters({
+    organizationId: normalizedOrgId,
+    sales: sales.map((s) => ({
+      id: s.id,
+      organizationId: s.organizationId,
+      taxCollectionMode: s.taxCollectionMode,
+      gstHstTaxCadMinor:
+        s.gstHstTaxCadMinor ??
+        (s.taxCollectionMode === 'DIRECT_SELLER_COLLECTED'
+          ? s.taxOrVatMinor
+          : 0),
+      provincialTaxCadMinor: s.provincialTaxCadMinor,
+      itcReceivableCadMinor: s.itcReceivableCadMinor,
+      estimatedPlatformFeeTaxCadMinor: s.estimatedPlatformFeeTaxCadMinor,
+      isFeeTaxInvoiceVerified: s.isFeeTaxInvoiceVerified,
+      feeTaxInvoiceStorageKey: s.feeTaxInvoiceStorageKey,
+      paymentSettlementState: s.paymentSettlementState,
+      isVoidedOrReversed: s.isVoidedOrReversed,
+    })),
+    expenses: expenses.map((e) => ({
+      id: e.id,
+      organizationId: e.organizationId,
+      itcReceivableCadMinor: e.itcReceivableCadMinor,
+      receiptVerificationState: e.receiptVerificationState,
+      receiptStorageKey: e.receiptStorageKey,
+      isReversalEntry: e.isReversalEntry,
+      isVoidedOrReversed: e.isVoidedOrReversed,
+    })),
+    refundAdjustments,
+  });
+
+  // Compute authoritative marketplace buyer tax sum (nullable) & unverified platform fee tax
+  let buyerTaxSum: number | null = null;
+  let hasUnknownMarketplaceBuyerTax = false;
+  let unverifiedPlatformFeeTaxAccruedCadMinor = 0;
+
+  for (const row of baseSaleRows) {
+    const saleId = row.id.toLowerCase();
+    const rowReversals = reversalsByOriginalSaleId.get(saleId) ?? [];
+    const isFullyReversedWithoutAdjustments =
+      rowReversals.length === 0 &&
+      (row.isVoidedOrReversed === true ||
+        row.paymentSettlementState === 'REFUNDED_OR_CHARGED_BACK');
+    if (isFullyReversedWithoutAdjustments) {
+      continue;
+    }
+
+    const isMarketplaceFacilitated =
+      row.taxCollectionMode === 'MARKETPLACE_FACILITATOR_COLLECTED' ||
+      row.domesticChannel === 'EBAY_MOTORS_SHIPPED';
+
+    if (isMarketplaceFacilitated && row.paymentCurrency === 'CAD') {
+      if (
+        row.buyerTaxRemittedByPlatformMinor !== null &&
+        row.buyerTaxRemittedByPlatformMinor !== undefined
+      ) {
+        let netBuyerTax = row.buyerTaxRemittedByPlatformMinor;
+        let reversedAllWithoutValue = false;
+        for (const rev of rowReversals) {
+          if (
+            rev.buyerTaxRemittedByPlatformMinor !== null &&
+            rev.buyerTaxRemittedByPlatformMinor !== undefined
+          ) {
+            netBuyerTax -= Math.abs(rev.buyerTaxRemittedByPlatformMinor);
+          } else if (row.isVoidedOrReversed) {
+            reversedAllWithoutValue = true;
+          }
+        }
+        const effectiveBuyerTax = reversedAllWithoutValue
+          ? 0
+          : Math.max(0, netBuyerTax);
+        buyerTaxSum = (buyerTaxSum ?? 0) + effectiveBuyerTax;
+      } else {
+        hasUnknownMarketplaceBuyerTax = true;
+      }
+    }
+
+    const feeInvoiceVerified =
+      row.isFeeTaxInvoiceVerified === true &&
+      typeof row.feeTaxInvoiceStorageKey === 'string' &&
+      row.feeTaxInvoiceStorageKey.trim().length > 0;
+
+    if (!feeInvoiceVerified && row.estimatedPlatformFeeTaxCadMinor > 0) {
+      let netUnverified = row.estimatedPlatformFeeTaxCadMinor;
+      for (const rev of rowReversals) {
+        netUnverified -= Math.abs(rev.estimatedPlatformFeeTaxCadMinor);
+      }
+      if (!row.isVoidedOrReversed || rowReversals.length > 0) {
+        unverifiedPlatformFeeTaxAccruedCadMinor += Math.max(0, netUnverified);
+      }
+    }
+  }
+
+  // Destination vault physical cash held per currency (fail-closed at 0 when no vault sales exist)
+  const destinationVaultCashByCurrency: Record<string, number> = {};
+  for (const row of baseSaleRows) {
+    if (
+      row.marketNode === 'DESTINATION_EXPORT_VAULT' &&
+      row.cashCustodyState === 'HELD_IN_DESTINATION_VAULT' &&
+      !row.isVoidedOrReversed &&
+      row.paymentSettlementState !== 'REFUNDED_OR_CHARGED_BACK'
+    ) {
+      const counterDeduction =
+        row.isBrokerCommissionDeductedAtCounter === true
+          ? (row.brokerCommissionMinor ?? 0)
+          : 0;
+      const netCounterCash = Math.max(
+        0,
+        row.grossCollectedMinor - counterDeduction,
+      );
+      destinationVaultCashByCurrency[row.paymentCurrency] =
+        (destinationVaultCashByCurrency[row.paymentCurrency] ?? 0) +
+        netCounterCash;
+    }
+  }
+  for (const t of params.transferRows) {
+    if (
+      t.fromCustodyState === 'HELD_IN_DESTINATION_VAULT' &&
+      t.toCustodyState === 'DEPOSITED_DESTINATION_BANK'
+    ) {
+      destinationVaultCashByCurrency[t.currency] =
+        (destinationVaultCashByCurrency[t.currency] ?? 0) - t.amountMinor;
+    }
+  }
+
+  return {
+    snapshotInput,
+    snapshot,
+    taxCounters: {
+      directTaxCollectedNetOfRefundsCadMinor:
+        detailedTax.directTaxCollectedNetOfRefundsCadMinor,
+      buyerTaxRemittedByPlatformCadMinor: buyerTaxSum,
+      hasUnknownMarketplaceBuyerTax,
+      unverifiedPlatformFeeTaxAccruedCadMinor,
+      verifiedItcReceivableCadMinor: detailedTax.verifiedItcReceivableCadMinor,
+      netHstTrustLiabilityCadMinor: detailedTax.netHstTrustLiabilityCadMinor,
+    },
+    destinationVaultCashByCurrency,
+  };
+}
+
+/**
+ * Reads persisted ledger tables within an active `withTenantTransaction` (`tx`)
+ * and delegates all 7-metric liquidity, pending-receivable, float, and CRA HST
+ * trust calculations to `computeSeparatedFinancialSnapshot`.
+ */
+export async function querySeparatedFinancialSnapshot(
+  tx: Prisma.TransactionClient,
+  organizationId: string,
+  policy: WorkingCapitalPolicySlice,
+): Promise<SeparatedFinancialSnapshot> {
+  const projection = await loadPersistedFinancialSnapshot(
+    tx,
+    organizationId,
+    policy,
+  );
+  return projection.snapshot;
+}
+
+export async function loadPersistedFinancialSnapshot(
+  tx: Prisma.TransactionClient,
+  organizationId: string,
+  policy: WorkingCapitalPolicySlice,
+): Promise<PersistedLedgerProjection> {
+  const hasDonorTables =
+    typeof (tx as unknown as { vehicle?: { findMany?: unknown } }).vehicle
+      ?.findMany === 'function' &&
+    typeof (tx as unknown as { part?: { findMany?: unknown } }).part
+      ?.findMany === 'function' &&
+    typeof (
+      tx as unknown as { saleTransactionPartItem?: { findMany?: unknown } }
+    ).saleTransactionPartItem?.findMany === 'function';
+
+  const [
+    saleRows,
+    scrapRows,
+    transferRows,
+    settlementRows,
+    expenseRows,
+    vehicleRows,
+    partRows,
+    salePartItemRows,
+  ] = await Promise.all([
+    tx.saleTransaction.findMany({
+      where: { organizationId },
+      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        marketNode: true,
+        domesticChannel: true,
+        exportChannel: true,
+        paymentCurrency: true,
+        taxCollectionMode: true,
+        subtotalMinor: true,
+        taxOrVatMinor: true,
+        buyerTaxRemittedByPlatformMinor: true,
+        platformFeeMinor: true,
+        shippingCostMinor: true,
+        estimatedPlatformFeeTaxCadMinor: true,
+        itcReceivableCadMinor: true,
+        isFeeTaxInvoiceVerified: true,
+        feeTaxInvoiceStorageKey: true,
+        grossCollectedMinor: true,
+        netRealizedCadMinor: true,
+        paymentSettlementState: true,
+        cashCustodyState: true,
+        bankSettledAt: true,
+        bankDepositReference: true,
+        soldByUserId: true,
+        isVoidedOrReversed: true,
+        reversesSaleTxId: true,
+        brokerCommissionMinor: true,
+        isBrokerCommissionDeductedAtCounter: true,
+      },
+    }),
+    tx.scrapComponentLog.findMany({
+      where: { organizationId },
+      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        vehicleId: true,
+        payoutCadMinor: true,
+        cashCustodyState: true,
+        recordedByUserId: true,
+      },
+    }),
+    tx.cashCustodyTransfer.findMany({
+      where: { organizationId },
+      orderBy: [{ transferredAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        marketNode: true,
+        fromCustodyState: true,
+        toCustodyState: true,
+        currency: true,
+        amountMinor: true,
+        equivalentCadMinor: true,
+        depositSlipStorageKey: true,
+        recordedByUserId: true,
+        custodyHolderUserId: true,
+      },
+    }),
+    tx.currencySettlement.findMany({
+      where: { organizationId },
+      orderBy: [{ initiatedAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        targetCurrency: true,
+        totalTargetSettledMinor: true,
+        settledInCanadaAt: true,
+      },
+    }),
+    tx.expense.findMany({
+      where: { organizationId },
+      orderBy: [{ incurredAt: 'asc' }, { id: 'asc' }],
+      select: {
+        id: true,
+        organizationId: true,
+        category: true,
+        vehicleId: true,
+        currencyOriginal: true,
+        amountOriginalMinor: true,
+        amountCadMinor: true,
+        itcReceivableCadMinor: true,
+        paidFromCashCustody: true,
+        loggedByUserId: true,
+        recipientUserId: true,
+        floatOffsetAppliedCadMinor: true,
+        custodyHolderUserId: true,
+        isDeferredIntercompanyAccrual: true,
+        accrualSettledAt: true,
+        receiptVerificationState: true,
+        receiptStorageKey: true,
+        isReversalEntry: true,
+        reversesExpenseId: true,
+      },
+    }),
+    hasDonorTables
+      ? tx.vehicle.findMany({
+          where: { organizationId },
+          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
+          select: {
+            id: true,
+            organizationId: true,
+            actualPurchasePriceCadMinor: true,
+            scrapRecoveryCadMinor: true,
+          },
+        })
+      : Promise.resolve([]),
+    hasDonorTables
+      ? tx.part.findMany({
+          where: { organizationId },
+          orderBy: [{ strippedAt: 'asc' }, { id: 'asc' }],
+          select: {
+            id: true,
+            donorVehicleId: true,
+            compBaselineCadMinor: true,
+            availabilityState: true,
+            custodyState: true,
+          },
+        })
+      : Promise.resolve([]),
+    hasDonorTables
+      ? tx.saleTransactionPartItem.findMany({
+          where: { organizationId, isActiveSale: true },
+          select: {
+            saleTransactionId: true,
+            partId: true,
+            soldPriceMinor: true,
+            isActiveSale: true,
+          },
+        })
+      : Promise.resolve([]),
+  ]);
+
+  return buildPersistedLedgerProjection({
+    organizationId,
+    policy,
+    saleRows,
+    scrapRows,
+    transferRows,
+    settlementRows,
+    expenseRows,
+    vehicleRows,
+    partRows,
+    salePartItemRows,
+  });
 }
```

## REQUIRED OUTPUT CONTRACT

All string values in the JSON output must be valid JSON string literals. If evidence, rationale, summary, or other freeform text (including embedded Markdown such as design_md/plan_md) quotes a code identifier, file path, backslash-containing path, or literal string, escape every `"` as `\"` and every backslash as `\\` inside that value. Do not emit a raw, unescaped `"` or `\` inside a JSON string.

You MUST write your review directly to `./follow-up-review-result.json`.
Writing your verdict or evaluations as markdown prose, stdout output, or conversational summaries CANNOT replace `./follow-up-review-result.json`. If `./follow-up-review-result.json` is missing or fails JSON/schema validation, this phase fails contract validation.

### Allowed Verdict Values
The `verdict` field must be exactly one of the following accepted enum literals:
- `APPROVE`
- `REQUEST_CHANGES`
- `approve`
- `request_changes`
- `PASS`
- `FAIL`
- `pass`
- `fail`

CRITICAL: The literal `"APPROVED"` is NOT valid and will cause schema validation rejection. You must use `"APPROVE"` (or `"REQUEST_CHANGES"`).

### JSON Schema & Field Requirements
Write valid JSON to `./follow-up-review-result.json` matching the schema:
- `verdict` (string, required): Exactly one of the accepted enum literals above (`"APPROVE"` or `"REQUEST_CHANGES"`).
- `evaluations` (array of objects, default: `[]`):
  For each finding in the ledger:
  - `finding_id` (string, required, non-empty): Exact finding ID from the ledger.
  - `resolved` (boolean, required): `true` if verified resolved, `false` otherwise.
  - `evidence` (string, required, non-empty): Concrete file:line citations and verification evidence.
  - `rationale` (string, optional): Context or explanation for the evaluation.
- `new_findings` (array of objects, optional, default: `[]`): Any new defects or regressions discovered.
- `summary` (string, optional): High-level summary of the follow-up review.
- `review_md` (string, optional): Markdown-formatted review notes.

```json
{
  "verdict": "APPROVE",
  "evaluations": [
    {
      "finding_id": "Finding ID from ledger",
      "resolved": true,
      "evidence": "Evidence citing exact file:line showing resolution",
      "rationale": "Optional explanation"
    }
  ],
  "new_findings": [
    {
      "severity": "critical",
      "files": ["path/to/file.ts"],
      "evidence": "Concrete evidence",
      "rationale": "Why this matters",
      "minimal_correction": "Smallest correction",
      "blocking": true
    }
  ],
  "summary": "Summary of follow-up review."
}
```

## TASK

Perform a focused follow-up review grounded in the issue, acceptance criteria, design, accumulated finding ledger, and diffs above.

Your responsibilities:

1. **Evaluate Prior Findings**:
   - For every unresolved finding in the accumulated finding ledger, evaluate whether it is now `resolved: true` or `resolved: false`.
   - Do not evaluate resolution solely from the fix diff or from new/changed tests near the finding's originally cited files. A fix diff shows what changed; it does not show what the finding actually required to be true. Independently trace the finding's full causal chain — from the root symptom described in its `rationale` through to the actual runtime behavior it concerns — even when that chain passes through files the fix diff did not touch.
   - When proving a prior finding resolved, trace that finding through any authoritative production artifacts (e.g. repository-owned runtime configuration, templates, profiles, schemas, workflows, migrations, contracts) that materially participate in its causal chain. Inspect only the production artifacts materially required by those causal chains to keep the follow-up review focused.
   - Synthetic tests or constructed fixtures are supporting evidence only and cannot establish resolution when they materially differ from authoritative production artifacts or construct configurations absent from production.
   - A finding is not resolved merely because validation now accepts the input, a type now allows the field, or a new test asserts an intermediate value (e.g. a value is recorded in an output object). Confirm the underlying guarantee stated in the finding's rationale actually holds at the point where it matters (e.g. if the finding is about a value being _used_, not just accepted or recorded, verify the code path that consumes it was actually changed).
   - A finding resolution is not correct if it merely changes the failure mode or converts one failure into an unavoidable downstream failure, leaving the supported production configuration internally unsatisfiable. Confirm that at least one valid end-to-end success path exists under the actual supported production configuration for the corrected behavior.
   - For capability-dependent behavior touched by the finding, confirm consistency among declared capabilities, validation rules, runtime behavior, and output/provenance contracts when materially relevant.
   - **External Authority vs. Check Manipulation (Anti-Goodhart)**:
     - Distinguish "the code/data was changed to make the check pass" from "the underlying real-world condition was verified or established".
     - For any finding whose blocking condition traces to an external authority (legal sign-off, commercial licensing review, physical hardware/certification, human operator action) rather than a code defect: automated code changes or self-authored metadata changes CANNOT resolve the finding.
     - A finding is NOT resolved if the fixer modified production compliance registries, license registries, security exception lists, or governance metadata (e.g. flipping `review_required` or `blocked` to `approved` with self-authored notes or without external authority). Such modifications constitute fabricated compliance data rather than genuine resolution.
     - If the fix diff alters production governance/licensing registries without external authority, or weakens fail-closed compliance gates to make a test pass:
       - Mark the prior finding `resolved: false`.
       - Flag a NEW critical/high-severity blocking finding citing compliance data fabrication or weakening fail-closed policy.
       - Set verdict to `REQUEST_CHANGES`.
   - Cite the exact file/line(s) that establish the full chain is closed — not just the file/line(s) the fix diff touched — as your evidence.
2. **Detect Material Regressions or Exposed Gaps**:
   - Verify that the fix did not introduce material regressions, expose new gaps violating the issue's requirements or Acceptance Criteria, or leave the supported production configuration in an unsatisfiable state.
   - Do not turn follow-up review into an unrestricted second whole-change review; keep new discoveries anchored to the fix and the requirements.
   - Do not manufacture findings or raise unrelated stylistic preferences.
3. **Verdict**:
   - `APPROVE` if all previous blocking findings are resolved and no new blocking defects exist.
   - `REQUEST_CHANGES` if any finding remains unresolved or a new material defect was introduced.

### Workspace Bookkeeping (Do Not Flag)

If you inspect `git status` or the worktree directly, you will see untracked files. The orchestrator pipeline itself writes and reads its own bookkeeping files across phases; the exact ones currently present are listed below.

(none currently untracked in this worktree)

This exemption is narrow: it applies only to the exact untracked paths listed, as they exist right now. It does not extend to tracked files (even ones with the same name), to any content or behavior change in the branch diff, or to `.gitignore`/`.prettierignore` modifications — an implementation change that widens an ignore file to hide unrelated untracked output is still a real finding and must be evaluated normally. A prior finding about scope/hygiene is resolved on this basis only when its own cited evidence was solely the presence of these exact listed paths.

## CRITICAL RULES

- This is a read-only review. Do not modify source code or create scratch files in the worktree.
- Do not switch git branches.
- Do not ask questions.
- Write `./follow-up-review-result.json` before stopping.
- Markdown prose, stdout output, or comments cannot substitute for `./follow-up-review-result.json`.
- If `./follow-up-review-result.json` already exists and needs revision (e.g. a second pass over your own review found something new), rewrite the entire file from scratch. Do not patch/diff-edit it — context-based patch tools are unreliable against large JSON arrays, since they require reproducing exact surrounding text; a failed or partial patch application can silently corrupt the file.


## CORRECTION REQUIRED (Attempt 2 of 2)

Your previous review attempt failed contract validation:
- **Failure category:** missing_artifact
- **Required artifact path:** ./follow-up-review-result.json
- **Diagnostic detail:**
```
Required result artifact 'follow-up-review-result.json' was not created (contract violation: missing_required_artifact)
```

### Allowed Verdict Values
The `verdict` field must be exactly one of the following accepted enum literals:
- `APPROVE`
- `REQUEST_CHANGES`
- `approve`
- `request_changes`
- `PASS`
- `FAIL`
- `pass`
- `fail`

### Schema Requirements for ./follow-up-review-result.json
You must write a complete, valid JSON artifact directly to ./follow-up-review-result.json. Markdown prose, stdout output, or summary comments cannot substitute for this required JSON file. Inspect the supplied review evidence and produce a complete JSON result.

Field requirements:
- `verdict` (string, required): Exactly one of the accepted enum literals listed above.
- `evaluations` (array of objects, default: `[]`):
  Each evaluation entry must contain:
  - `finding_id` (string, required, non-empty): ID of the evaluated finding from the ledger.
  - `resolved` (boolean, required): `true` if verified resolved, `false` otherwise.
  - `evidence` (string, required, non-empty): Concrete evidence verifying resolution or explaining non-resolution.
  - `rationale` (string, optional): Additional context or reasoning.
- `new_findings` (array of objects, optional, default: `[]`): New findings or regressions detected.
- `summary` (string, optional): High-level review summary.
- `review_md` (string, optional): Optional markdown review notes.

Inspect the supplied review evidence and write the complete JSON result to ./follow-up-review-result.json before completing.
