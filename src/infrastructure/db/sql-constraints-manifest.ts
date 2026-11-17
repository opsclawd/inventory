export interface TableSecuritySpec {
  schema: 'shared' | 'salvage' | 'cannabis';
  table: string;
  requiredPolicies: readonly string[];
  allowedRuntimePrivs: ReadonlyArray<'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'>;
  forbiddenRuntimePrivs: ReadonlyArray<
    'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'
  >;
  allowedUpdateColumns?: readonly string[];
  forbiddenUpdateColumns?: readonly string[];
}

export interface CompositeTenantFkSpec {
  schema: 'shared' | 'salvage' | 'cannabis';
  table: string;
  column: string;
  targetSchema: 'shared' | 'salvage' | 'cannabis';
  targetTable: string;
}

export interface CheckConstraintSpec {
  schema: 'shared' | 'salvage' | 'cannabis';
  table: string;
  name: string;
}

export interface PartialUniqueIndexSpec {
  schema: 'shared' | 'salvage' | 'cannabis';
  table: string;
  name: string;
  predicateToken: string;
}

export interface TriggerSpec {
  schema: 'shared' | 'salvage' | 'cannabis';
  table: string;
  triggerName: string;
  functionSchema: 'shared' | 'salvage' | 'cannabis';
  functionName: string;
  events: ReadonlyArray<'INSERT' | 'UPDATE' | 'DELETE'>;
}

export interface SecurityDefinerHelperSpec {
  schema: 'shared';
  name: string;
  signatureArgs: string;
}

export interface MigrationManifestValidationResult {
  ok: boolean;
  errors: string[];
}

export interface SqlQueryClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
}

export const EXPECTED_SCHEMAS = ['shared', 'salvage', 'cannabis'] as const;

export const EXPECTED_SECURITY_DEFINER_HELPERS: readonly SecurityDefinerHelperSpec[] =
  [
    { schema: 'shared', name: 'current_user_id', signatureArgs: '' },
    { schema: 'shared', name: 'current_org_id', signatureArgs: '' },
    { schema: 'shared', name: 'current_role', signatureArgs: '' },
    {
      schema: 'shared',
      name: 'is_user_in_current_org',
      signatureArgs: 'uuid',
    },
    {
      schema: 'shared',
      name: 'can_bootstrap_select_org',
      signatureArgs: 'uuid',
    },
  ];

export const EXPECTED_TABLES: readonly TableSecuritySpec[] = [
  // shared (9)
  {
    schema: 'shared',
    table: 'Organization',
    requiredPolicies: [
      'tenant_select_organization',
      'tenant_update_organization_cfo',
      'auth_bootstrap_select_organization',
    ],
    allowedRuntimePrivs: ['SELECT'],
    forbiddenRuntimePrivs: ['INSERT', 'DELETE', 'TRUNCATE'],
    allowedUpdateColumns: ['policyConfigJson', 'updatedAt'],
    forbiddenUpdateColumns: [
      'id',
      'slug',
      'name',
      'legalEntityName',
      'organizationType',
      'craBusinessNumberBn15',
      'healthCanadaLicenseNumber',
      'isActive',
    ],
  },
  {
    schema: 'shared',
    table: 'User',
    requiredPolicies: [
      'user_select_self_or_org_comember',
      'user_update_self_profile',
    ],
    allowedRuntimePrivs: ['SELECT'],
    forbiddenRuntimePrivs: ['INSERT', 'DELETE', 'TRUNCATE'],
    allowedUpdateColumns: [
      'fullName',
      'phoneE164',
      'whatsappOptInAt',
      'whatsappWindowExp',
      'updatedAt',
    ],
    forbiddenUpdateColumns: [
      'id',
      'email',
      'role',
      'mfaEnrolled',
      'commissionRateBps',
      'isActive',
    ],
  },
  {
    schema: 'shared',
    table: 'OrganizationMembership',
    requiredPolicies: [
      'tenant_select_org_membership',
      'tenant_insert_org_membership_cfo',
      'tenant_update_org_membership_cfo',
      'auth_bootstrap_select_membership',
    ],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE'],
    forbiddenRuntimePrivs: ['DELETE', 'TRUNCATE'],
  },
  {
    schema: 'shared',
    table: 'StorageLocation',
    requiredPolicies: ['tenant_isolation_storage_location'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'shared',
    table: 'CustodyEvent',
    requiredPolicies: ['tenant_isolation_custody_event'],
    allowedRuntimePrivs: ['SELECT', 'INSERT'],
    forbiddenRuntimePrivs: ['UPDATE', 'DELETE', 'TRUNCATE'],
  },
  {
    schema: 'shared',
    table: 'Expense',
    requiredPolicies: ['tenant_isolation_expense'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE'],
    forbiddenRuntimePrivs: ['DELETE', 'TRUNCATE'],
  },
  {
    schema: 'shared',
    table: 'CashCustodyTransfer',
    requiredPolicies: ['tenant_isolation_cash_transfer'],
    allowedRuntimePrivs: ['SELECT', 'INSERT'],
    forbiddenRuntimePrivs: ['UPDATE', 'DELETE', 'TRUNCATE'],
  },
  {
    schema: 'shared',
    table: 'OutboxEvent',
    requiredPolicies: ['tenant_isolation_outbox_event'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'shared',
    table: 'AuditLog',
    requiredPolicies: ['tenant_isolation_audit_log'],
    allowedRuntimePrivs: ['SELECT', 'INSERT'],
    forbiddenRuntimePrivs: ['UPDATE', 'DELETE', 'TRUNCATE'],
  },
  // salvage (12)
  {
    schema: 'salvage',
    table: 'Vehicle',
    requiredPolicies: ['tenant_isolation_vehicle'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'Part',
    requiredPolicies: ['tenant_isolation_part'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'ScrapComponentLog',
    requiredPolicies: ['tenant_isolation_scrap_component_log'],
    allowedRuntimePrivs: ['SELECT', 'INSERT'],
    forbiddenRuntimePrivs: ['UPDATE', 'DELETE', 'TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'Shipment',
    requiredPolicies: ['tenant_isolation_shipment'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'ShipmentPallet',
    requiredPolicies: ['tenant_isolation_shipment_pallet'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'PreOrderWishList',
    requiredPolicies: ['tenant_isolation_wish_list'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'B2BReservation',
    requiredPolicies: ['tenant_isolation_b2b_reservation'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    requiredPolicies: ['tenant_isolation_sale_transaction'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE'],
    forbiddenRuntimePrivs: ['DELETE', 'TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'SaleTransactionPartItem',
    requiredPolicies: ['tenant_isolation_sale_part_item'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'SaleTransactionVehicleItem',
    requiredPolicies: ['tenant_isolation_sale_vehicle_item'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'CycleCountTask',
    requiredPolicies: ['tenant_isolation_cycle_count'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'salvage',
    table: 'CurrencySettlement',
    requiredPolicies: ['tenant_isolation_currency_settlement'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  // cannabis (7)
  {
    schema: 'cannabis',
    table: 'CannabisStrain',
    requiredPolicies: ['tenant_isolation_cannabis_strain'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'cannabis',
    table: 'CannabisLot',
    requiredPolicies: ['tenant_isolation_cannabis_lot'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'cannabis',
    table: 'ProductionRun',
    requiredPolicies: ['tenant_isolation_production_run'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE'],
    forbiddenRuntimePrivs: ['DELETE', 'TRUNCATE'],
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunInput',
    requiredPolicies: ['tenant_isolation_production_run_input'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunOutput',
    requiredPolicies: ['tenant_isolation_production_run_output'],
    allowedRuntimePrivs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenRuntimePrivs: ['TRUNCATE'],
  },
  {
    schema: 'cannabis',
    table: 'CannabisDestructionLog',
    requiredPolicies: ['tenant_isolation_cannabis_destruction'],
    allowedRuntimePrivs: ['SELECT', 'INSERT'],
    forbiddenRuntimePrivs: ['UPDATE', 'DELETE', 'TRUNCATE'],
  },
  {
    schema: 'cannabis',
    table: 'CanonicalInventoryEvent',
    requiredPolicies: ['tenant_isolation_canonical_inventory_event'],
    allowedRuntimePrivs: ['SELECT', 'INSERT'],
    forbiddenRuntimePrivs: ['UPDATE', 'DELETE', 'TRUNCATE'],
  },
];

export const EXPECTED_COMPOSITE_TENANT_FKS: readonly CompositeTenantFkSpec[] = [
  {
    schema: 'shared',
    table: 'CustodyEvent',
    column: 'partId',
    targetSchema: 'salvage',
    targetTable: 'Part',
  },
  {
    schema: 'shared',
    table: 'CustodyEvent',
    column: 'vehicleId',
    targetSchema: 'salvage',
    targetTable: 'Vehicle',
  },
  {
    schema: 'shared',
    table: 'CustodyEvent',
    column: 'cannabisLotId',
    targetSchema: 'cannabis',
    targetTable: 'CannabisLot',
  },
  {
    schema: 'shared',
    table: 'Expense',
    column: 'vehicleId',
    targetSchema: 'salvage',
    targetTable: 'Vehicle',
  },
  {
    schema: 'shared',
    table: 'Expense',
    column: 'shipmentId',
    targetSchema: 'salvage',
    targetTable: 'Shipment',
  },
  {
    schema: 'shared',
    table: 'Expense',
    column: 'cannabisLotId',
    targetSchema: 'cannabis',
    targetTable: 'CannabisLot',
  },
  {
    schema: 'shared',
    table: 'Expense',
    column: 'reversesExpenseId',
    targetSchema: 'shared',
    targetTable: 'Expense',
  },
  {
    schema: 'salvage',
    table: 'Vehicle',
    column: 'storageLocationId',
    targetSchema: 'shared',
    targetTable: 'StorageLocation',
  },
  {
    schema: 'salvage',
    table: 'Vehicle',
    column: 'shipmentId',
    targetSchema: 'salvage',
    targetTable: 'Shipment',
  },
  {
    schema: 'salvage',
    table: 'Part',
    column: 'donorVehicleId',
    targetSchema: 'salvage',
    targetTable: 'Vehicle',
  },
  {
    schema: 'salvage',
    table: 'Part',
    column: 'storageLocationId',
    targetSchema: 'shared',
    targetTable: 'StorageLocation',
  },
  {
    schema: 'salvage',
    table: 'Part',
    column: 'shipmentPalletId',
    targetSchema: 'salvage',
    targetTable: 'ShipmentPallet',
  },
  {
    schema: 'salvage',
    table: 'ScrapComponentLog',
    column: 'vehicleId',
    targetSchema: 'salvage',
    targetTable: 'Vehicle',
  },
  {
    schema: 'salvage',
    table: 'ShipmentPallet',
    column: 'shipmentId',
    targetSchema: 'salvage',
    targetTable: 'Shipment',
  },
  {
    schema: 'salvage',
    table: 'PreOrderWishList',
    column: 'matchedPartId',
    targetSchema: 'salvage',
    targetTable: 'Part',
  },
  {
    schema: 'salvage',
    table: 'PreOrderWishList',
    column: 'matchedVehicleId',
    targetSchema: 'salvage',
    targetTable: 'Vehicle',
  },
  {
    schema: 'salvage',
    table: 'B2BReservation',
    column: 'partId',
    targetSchema: 'salvage',
    targetTable: 'Part',
  },
  {
    schema: 'salvage',
    table: 'B2BReservation',
    column: 'vehicleId',
    targetSchema: 'salvage',
    targetTable: 'Vehicle',
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    column: 'reversesSaleTxId',
    targetSchema: 'salvage',
    targetTable: 'SaleTransaction',
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    column: 'settlementBatchId',
    targetSchema: 'salvage',
    targetTable: 'CurrencySettlement',
  },
  {
    schema: 'salvage',
    table: 'SaleTransactionPartItem',
    column: 'saleTransactionId',
    targetSchema: 'salvage',
    targetTable: 'SaleTransaction',
  },
  {
    schema: 'salvage',
    table: 'SaleTransactionPartItem',
    column: 'partId',
    targetSchema: 'salvage',
    targetTable: 'Part',
  },
  {
    schema: 'salvage',
    table: 'SaleTransactionVehicleItem',
    column: 'saleTransactionId',
    targetSchema: 'salvage',
    targetTable: 'SaleTransaction',
  },
  {
    schema: 'salvage',
    table: 'SaleTransactionVehicleItem',
    column: 'vehicleId',
    targetSchema: 'salvage',
    targetTable: 'Vehicle',
  },
  {
    schema: 'salvage',
    table: 'CycleCountTask',
    column: 'partId',
    targetSchema: 'salvage',
    targetTable: 'Part',
  },
  {
    schema: 'salvage',
    table: 'CycleCountTask',
    column: 'vehicleId',
    targetSchema: 'salvage',
    targetTable: 'Vehicle',
  },
  {
    schema: 'cannabis',
    table: 'CannabisLot',
    column: 'strainId',
    targetSchema: 'cannabis',
    targetTable: 'CannabisStrain',
  },
  {
    schema: 'cannabis',
    table: 'CannabisLot',
    column: 'parentMotherLotId',
    targetSchema: 'cannabis',
    targetTable: 'CannabisLot',
  },
  {
    schema: 'cannabis',
    table: 'CannabisLot',
    column: 'storageLocationId',
    targetSchema: 'shared',
    targetTable: 'StorageLocation',
  },
  {
    schema: 'cannabis',
    table: 'ProductionRun',
    column: 'reversesProductionRunId',
    targetSchema: 'cannabis',
    targetTable: 'ProductionRun',
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunInput',
    column: 'productionRunId',
    targetSchema: 'cannabis',
    targetTable: 'ProductionRun',
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunInput',
    column: 'sourceLotId',
    targetSchema: 'cannabis',
    targetTable: 'CannabisLot',
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunOutput',
    column: 'productionRunId',
    targetSchema: 'cannabis',
    targetTable: 'ProductionRun',
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunOutput',
    column: 'outputLotId',
    targetSchema: 'cannabis',
    targetTable: 'CannabisLot',
  },
  {
    schema: 'cannabis',
    table: 'CannabisDestructionLog',
    column: 'lotId',
    targetSchema: 'cannabis',
    targetTable: 'CannabisLot',
  },
  {
    schema: 'cannabis',
    table: 'CanonicalInventoryEvent',
    column: 'cannabisLotId',
    targetSchema: 'cannabis',
    targetTable: 'CannabisLot',
  },
  {
    schema: 'cannabis',
    table: 'CanonicalInventoryEvent',
    column: 'productionRunId',
    targetSchema: 'cannabis',
    targetTable: 'ProductionRun',
  },
  {
    schema: 'cannabis',
    table: 'CanonicalInventoryEvent',
    column: 'destructionLogId',
    targetSchema: 'cannabis',
    targetTable: 'CannabisDestructionLog',
  },
  {
    schema: 'cannabis',
    table: 'CanonicalInventoryEvent',
    column: 'reversesCanonicalEventId',
    targetSchema: 'cannabis',
    targetTable: 'CanonicalInventoryEvent',
  },
];

export const EXPECTED_CHECK_CONSTRAINTS: readonly CheckConstraintSpec[] = [
  { schema: 'shared', table: 'Expense', name: 'expense_receipt_or_voucher_check' },
  {
    schema: 'shared',
    table: 'Expense',
    name: 'piece_rate_requires_donor_vehicle',
  },
  {
    schema: 'shared',
    table: 'CashCustodyTransfer',
    name: 'transfer_slip_non_empty',
  },
  {
    schema: 'shared',
    table: 'CustodyEvent',
    name: 'custody_event_target_xor',
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    name: 'commission_requires_verified_payment',
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    name: 'sale_settlement_custody_consistency',
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    name: 'sale_tax_collection_mode_consistency',
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    name: 'sale_channel_node_integrity',
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    name: 'retail_lot_vehicle_bill_of_sale_required',
  },
  { schema: 'salvage', table: 'Vehicle', name: 'non_auto_brand_check' },
  {
    schema: 'salvage',
    table: 'B2BReservation',
    name: 'b2b_reservation_target_xor',
  },
  {
    schema: 'salvage',
    table: 'CycleCountTask',
    name: 'cycle_count_target_xor',
  },
  {
    schema: 'cannabis',
    table: 'CannabisDestructionLog',
    name: 'cannabis_destruction_stream_rules',
  },
  {
    schema: 'cannabis',
    table: 'CannabisDestructionLog',
    name: 'cannabis_destruction_second_witness_distinct',
  },
  {
    schema: 'cannabis',
    table: 'ProductionRun',
    name: 'cannabis_production_run_non_negative_quantities',
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunInput',
    name: 'cannabis_run_input_positive_quantities',
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunOutput',
    name: 'cannabis_run_output_positive_quantities',
  },
];

export const EXPECTED_INCREMENTAL_CHECK_CONSTRAINTS: readonly CheckConstraintSpec[] =
  [
    {
      schema: 'shared',
      table: 'Expense',
      name: 'expense_amounts_and_draw_split_check',
    },
    {
      schema: 'salvage',
      table: 'SaleTransaction',
      name: 'sale_actual_platform_fee_check',
    },
  ];

export const FORBIDDEN_CHECK_CONSTRAINTS: readonly CheckConstraintSpec[] = [
  {
    schema: 'cannabis',
    table: 'ProductionRun',
    name: 'cannabis_production_run_mass_balance',
  },
];

export const EXPECTED_PARTIAL_UNIQUE_INDEXES: readonly PartialUniqueIndexSpec[] =
  [
    {
      schema: 'salvage',
      table: 'B2BReservation',
      name: 'unique_active_part_reservation',
      predicateToken: '"isActive" = true',
    },
    {
      schema: 'salvage',
      table: 'B2BReservation',
      name: 'unique_active_vehicle_reservation',
      predicateToken: '"isActive" = true',
    },
    {
      schema: 'salvage',
      table: 'SaleTransactionPartItem',
      name: 'unique_active_sold_part',
      predicateToken: '"isActiveSale" = true',
    },
    {
      schema: 'salvage',
      table: 'SaleTransactionVehicleItem',
      name: 'unique_active_sold_vehicle',
      predicateToken: '"isActiveSale" = true',
    },
  ];

export const EXPECTED_TRIGGERS: readonly TriggerSpec[] = [
  {
    schema: 'shared',
    table: 'AuditLog',
    triggerName: 'lock_audit_log',
    functionSchema: 'shared',
    functionName: 'prevent_audit_tampering',
    events: ['UPDATE', 'DELETE'],
  },
  {
    schema: 'shared',
    table: 'CustodyEvent',
    triggerName: 'lock_custody_event',
    functionSchema: 'shared',
    functionName: 'prevent_audit_tampering',
    events: ['UPDATE', 'DELETE'],
  },
  {
    schema: 'shared',
    table: 'CashCustodyTransfer',
    triggerName: 'lock_cash_transfer_mutation',
    functionSchema: 'shared',
    functionName: 'prevent_audit_tampering',
    events: ['UPDATE', 'DELETE'],
  },
  {
    schema: 'salvage',
    table: 'ScrapComponentLog',
    triggerName: 'lock_scrap_log_mutation',
    functionSchema: 'shared',
    functionName: 'prevent_audit_tampering',
    events: ['UPDATE', 'DELETE'],
  },
  {
    schema: 'cannabis',
    table: 'CannabisDestructionLog',
    triggerName: 'lock_cannabis_destruction_log',
    functionSchema: 'shared',
    functionName: 'prevent_audit_tampering',
    events: ['UPDATE', 'DELETE'],
  },
  {
    schema: 'cannabis',
    table: 'CanonicalInventoryEvent',
    triggerName: 'lock_canonical_inventory_event',
    functionSchema: 'shared',
    functionName: 'prevent_audit_tampering',
    events: ['UPDATE', 'DELETE'],
  },
  {
    schema: 'shared',
    table: 'Expense',
    triggerName: 'lock_expense_delete',
    functionSchema: 'shared',
    functionName: 'prevent_audit_tampering',
    events: ['DELETE'],
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    triggerName: 'lock_sale_tx_delete',
    functionSchema: 'shared',
    functionName: 'prevent_audit_tampering',
    events: ['DELETE'],
  },
  {
    schema: 'cannabis',
    table: 'ProductionRun',
    triggerName: 'lock_production_run_delete',
    functionSchema: 'shared',
    functionName: 'prevent_audit_tampering',
    events: ['DELETE'],
  },
  {
    schema: 'shared',
    table: 'Expense',
    triggerName: 'lock_expense_immutable_cols',
    functionSchema: 'shared',
    functionName: 'prevent_expense_financial_mutation',
    events: ['UPDATE'],
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    triggerName: 'a_lock_sale_tx_immutable_cols',
    functionSchema: 'salvage',
    functionName: 'prevent_sale_tx_financial_mutation',
    events: ['UPDATE'],
  },
  {
    schema: 'salvage',
    table: 'SaleTransaction',
    triggerName: 'b_enforce_sale_settlement_transition',
    functionSchema: 'salvage',
    functionName: 'enforce_sale_settlement_transition',
    events: ['INSERT', 'UPDATE'],
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunInput',
    triggerName: 'guard_production_run_input_mutation',
    functionSchema: 'cannabis',
    functionName: 'guard_production_run_child_mutation',
    events: ['INSERT', 'UPDATE', 'DELETE'],
  },
  {
    schema: 'cannabis',
    table: 'ProductionRunOutput',
    triggerName: 'guard_production_run_output_mutation',
    functionSchema: 'cannabis',
    functionName: 'guard_production_run_child_mutation',
    events: ['INSERT', 'UPDATE', 'DELETE'],
  },
  {
    schema: 'cannabis',
    table: 'ProductionRun',
    triggerName: 'enforce_production_run_lifecycle',
    functionSchema: 'cannabis',
    functionName: 'enforce_production_run_lifecycle_and_finalization',
    events: ['INSERT', 'UPDATE'],
  },
];

/**
 * Strips SQL line (`-- ...`) and block (`/* ... *\/`) comments while preserving string
 * literals (`'...'`) and dollar-quoted blocks (`$tag$...$tag$`) so comment-only tokens
 * cannot satisfy manifest checks.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // Single-line comment
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    // Block comment (supports nesting in PostgreSQL)
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += ' ';
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      out += ch;
      i += 1;
      while (i < len) {
        const cur = sql[i]!;
        out += cur;
        i += 1;
        if (cur === "'") {
          if (sql[i] === "'") {
            out += "'";
            i += 1;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < len) {
        const cur = sql[i]!;
        out += cur;
        i += 1;
        if (cur === '"') {
          if (sql[i] === '"') {
            out += '"';
            i += 1;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Dollar-quoted body ($tag$ ... $tag$)
    if (ch === '$') {
      const rest = sql.slice(i);
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      if (tagMatch) {
        const tag = tagMatch[0];
        const endIdx = sql.indexOf(tag, i + tag.length);
        if (endIdx !== -1) {
          out += sql.slice(i, endIdx + tag.length);
          i = endIdx + tag.length;
          continue;
        }
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteTablePattern(schema: string, table: string): string {
  return `(?:"${escapeRegExp(schema)}"|\\b${escapeRegExp(schema)})\\s*\\.\\s*(?:"${escapeRegExp(table)}"|${escapeRegExp(table)}\\b)`;
}

function extractFunctionBlock(
  sql: string,
  schema: string,
  fnName: string,
): string | null {
  const fnPattern = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:"${escapeRegExp(schema)}"|${escapeRegExp(schema)})\\s*\\.\\s*(?:"${escapeRegExp(fnName)}"|${escapeRegExp(fnName)})\\s*\\([^)]*\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    'i',
  );
  const match = fnPattern.exec(sql);
  if (!match) {
    return null;
  }
  return match[0];
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < len) {
        const cur = sql[i]!;
        current += cur;
        i += 1;
        if (cur === "'") {
          if (sql[i] === "'") {
            current += "'";
            i += 1;
          } else {
            break;
          }
        }
      }
      continue;
    }

    if (ch === '"') {
      current += ch;
      i += 1;
      while (i < len) {
        const cur = sql[i]!;
        current += cur;
        i += 1;
        if (cur === '"') {
          if (sql[i] === '"') {
            current += '"';
            i += 1;
          } else {
            break;
          }
        }
      }
      continue;
    }

    if (ch === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const endIdx = sql.indexOf(tag, i + tag.length);
        if (endIdx !== -1) {
          current += sql.slice(i, endIdx + tag.length);
          i = endIdx + tag.length;
          continue;
        }
      }
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }
  return statements;
}

export function validateIssue10MigrationSql(
  rawSql: string,
): MigrationManifestValidationResult {
  const errors: string[] = [];
  if (typeof rawSql !== 'string' || rawSql.trim().length === 0) {
    return {
      ok: false,
      errors: ['Issue 10 migration SQL is empty or missing.'],
    };
  }
  const sql = stripSqlComments(rawSql);
  if (sql.trim().length === 0) {
    return {
      ok: false,
      errors: ['Issue 10 migration SQL contains only comments.'],
    };
  }
  if (!/"actualPlatformFeeMinor"\s+INTEGER/i.test(sql)) {
    errors.push('Missing SaleTransaction.actualPlatformFeeMinor column.');
  }
  if (!/ADD\s+CONSTRAINT\s+"?sale_actual_platform_fee_check"?\s+CHECK/i.test(sql)) {
    errors.push('Missing CHECK constraint sale_actual_platform_fee_check.');
  }
  const immFn = extractFunctionBlock(
    sql,
    'salvage',
    'prevent_sale_tx_financial_mutation',
  );
  if (!immFn || !/SET\s+search_path\s*=\s*''/i.test(immFn)) {
    errors.push(
      'Missing salvage.prevent_sale_tx_financial_mutation() with SET search_path = "".',
    );
  } else if (!/"actualPlatformFeeMinor"/i.test(immFn)) {
    errors.push(
      'prevent_sale_tx_financial_mutation() must guard actualPlatformFeeMinor immutability.',
    );
  }
  const settleFn = extractFunctionBlock(
    sql,
    'salvage',
    'enforce_sale_settlement_transition',
  );
  if (!settleFn || !/SET\s+search_path\s*=\s*''/i.test(settleFn)) {
    errors.push(
      'Missing salvage.enforce_sale_settlement_transition() with SET search_path = "".',
    );
  } else if (!/actualPlatformFeeMinor/i.test(settleFn)) {
    errors.push(
      'enforce_sale_settlement_transition() must enforce initial NULL actualPlatformFeeMinor.',
    );
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Deterministically validates migration DDL text against all Issue #2 security,
 * RLS, least-privilege, composite-FK, CHECK, partial-index, and trigger invariants.
 * Rejects empty/unreadable SQL and ignores comment-only tokens.
 */
export function validateMigrationSql(
  rawSql: string,
): MigrationManifestValidationResult {
  const errors: string[] = [];

  if (typeof rawSql !== 'string' || rawSql.trim().length === 0) {
    return {
      ok: false,
      errors: ['Migration SQL is empty or missing.'],
    };
  }

  const sql = stripSqlComments(rawSql);
  if (sql.trim().length === 0) {
    return {
      ok: false,
      errors: ['Migration SQL contains only comments and no executable DDL.'],
    };
  }

  const statements = splitSqlStatements(sql);

  // 1. Zero auth.jwt() policies or references
  if (/\bauth\s*\.\s*jwt\s*\(/i.test(sql)) {
    errors.push(
      'Forbidden auth.jwt() reference detected; Prisma TCP connections must never rely on PostgREST JWT claims.',
    );
  }

  // 2. Migration owner BYPASSRLS/SUPERUSER assertion & erp_app_user hardening
  if (
    !/rolsuper\s*=\s*true\s+OR\s+rolbypassrls\s*=\s*true/i.test(sql) ||
    !/RAISE\s+EXCEPTION/i.test(sql)
  ) {
    errors.push(
      'Missing migration-time BYPASSRLS/SUPERUSER owner assertion to prevent FORCE RLS 42P17 recursion.',
    );
  }

  if (
    !/CREATE\s+ROLE\s+erp_app_user\b[\s\S]*?\bNOBYPASSRLS\b[\s\S]*?\bNOSUPERUSER\b/i.test(
      sql,
    ) ||
    !/ALTER\s+ROLE\s+erp_app_user\b[\s\S]*?\bNOBYPASSRLS\b[\s\S]*?\bNOSUPERUSER\b/i.test(
      sql,
    )
  ) {
    errors.push(
      'Missing erp_app_user role provisioning/hardening with LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE.',
    );
  }

  if (
    !/ALTER\s+ROLE\s+erp_app_user\s+SET\s+plan_cache_mode\s*=\s*'force_custom_plan'/i.test(
      sql,
    )
  ) {
    errors.push(
      "Missing ALTER ROLE erp_app_user SET plan_cache_mode = 'force_custom_plan'.",
    );
  }

  if (
    /ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]*?GRANT\s+[\s\S]*?\bTO\s+erp_app_user\b/i.test(
      sql,
    )
  ) {
    errors.push(
      'Broad ALTER DEFAULT PRIVILEGES grant to erp_app_user is forbidden; grant explicit per-table privileges only.',
    );
  }

  // 3. Schemas
  for (const schema of EXPECTED_SCHEMAS) {
    const schemaPattern = new RegExp(
      `CREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${escapeRegExp(schema)}"?\\b`,
      'i',
    );
    if (!schemaPattern.test(sql)) {
      errors.push(`Missing CREATE SCHEMA for "${schema}".`);
    }
  }

  // 4. Five SECURITY DEFINER helpers with fixed empty search_path and explicit ACLs
  for (const helper of EXPECTED_SECURITY_DEFINER_HELPERS) {
    const fnBlock = extractFunctionBlock(sql, helper.schema, helper.name);
    if (!fnBlock) {
      errors.push(
        `Missing SECURITY DEFINER helper "${helper.schema}"."${helper.name}(${helper.signatureArgs})".`,
      );
      continue;
    }
    if (!/\bSECURITY\s+DEFINER\b/i.test(fnBlock)) {
      errors.push(
        `Helper "${helper.schema}"."${helper.name}" must specify SECURITY DEFINER.`,
      );
    }
    if (!/SET\s+search_path\s*=\s*''/i.test(fnBlock)) {
      errors.push(
        `Helper "${helper.schema}"."${helper.name}" must specify SET search_path = ''.`,
      );
    }
    const sigPattern = new RegExp(
      `(?:"${escapeRegExp(helper.schema)}"|${escapeRegExp(helper.schema)})\\s*\\.\\s*(?:"${escapeRegExp(helper.name)}"|${escapeRegExp(helper.name)})\\s*\\(\\s*${escapeRegExp(helper.signatureArgs)}\\s*\\)`,
      'i',
    );
    const hasRevokePublic = statements.some(
      (stmt) =>
        /^REVOKE\s+ALL\s+ON\s+FUNCTION\b/i.test(stmt) &&
        /\bFROM\s+PUBLIC\b/i.test(stmt) &&
        sigPattern.test(stmt),
    );
    if (!hasRevokePublic) {
      errors.push(
        `Helper "${helper.schema}"."${helper.name}(${helper.signatureArgs})" must REVOKE ALL FROM PUBLIC.`,
      );
    }
    const hasGrantErp = statements.some(
      (stmt) =>
        /^GRANT\s+EXECUTE\s+ON\s+FUNCTION\b/i.test(stmt) &&
        /\bTO\s+erp_app_user\b/i.test(stmt) &&
        sigPattern.test(stmt),
    );
    if (!hasGrantErp) {
      errors.push(
        `Helper "${helper.schema}"."${helper.name}(${helper.signatureArgs})" must GRANT EXECUTE TO erp_app_user.`,
      );
    }
  }

  const currentOrgFn = extractFunctionBlock(sql, 'shared', 'current_org_id');
  if (
    currentOrgFn &&
    (!/"shared"\."OrganizationMembership"/i.test(currentOrgFn) ||
      !/"isActive"\s*=\s*true/i.test(currentOrgFn) ||
      !/"shared"\."User"/i.test(currentOrgFn) ||
      !/"shared"\."Organization"/i.test(currentOrgFn))
  ) {
    errors.push(
      '"shared"."current_org_id"() must verify active OrganizationMembership, active User, and active Organization.',
    );
  }

  // 5. Per-table CREATE TABLE, ENABLE+FORCE RLS, policies, and least-privilege grants
  for (const spec of EXPECTED_TABLES) {
    const tblRe = quoteTablePattern(spec.schema, spec.table);
    const fqName = `"${spec.schema}"."${spec.table}"`;

    if (!new RegExp(`CREATE\\s+TABLE\\s+${tblRe}\\s*\\(`, 'i').test(sql)) {
      errors.push(`Missing CREATE TABLE for ${fqName}.`);
    }

    if (
      !new RegExp(
        `ALTER\\s+TABLE\\s+${tblRe}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY\\b`,
        'i',
      ).test(sql)
    ) {
      errors.push(`Missing ENABLE ROW LEVEL SECURITY on ${fqName}.`);
    }

    if (
      !new RegExp(
        `ALTER\\s+TABLE\\s+${tblRe}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY\\b`,
        'i',
      ).test(sql)
    ) {
      errors.push(`Missing FORCE ROW LEVEL SECURITY on ${fqName}.`);
    }

    for (const policyName of spec.requiredPolicies) {
      const policyRegex = new RegExp(
        `CREATE\\s+POLICY\\s+"?${escapeRegExp(policyName)}"?\\s+ON\\s+${tblRe}(?=[\\s;,(]|$)`,
        'i',
      );
      const matchingPolicyStmt = statements.find((stmt) =>
        policyRegex.test(stmt),
      );
      if (!matchingPolicyStmt) {
        errors.push(`Missing RLS policy "${policyName}" on ${fqName}.`);
      } else if (
        policyName.startsWith('tenant_isolation_') &&
        (!/\bUSING\s*\([\s\S]*?"shared"\."current_org_id"\(\)/i.test(
          matchingPolicyStmt,
        ) ||
          !/\bWITH\s+CHECK\s*\([\s\S]*?"shared"\."current_org_id"\(\)/i.test(
            matchingPolicyStmt,
          ))
      ) {
        errors.push(
          `Policy "${policyName}" on ${fqName} must enforce "shared"."current_org_id"() in both USING and WITH CHECK.`,
        );
      }
    }

    // Per-table grant assertions for erp_app_user
    const tableGrantStmts = statements.filter(
      (stmt) =>
        /^GRANT\b/i.test(stmt) &&
        /\bTO\s+[^;]*\berp_app_user\b/i.test(stmt) &&
        new RegExp(`\\bON\\s+(?:TABLE\\s+)?${tblRe}(?=[\\s;,(]|$)`, 'i').test(
          stmt,
        ),
    );

    const broadGrantToErp = statements.filter(
      (stmt) =>
        /^GRANT\b/i.test(stmt) &&
        /\bTO\s+[^;]*\berp_app_user\b/i.test(stmt) &&
        new RegExp(
          `\\bON\\s+ALL\\s+TABLES\\s+IN\\s+SCHEMA\\s+[^;]*(?:"${escapeRegExp(spec.schema)}"|\\b${escapeRegExp(spec.schema)}\\b)`,
          'i',
        ).test(stmt),
    );

    if (broadGrantToErp.length > 0) {
      errors.push(
        `Broad GRANT ON ALL TABLES IN SCHEMA "${spec.schema}" TO erp_app_user is forbidden; use explicit per-table grants.`,
      );
    }

    if (tableGrantStmts.length === 0) {
      errors.push(`Missing explicit GRANT on ${fqName} to erp_app_user.`);
    }

    for (const priv of spec.allowedRuntimePrivs) {
      const hasPriv = tableGrantStmts.some((stmt) =>
        new RegExp(`^GRANT\\s+[^;]*\\b${priv}\\b`, 'i').test(stmt),
      );
      if (!hasPriv) {
        errors.push(`Missing GRANT ${priv} on ${fqName} to erp_app_user.`);
      }
    }

    for (const priv of spec.forbiddenRuntimePrivs) {
      const hasForbiddenPriv = tableGrantStmts.some((stmt) => {
        if (priv === 'UPDATE' && spec.allowedUpdateColumns) {
          // Table-wide UPDATE (without column list) is forbidden
          return /^GRANT\s+[^;]*\bUPDATE\b(?!\s*\()/i.test(stmt);
        }
        return new RegExp(`^GRANT\\s+[^;]*\\b(?:${priv}|ALL)\\b`, 'i').test(
          stmt,
        );
      });
      if (hasForbiddenPriv) {
        errors.push(
          `Forbidden GRANT ${priv} detected on ${fqName} for erp_app_user.`,
        );
      }
    }

    if (spec.allowedUpdateColumns) {
      const hasTableWideUpdate = tableGrantStmts.some((stmt) =>
        /^GRANT\s+[^;]*\bUPDATE\b(?!\s*\()/i.test(stmt),
      );
      if (hasTableWideUpdate) {
        errors.push(
          `Forbidden table-wide GRANT UPDATE detected on ${fqName} for erp_app_user; only column-restricted UPDATE is allowed.`,
        );
      }
      const colUpdateStmt = tableGrantStmts.find((stmt) =>
        /^GRANT\s+[^;]*\bUPDATE\s*\(/i.test(stmt),
      );
      if (!colUpdateStmt) {
        errors.push(
          `Missing column-restricted GRANT UPDATE (...) on ${fqName} to erp_app_user.`,
        );
      } else {
        for (const col of spec.allowedUpdateColumns) {
          if (
            !new RegExp(`"${escapeRegExp(col)}"|\\b${escapeRegExp(col)}\\b`).test(
              colUpdateStmt,
            )
          ) {
            errors.push(
              `Missing allowed UPDATE column "${col}" on ${fqName} for erp_app_user.`,
            );
          }
        }
        for (const col of spec.forbiddenUpdateColumns ?? []) {
          if (
            new RegExp(`"${escapeRegExp(col)}"|\\b${escapeRegExp(col)}\\b`).test(
              colUpdateStmt,
            )
          ) {
            errors.push(
              `Forbidden privileged UPDATE column "${col}" granted on ${fqName} to erp_app_user.`,
            );
          }
        }
      }
    }
  }

  // 6. Composite intra-tenant foreign keys
  for (const fk of EXPECTED_COMPOSITE_TENANT_FKS) {
    const childRe = quoteTablePattern(fk.schema, fk.table);
    const parentRe = quoteTablePattern(fk.targetSchema, fk.targetTable);
    const compositeFkPattern = new RegExp(
      `ALTER\\s+TABLE\\s+${childRe}\\s+ADD\\s+CONSTRAINT\\s+[^;]+FOREIGN\\s+KEY\\s*\\(\\s*"organizationId"\\s*,\\s*"${escapeRegExp(fk.column)}"\\s*\\)\\s*REFERENCES\\s+${parentRe}\\s*\\(\\s*"organizationId"\\s*,\\s*"id"\\s*\\)`,
      'i',
    );
    const singleColFkPattern = new RegExp(
      `ALTER\\s+TABLE\\s+${childRe}\\s+ADD\\s+CONSTRAINT\\s+[^;]+FOREIGN\\s+KEY\\s*\\(\\s*"${escapeRegExp(fk.column)}"\\s*\\)\\s*REFERENCES\\s+${parentRe}\\s*\\(\\s*"id"\\s*\\)`,
      'i',
    );
    if (singleColFkPattern.test(sql)) {
      errors.push(
        `Single-column FK on "${fk.schema}"."${fk.table}"("${fk.column}") violates composite tenant FK isolation.`,
      );
    }
    if (!compositeFkPattern.test(sql)) {
      errors.push(
        `Missing composite tenant FK ("organizationId", "${fk.column}") on "${fk.schema}"."${fk.table}" -> "${fk.targetSchema}"."${fk.targetTable}".`,
      );
    }
  }

  // 7. Named CHECK constraints & forbidden parent-only mass-balance CHECK
  for (const check of EXPECTED_CHECK_CONSTRAINTS) {
    const tblRe = quoteTablePattern(check.schema, check.table);
    const checkPattern = new RegExp(
      `ALTER\\s+TABLE\\s+${tblRe}\\s+ADD\\s+CONSTRAINT\\s+"?${escapeRegExp(check.name)}"?\\s+CHECK\\s*\\(`,
      'i',
    );
    if (!checkPattern.test(sql)) {
      errors.push(
        `Missing CHECK constraint "${check.name}" on "${check.schema}"."${check.table}".`,
      );
    }
  }

  for (const forbidden of FORBIDDEN_CHECK_CONSTRAINTS) {
    const tblRe = quoteTablePattern(forbidden.schema, forbidden.table);
    const pattern = new RegExp(
      `ALTER\\s+TABLE\\s+${tblRe}\\s+ADD\\s+CONSTRAINT\\s+"?${escapeRegExp(forbidden.name)}"?\\s+CHECK\\s*\\(`,
      'i',
    );
    if (pattern.test(sql)) {
      errors.push(
        `Forbidden premature CHECK constraint "${forbidden.name}" found on "${forbidden.schema}"."${forbidden.table}".`,
      );
    }
  }

  // 8. Partial unique indexes
  for (const idx of EXPECTED_PARTIAL_UNIQUE_INDEXES) {
    const tblRe = quoteTablePattern(idx.schema, idx.table);
    const idxPattern = new RegExp(
      `CREATE\\s+UNIQUE\\s+INDEX\\s+"?${escapeRegExp(idx.name)}"?\\s+ON\\s+${tblRe}\\s*\\([^)]+\\)\\s*WHERE\\s+[^;]*${escapeRegExp(idx.predicateToken)}`,
      'i',
    );
    if (!idxPattern.test(sql)) {
      errors.push(
        `Missing partial unique index "${idx.name}" on "${idx.schema}"."${idx.table}".`,
      );
    }
  }

  // 9. Triggers and trigger function invariants
  for (const trig of EXPECTED_TRIGGERS) {
    const tblRe = quoteTablePattern(trig.schema, trig.table);
    const fnRe = quoteTablePattern(trig.functionSchema, trig.functionName);
    const trigStmt = statements.find((stmt) =>
      new RegExp(
        `CREATE\\s+TRIGGER\\s+"?${escapeRegExp(trig.triggerName)}"?\\s+BEFORE\\s+[\\s\\S]*?\\bON\\s+${tblRe}(?=[\\s;,(]|$)[\\s\\S]*?\\bEXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+${fnRe}\\s*\\(`,
        'i',
      ).test(stmt),
    );
    if (!trigStmt) {
      errors.push(
        `Missing trigger "${trig.triggerName}" on "${trig.schema}"."${trig.table}" invoking "${trig.functionSchema}"."${trig.functionName}()".`,
      );
      continue;
    }
    for (const evt of trig.events) {
      if (!new RegExp(`\\b${evt}\\b`, 'i').test(trigStmt)) {
        errors.push(
          `Trigger "${trig.triggerName}" on "${trig.schema}"."${trig.table}" must bind event ${evt}.`,
        );
      }
    }
  }

  const guardFn = extractFunctionBlock(
    sql,
    'cannabis',
    'guard_production_run_child_mutation',
  );
  if (
    !guardFn ||
    !/FROM\s+"cannabis"\."ProductionRun"[\s\S]*?\bFOR\s+UPDATE\b/i.test(guardFn)
  ) {
    errors.push(
      '"cannabis"."guard_production_run_child_mutation"() must acquire SELECT ... FOR UPDATE on "cannabis"."ProductionRun".',
    );
  }

  const finalizerFn = extractFunctionBlock(
    sql,
    'cannabis',
    'enforce_production_run_lifecycle_and_finalization',
  );
  if (
    !finalizerFn ||
    !/"cannabis"\."ProductionRunInput"/i.test(finalizerFn) ||
    !/"cannabis"\."ProductionRunOutput"/i.test(finalizerFn) ||
    !/"shared"\."OrganizationMembership"/i.test(finalizerFn) ||
    !/requiresQapVarianceReview/i.test(finalizerFn)
  ) {
    errors.push(
      '"cannabis"."enforce_production_run_lifecycle_and_finalization"() must verify child inputs/outputs, active QAP membership, and the > 2.0% QAP review gate.',
    );
  }

  const settlementFn = extractFunctionBlock(
    sql,
    'salvage',
    'enforce_sale_settlement_transition',
  );
  if (
    !settlementFn ||
    !/BANK_SETTLEMENT_CONFIRMED/i.test(settlementFn) ||
    !/REFUNDED_OR_CHARGED_BACK/i.test(settlementFn) ||
    !/VERIFIED_BANK_WIRE/i.test(settlementFn)
  ) {
    errors.push(
      '"salvage"."enforce_sale_settlement_transition"() must enforce the PaymentSettlementState matrix and VERIFIED_BANK_WIRE direct settlement rule.',
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Validates the live PostgreSQL system catalogs against all Issue #2 security,
 * RLS, least-privilege, composite-FK, CHECK, partial-index, and trigger invariants.
 */
const EMPTY_SEARCH_PATH_PROCONFIG_VALUES = new Set([
  'search_path=""',
  'search_path=',
  "search_path=''",
]);

/**
 * Checks whether a pg_proc.proconfig array pins `search_path = ''`.
 * PostgreSQL formats `GUC_LIST_QUOTE` empty strings as `search_path=""`.
 */
export function hasPinnedEmptySearchPath(
  proconfig: readonly string[] | null | undefined,
): boolean {
  return Boolean(
    proconfig?.some((entry) => EMPTY_SEARCH_PATH_PROCONFIG_VALUES.has(entry)),
  );
}

export async function validateLiveDatabaseCatalog(
  client: SqlQueryClient,
): Promise<MigrationManifestValidationResult> {
  const errors: string[] = [];

  // 1. erp_app_user role attributes & zero inherited roles
  const roles = await client.$queryRaw<
    Array<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolconfig: string[] | null;
    }>
  >`
    SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolconfig
    FROM pg_catalog.pg_roles
    WHERE rolname = 'erp_app_user'
  `;
  const erpRole = roles[0];
  if (!erpRole) {
    errors.push('Role erp_app_user does not exist.');
  } else {
    if (!erpRole.rolcanlogin) {
      errors.push('Role erp_app_user must have LOGIN.');
    }
    if (erpRole.rolsuper || erpRole.rolbypassrls) {
      errors.push(
        'Role erp_app_user must have NOSUPERUSER and NOBYPASSRLS.',
      );
    }
    if (erpRole.rolcreatedb || erpRole.rolcreaterole) {
      errors.push(
        'Role erp_app_user must have NOCREATEDB and NOCREATEROLE.',
      );
    }
    if (
      !erpRole.rolconfig?.some(
        (cfg) => cfg === 'plan_cache_mode=force_custom_plan',
      )
    ) {
      errors.push(
        'Role erp_app_user must configure plan_cache_mode=force_custom_plan.',
      );
    }
  }

  const inheritedRoles = await client.$queryRaw<Array<{ roleName: string }>>`
    SELECT r.rolname AS "roleName"
    FROM pg_catalog.pg_auth_members am
    INNER JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
    INNER JOIN pg_catalog.pg_roles m ON m.oid = am.member
    WHERE m.rolname = 'erp_app_user'
  `;
  if (inheritedRoles.length > 0) {
    errors.push(
      `Role erp_app_user must not inherit roles; found: ${inheritedRoles.map((r) => r.roleName).join(', ')}.`,
    );
  }

  // 2. Schema usage & zero CREATE for erp_app_user
  const schemaRows = await client.$queryRaw<
    Array<{
      nspname: string;
      ownerName: string;
      hasUsage: boolean;
      hasCreate: boolean;
    }>
  >`
    SELECT
      n.nspname,
      r.rolname AS "ownerName",
      pg_catalog.has_schema_privilege('erp_app_user', n.oid, 'USAGE') AS "hasUsage",
      pg_catalog.has_schema_privilege('erp_app_user', n.oid, 'CREATE') AS "hasCreate"
    FROM pg_catalog.pg_namespace n
    INNER JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname IN ('shared', 'salvage', 'cannabis')
  `;
  for (const schema of EXPECTED_SCHEMAS) {
    const row = schemaRows.find((r) => r.nspname === schema);
    if (!row) {
      errors.push(`Schema "${schema}" is missing.`);
      continue;
    }
    if (row.ownerName === 'erp_app_user') {
      errors.push(`erp_app_user must not own schema "${schema}".`);
    }
    if (!row.hasUsage || row.hasCreate) {
      errors.push(
        `erp_app_user must have USAGE and lack CREATE on schema "${schema}".`,
      );
    }
  }

  // 3. Security definer helpers
  const procRows = await client.$queryRaw<
    Array<{
      schemaName: string;
      proname: string;
      argTypes: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      ownerSuper: boolean;
      ownerBypassRls: boolean;
      ownerName: string;
      erpExecute: boolean;
      publicExecute: boolean;
    }>
  >`
    SELECT
      n.nspname AS "schemaName",
      p.proname,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS "argTypes",
      p.prosecdef,
      p.proconfig,
      r.rolsuper AS "ownerSuper",
      r.rolbypassrls AS "ownerBypassRls",
      r.rolname AS "ownerName",
      pg_catalog.has_function_privilege('erp_app_user', p.oid, 'EXECUTE') AS "erpExecute",
      pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExecute"
    FROM pg_catalog.pg_proc p
    INNER JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    INNER JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'shared'
  `;

  for (const helper of EXPECTED_SECURITY_DEFINER_HELPERS) {
    const match = procRows.find(
      (p) =>
        p.schemaName === helper.schema &&
        p.proname === helper.name &&
        p.argTypes.includes(helper.signatureArgs),
    );
    if (!match) {
      errors.push(
        `Missing helper function "${helper.schema}"."${helper.name}(${helper.signatureArgs})".`,
      );
      continue;
    }
    if (!match.prosecdef) {
      errors.push(`Function "${helper.schema}"."${helper.name}" must be SECURITY DEFINER.`);
    }
    if (!hasPinnedEmptySearchPath(match.proconfig)) {
      errors.push(
        `Function "${helper.schema}"."${helper.name}" must pin search_path=''.`,
      );
    }
    if (!match.ownerSuper && !match.ownerBypassRls) {
      errors.push(
        `Function "${helper.schema}"."${helper.name}" owner (${match.ownerName}) must have SUPERUSER or BYPASSRLS.`,
      );
    }
    if (!match.erpExecute || match.publicExecute) {
      errors.push(
        `Function "${helper.schema}"."${helper.name}" must grant EXECUTE to erp_app_user and revoke from PUBLIC.`,
      );
    }
  }

  // 4. Tables, FORCE RLS, ownership & effective privileges
  const tableRows = await client.$queryRaw<
    Array<{
      schemaName: string;
      tableName: string;
      ownerName: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      canSelect: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canDelete: boolean;
      canTruncate: boolean;
    }>
  >`
    SELECT
      n.nspname AS "schemaName",
      c.relname AS "tableName",
      r.rolname AS "ownerName",
      c.relrowsecurity,
      c.relforcerowsecurity,
      pg_catalog.has_table_privilege('erp_app_user', c.oid, 'SELECT') AS "canSelect",
      pg_catalog.has_table_privilege('erp_app_user', c.oid, 'INSERT') AS "canInsert",
      pg_catalog.has_table_privilege('erp_app_user', c.oid, 'UPDATE') AS "canUpdate",
      pg_catalog.has_table_privilege('erp_app_user', c.oid, 'DELETE') AS "canDelete",
      pg_catalog.has_table_privilege('erp_app_user', c.oid, 'TRUNCATE') AS "canTruncate"
    FROM pg_catalog.pg_class c
    INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    INNER JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE c.relkind = 'r'
      AND n.nspname IN ('shared', 'salvage', 'cannabis')
  `;

  const policyRows = await client.$queryRaw<
    Array<{
      schemaname: string;
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>
  >`
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_catalog.pg_policies
    WHERE schemaname IN ('shared', 'salvage', 'cannabis')
  `;

  for (const pol of policyRows) {
    if (
      (pol.qual && /auth\.jwt/i.test(pol.qual)) ||
      (pol.with_check && /auth\.jwt/i.test(pol.with_check))
    ) {
      errors.push(
        `Policy "${pol.policyname}" on "${pol.schemaname}"."${pol.tablename}" references forbidden auth.jwt().`,
      );
    }
  }

  for (const spec of EXPECTED_TABLES) {
    const fq = `"${spec.schema}"."${spec.table}"`;
    const row = tableRows.find(
      (t) => t.schemaName === spec.schema && t.tableName === spec.table,
    );
    if (!row) {
      errors.push(`Missing table ${fq}.`);
      continue;
    }
    if (row.ownerName === 'erp_app_user') {
      errors.push(`erp_app_user must not own table ${fq}.`);
    }
    if (!row.relrowsecurity || !row.relforcerowsecurity) {
      errors.push(`Table ${fq} must have ENABLE and FORCE ROW LEVEL SECURITY.`);
    }

    const privMap = {
      SELECT: row.canSelect,
      INSERT: row.canInsert,
      UPDATE: row.canUpdate,
      DELETE: row.canDelete,
      TRUNCATE: row.canTruncate,
    };

    for (const priv of spec.allowedRuntimePrivs) {
      if (!privMap[priv]) {
        errors.push(`erp_app_user is missing ${priv} privilege on ${fq}.`);
      }
    }
    for (const priv of spec.forbiddenRuntimePrivs) {
      if (privMap[priv]) {
        errors.push(`erp_app_user has forbidden ${priv} privilege on ${fq}.`);
      }
    }

    for (const policyName of spec.requiredPolicies) {
      if (
        !policyRows.some(
          (p) =>
            p.schemaname === spec.schema &&
            p.tablename === spec.table &&
            p.policyname === policyName,
        )
      ) {
        errors.push(`Missing pg_policies entry "${policyName}" on ${fq}.`);
      }
    }
  }

  // Column-level privileges for User and Organization
  const colPrivRows = await client.$queryRaw<
    Array<{
      schemaName: string;
      tableName: string;
      attname: string;
      canUpdate: boolean;
    }>
  >`
    SELECT
      n.nspname AS "schemaName",
      c.relname AS "tableName",
      a.attname,
      pg_catalog.has_column_privilege('erp_app_user', c.oid, a.attname, 'UPDATE') AS "canUpdate"
    FROM pg_catalog.pg_attribute a
    INNER JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'shared'
      AND c.relname IN ('User', 'Organization')
      AND a.attnum > 0
      AND NOT a.attisdropped
  `;

  for (const spec of EXPECTED_TABLES.filter((t) => t.allowedUpdateColumns)) {
    const fq = `"${spec.schema}"."${spec.table}"`;
    for (const col of spec.allowedUpdateColumns ?? []) {
      const colRow = colPrivRows.find(
        (r) =>
          r.schemaName === spec.schema &&
          r.tableName === spec.table &&
          r.attname === col,
      );
      if (!colRow?.canUpdate) {
        errors.push(
          `erp_app_user missing allowed UPDATE privilege on ${fq}."${col}".`,
        );
      }
    }
    for (const col of spec.forbiddenUpdateColumns ?? []) {
      const colRow = colPrivRows.find(
        (r) =>
          r.schemaName === spec.schema &&
          r.tableName === spec.table &&
          r.attname === col,
      );
      if (colRow?.canUpdate) {
        errors.push(
          `erp_app_user has forbidden UPDATE privilege on ${fq}."${col}".`,
        );
      }
    }
  }

  // 5. Composite FKs and CHECK constraints
  const fkRows = await client.$queryRaw<
    Array<{
      childSchema: string;
      childTable: string;
      parentSchema: string;
      parentTable: string;
      childCols: string[];
      parentCols: string[];
    }>
  >`
    SELECT
      cn.nspname AS "childSchema",
      cc.relname AS "childTable",
      pn.nspname AS "parentSchema",
      pc.relname AS "parentTable",
      ARRAY(
        SELECT a.attname::text
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        INNER JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord
      ) AS "childCols",
      ARRAY(
        SELECT a.attname::text
        FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
        INNER JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
        ORDER BY k.ord
      ) AS "parentCols"
    FROM pg_catalog.pg_constraint con
    INNER JOIN pg_catalog.pg_class cc ON cc.oid = con.conrelid
    INNER JOIN pg_catalog.pg_namespace cn ON cn.oid = cc.relnamespace
    INNER JOIN pg_catalog.pg_class pc ON pc.oid = con.confrelid
    INNER JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE con.contype = 'f'
      AND cn.nspname IN ('shared', 'salvage', 'cannabis')
  `;

  for (const fk of EXPECTED_COMPOSITE_TENANT_FKS) {
    const found = fkRows.some(
      (r) =>
        r.childSchema === fk.schema &&
        r.childTable === fk.table &&
        r.parentSchema === fk.targetSchema &&
        r.parentTable === fk.targetTable &&
        r.childCols.length === 2 &&
        r.childCols[0] === 'organizationId' &&
        r.childCols[1] === fk.column &&
        r.parentCols[0] === 'organizationId' &&
        r.parentCols[1] === 'id',
    );
    if (!found) {
      errors.push(
        `Missing composite FK ("organizationId", "${fk.column}") on "${fk.schema}"."${fk.table}".`,
      );
    }
  }

  const checkRows = await client.$queryRaw<
    Array<{ schemaName: string; tableName: string; conname: string }>
  >`
    SELECT n.nspname AS "schemaName", c.relname AS "tableName", con.conname
    FROM pg_catalog.pg_constraint con
    INNER JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'c'
      AND n.nspname IN ('shared', 'salvage', 'cannabis')
  `;

  for (const check of [
    ...EXPECTED_CHECK_CONSTRAINTS,
    ...EXPECTED_INCREMENTAL_CHECK_CONSTRAINTS,
  ]) {
    if (
      !checkRows.some(
        (r) =>
          r.schemaName === check.schema &&
          r.tableName === check.table &&
          r.conname === check.name,
      )
    ) {
      errors.push(
        `Missing CHECK constraint "${check.name}" on "${check.schema}"."${check.table}".`,
      );
    }
  }
  for (const forbidden of FORBIDDEN_CHECK_CONSTRAINTS) {
    if (
      checkRows.some(
        (r) =>
          r.schemaName === forbidden.schema &&
          r.tableName === forbidden.table &&
          r.conname === forbidden.name,
      )
    ) {
      errors.push(
        `Forbidden CHECK constraint "${forbidden.name}" present on "${forbidden.schema}"."${forbidden.table}".`,
      );
    }
  }

  // 6. Partial unique indexes
  const indexRows = await client.$queryRaw<
    Array<{
      schemaName: string;
      tableName: string;
      indexName: string;
      indisunique: boolean;
      hasPredicate: boolean;
    }>
  >`
    SELECT
      n.nspname AS "schemaName",
      t.relname AS "tableName",
      i.relname AS "indexName",
      ix.indisunique,
      (ix.indpred IS NOT NULL) AS "hasPredicate"
    FROM pg_catalog.pg_index ix
    INNER JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
    INNER JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
    INNER JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname IN ('shared', 'salvage', 'cannabis')
  `;

  for (const idx of EXPECTED_PARTIAL_UNIQUE_INDEXES) {
    const row = indexRows.find(
      (r) =>
        r.schemaName === idx.schema &&
        r.tableName === idx.table &&
        r.indexName === idx.name,
    );
    if (!row || !row.indisunique || !row.hasPredicate) {
      errors.push(
        `Missing partial unique index "${idx.name}" on "${idx.schema}"."${idx.table}".`,
      );
    }
  }

  // 7. Triggers
  const trigRows = await client.$queryRaw<
    Array<{
      schemaName: string;
      tableName: string;
      tgname: string;
      fnSchema: string;
      fnName: string;
      tgtype: number;
    }>
  >`
    SELECT
      n.nspname AS "schemaName",
      c.relname AS "tableName",
      tg.tgname,
      pn.nspname AS "fnSchema",
      p.proname AS "fnName",
      tg.tgtype
    FROM pg_catalog.pg_trigger tg
    INNER JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    INNER JOIN pg_catalog.pg_proc p ON p.oid = tg.tgfoid
    INNER JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
    WHERE NOT tg.tgisinternal
      AND n.nspname IN ('shared', 'salvage', 'cannabis')
  `;

  for (const trig of EXPECTED_TRIGGERS) {
    const row = trigRows.find(
      (r) =>
        r.schemaName === trig.schema &&
        r.tableName === trig.table &&
        r.tgname === trig.triggerName &&
        r.fnSchema === trig.functionSchema &&
        r.fnName === trig.functionName,
    );
    if (!row) {
      errors.push(
        `Missing trigger "${trig.triggerName}" on "${trig.schema}"."${trig.table}" -> "${trig.functionSchema}"."${trig.functionName}".`,
      );
      continue;
    }
    // PostgreSQL pg_trigger.tgtype bits: BEFORE=2, INSERT=4, DELETE=8, UPDATE=16
    if ((row.tgtype & 2) === 0) {
      errors.push(`Trigger "${trig.triggerName}" must be a BEFORE trigger.`);
    }
    const eventBits: Record<'INSERT' | 'DELETE' | 'UPDATE', number> = {
      INSERT: 4,
      DELETE: 8,
      UPDATE: 16,
    };
    for (const evt of trig.events) {
      if ((row.tgtype & eventBits[evt]) === 0) {
        errors.push(
          `Trigger "${trig.triggerName}" must fire on ${evt}.`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
