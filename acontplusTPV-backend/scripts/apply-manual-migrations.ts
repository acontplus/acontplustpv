#!/usr/bin/env tsx
// =============================================================================
// scripts/apply-manual-migrations.ts  v2 — nombres PascalCase correctos
// =============================================================================

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({ log: ['warn', 'error'] })

const isDryRun = process.argv.includes('--dry-run')
const onlyNum  = process.argv.includes('--migration')
  ? parseInt(process.argv[process.argv.indexOf('--migration') + 1])
  : null

interface Migration {
  id: number; name: string; description: string; check: string; sql: string
}

const migrations: Migration[] = [

  {
    id: 1,
    name: 'unique_open_day_per_establishment',
    description: 'Solo puede haber una jornada abierta por establecimiento',
    check: `SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND tablename='BusinessDay'
              AND indexname='unique_open_day_per_establishment'`,
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS unique_open_day_per_establishment
          ON "BusinessDay" ("tenantId","establishmentId")
          WHERE "isOpen" = true`,
  },

  {
    id: 2,
    name: 'order_author_required',
    description: 'Todo pedido debe tener createdByUserId o createdByDeviceId',
    check: `SELECT 1 FROM information_schema.check_constraints
            WHERE constraint_schema='public'
              AND constraint_name='order_author_required'`,
    sql: `ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS order_author_required;
          ALTER TABLE "Order" ADD CONSTRAINT order_author_required
          CHECK ("createdByUserId" IS NOT NULL OR "createdByDeviceId" IS NOT NULL)`,
  },

  {
    id: 3,
    name: 'order_location_when_confirmed',
    description: 'Pedidos confirmados deben tener mesa, alias o turno de kiosco',
    check: `SELECT 1 FROM information_schema.check_constraints
            WHERE constraint_schema='public'
              AND constraint_name='order_location_when_confirmed'`,
    sql: `ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS order_location_when_confirmed;
          ALTER TABLE "Order" ADD CONSTRAINT order_location_when_confirmed
          CHECK (
            status IN ('DRAFT','KIOSK_PENDING','CANCELLED','EXPIRED')
            OR "tableId" IS NOT NULL
            OR "tableAlias" IS NOT NULL
            OR "kioskTurnNumber" IS NOT NULL
          )`,
  },

  {
    id: 4,
    name: 'credit_debtor_xor',
    description: 'Un crédito pertenece a un usuario XOR un cliente (nunca ambos ni ninguno)',
    check: `SELECT 1 FROM information_schema.check_constraints
            WHERE constraint_schema='public'
              AND constraint_name='credit_debtor_xor'`,
    sql: `ALTER TABLE "CreditTransaction" DROP CONSTRAINT IF EXISTS credit_debtor_xor;
          ALTER TABLE "CreditTransaction" ADD CONSTRAINT credit_debtor_xor
          CHECK (
            ("debtorUserId" IS NOT NULL)::int +
            ("debtorCustomerId" IS NOT NULL)::int = 1
          )`,
  },

  {
    id: 5,
    name: 'rls_tenant_isolation',
    description: 'Row-Level Security en las 27 tablas (idempotente — siempre re-aplica)',
    check: `SELECT 1 FROM pg_tables
            WHERE schemaname='public' AND tablename='Establishment'
              AND rowsecurity=true`,
    sql: `
CREATE OR REPLACE FUNCTION current_tenant_id()
  RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  $$;

ALTER TABLE "Establishment"       ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Establishment";
CREATE POLICY tenant_isolation ON "Establishment"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "PointOfSale"         ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PointOfSale";
CREATE POLICY tenant_isolation ON "PointOfSale"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "User"                ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "User";
CREATE POLICY tenant_isolation ON "User"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "UserRole"            ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "UserRole";
CREATE POLICY tenant_isolation ON "UserRole"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "Device"              ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Device";
CREATE POLICY tenant_isolation ON "Device"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "DeviceToken"         ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DeviceToken";
CREATE POLICY tenant_isolation ON "DeviceToken"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "EmployeeContract"    ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "EmployeeContract";
CREATE POLICY tenant_isolation ON "EmployeeContract"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "EmployeeLedgerEntry" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "EmployeeLedgerEntry";
CREATE POLICY tenant_isolation ON "EmployeeLedgerEntry"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "PayrollRecord"       ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PayrollRecord";
CREATE POLICY tenant_isolation ON "PayrollRecord"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "Warehouse"           ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Warehouse";
CREATE POLICY tenant_isolation ON "Warehouse"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "ProductCategory"     ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ProductCategory";
CREATE POLICY tenant_isolation ON "ProductCategory"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "Product"             ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Product";
CREATE POLICY tenant_isolation ON "Product"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "StockLevel"          ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "StockLevel";
CREATE POLICY tenant_isolation ON "StockLevel"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "StockMovement"       ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "StockMovement";
CREATE POLICY tenant_isolation ON "StockMovement"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "Supplier"            ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Supplier";
CREATE POLICY tenant_isolation ON "Supplier"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "PurchaseOrder"       ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PurchaseOrder";
CREATE POLICY tenant_isolation ON "PurchaseOrder"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "PurchaseOrderItem"   ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PurchaseOrderItem";
CREATE POLICY tenant_isolation ON "PurchaseOrderItem"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "InventoryAudit"      ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "InventoryAudit";
CREATE POLICY tenant_isolation ON "InventoryAudit"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "InventoryAuditItem"  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "InventoryAuditItem";
CREATE POLICY tenant_isolation ON "InventoryAuditItem"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "BusinessDay"         ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BusinessDay";
CREATE POLICY tenant_isolation ON "BusinessDay"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "Table"               ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Table";
CREATE POLICY tenant_isolation ON "Table"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "Order"               ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Order";
CREATE POLICY tenant_isolation ON "Order"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "OrderItem"           ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OrderItem";
CREATE POLICY tenant_isolation ON "OrderItem"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "TransferPayment"     ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TransferPayment";
CREATE POLICY tenant_isolation ON "TransferPayment"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "CashRegisterEvent"   ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CashRegisterEvent";
CREATE POLICY tenant_isolation ON "CashRegisterEvent"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "Customer"            ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Customer";
CREATE POLICY tenant_isolation ON "Customer"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id());

ALTER TABLE "CreditTransaction"   ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CreditTransaction";
CREATE POLICY tenant_isolation ON "CreditTransaction"
  USING ("tenantId"=current_tenant_id() OR current_tenant_id() IS NULL)
  WITH CHECK ("tenantId"=current_tenant_id())
    `,
  },

  {
    id: 6,
    name: 'idx_orders_print_pending',
    description: 'PRINT_NODE encuentra comandas PENDING eficientemente',
    check: `SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND tablename='Order'
              AND indexname='idx_orders_print_pending'`,
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_print_pending
          ON "Order" ("tenantId","establishmentId","createdAt")
          WHERE "printStatus" = 'PENDING'`,
  },

  {
    id: 7,
    name: 'idx_orders_waiter_sync',
    description: 'PowerSync filtra pedidos activos del mesero eficientemente',
    check: `SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND tablename='Order'
              AND indexname='idx_orders_waiter_sync'`,
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_waiter_sync
          ON "Order" ("tenantId","createdByUserId","createdAt")
          WHERE status NOT IN (
            'PAID_CASH','PAID_TRANSFER_CONFIRMED',
            'PAID_CREDIT','CANCELLED','EXPIRED'
          )`,
  },

  {
    id: 8,
    name: 'unique_active_contract_per_employee',
    description: 'Un empleado solo tiene un contrato vigente (effectiveTo=NULL)',
    check: `SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND tablename='EmployeeContract'
              AND indexname='unique_active_contract_per_employee'`,
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS unique_active_contract_per_employee
          ON "EmployeeContract" ("tenantId","userId")
          WHERE "effectiveTo" IS NULL AND "deletedAt" IS NULL`,
  },

  {
    id: 9,
    name: 'unique_order_number_per_pos',
    description: 'El número tributario es único por punto de emisión',
    check: `SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND tablename='Order'
              AND indexname='unique_order_number_per_pos'`,
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS unique_order_number_per_pos
          ON "Order" ("tenantId","pointOfSaleId","orderNumber")
          WHERE "orderNumber" IS NOT NULL`,
  },

	{
		id: 10,
		name: 'fn_assign_order_number',
		description: 'Función PG para asignación atómica del número "001-001-000000001"',
		check: `SELECT 1 FROM pg_proc p
				JOIN pg_namespace n ON n.oid=p.pronamespace
				WHERE n.nspname='public' AND p.proname='assign_order_number'`,
		sql: `
	CREATE OR REPLACE FUNCTION assign_order_number(
	  p_order_id  uuid,
	  p_pos_id    uuid,
	  p_tenant_id uuid
	)
	RETURNS text LANGUAGE plpgsql AS $func$
	DECLARE
	  v_seq          int;
	  v_est_code     text;
	  v_pos_code     text;
	  v_order_number text;
	BEGIN
	  UPDATE "PointOfSale"
		SET "lastSequential" = "lastSequential" + 1
		WHERE id=p_pos_id AND "tenantId"=p_tenant_id
		RETURNING "lastSequential", code INTO v_seq, v_pos_code;

	  IF NOT FOUND THEN
		RAISE EXCEPTION 'PointOfSale % not found for tenant %', p_pos_id, p_tenant_id;
	  END IF;

	  SELECT e.code INTO v_est_code
		FROM "Establishment" e
		JOIN "PointOfSale" pos ON pos."establishmentId"=e.id
		WHERE pos.id=p_pos_id AND pos."tenantId"=p_tenant_id;

	  v_order_number := v_est_code || '-' || v_pos_code
					 || '-' || LPAD(v_seq::text, 9, '0');

	  UPDATE "Order"
		SET "orderNumber"=v_order_number
		WHERE id=p_order_id AND "tenantId"=p_tenant_id AND "orderNumber" IS NULL;

	  IF NOT FOUND THEN
		SELECT "orderNumber" INTO v_order_number FROM "Order" WHERE id=p_order_id;
	  END IF;

	  RETURN v_order_number;
	END;
	$func$`,
	  },
]

// =============================================================================
// RUNNER
// =============================================================================

async function isApplied(m: Migration): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<unknown[]>(m.check.trim())
    return (rows as unknown[]).length > 0
  } catch { return false }
}

async function apply(m: Migration): Promise<void> {
  const stmts = m.sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  for (const stmt of stmts) {
    await prisma.$executeRawUnsafe(stmt + ';')
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║   ACONTPLUS — Manual Migrations Runner v2 (PascalCase)   ║')
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  if (isDryRun) console.log('⚠  DRY RUN — ningún SQL será ejecutado\n')

  const toRun = onlyNum ? migrations.filter(m => m.id === onlyNum) : migrations
  if (!toRun.length) { console.error(`✗ Migración ${onlyNum} no existe`); process.exit(1) }

  let applied = 0, skipped = 0, failed = 0

  for (const m of toRun) {
    const label = `[${String(m.id).padStart(2,'0')}] ${m.name}`
    process.stdout.write(label.padEnd(55, '.') + ' ')

    const done = await isApplied(m)
    if (done && m.id !== 5 && m.id !== 10) { console.log('SKIP'); skipped++; continue }
    if (isDryRun) { console.log('DRY-RUN'); continue }

    try {
      await apply(m)
      console.log('OK ✓')
      applied++
    } catch (e: unknown) {
      console.log('FAILED ✗')
      console.error(`       ${e instanceof Error ? e.message : e}`)
      failed++
      if (m.id <= 4) { await prisma.$disconnect(); process.exit(1) }
    }
  }

  console.log(`\n  Aplicadas: ${applied}  Saltadas: ${skipped}  Fallidas: ${failed}`)
  if (failed) { await prisma.$disconnect(); process.exit(1) }

  if (!isDryRun && applied > 0) {
    console.log('\n✓ Verificando RLS...\n')
    const rows = await prisma.$queryRaw<Array<{tablename:string;rowsecurity:boolean}>>`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname='public'
        AND tablename IN (
          'BusinessDay','Order','CashRegisterEvent','CreditTransaction',
          'TransferPayment','User','Device','Establishment','PointOfSale'
        )
      ORDER BY tablename`
    for (const r of rows)
      console.log(`  ${r.tablename.padEnd(25)} ${r.rowsecurity ? '✓ RLS activo' : '✗ INACTIVO'}`)
  }

  console.log('\n✓ Base de datos blindada y lista.\n')
}

main()
  .catch(e => { console.error('Error fatal:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
