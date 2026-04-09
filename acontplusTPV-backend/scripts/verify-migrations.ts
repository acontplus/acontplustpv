#!/usr/bin/env tsx
// =============================================================================
// scripts/verify-migrations.ts  v2 — nombres PascalCase correctos
// Solo lectura — no modifica nada
//
// USO: npx tsx scripts/verify-migrations.ts
// =============================================================================

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient({ log: ['error'] })

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║   ACONTPLUS — Migration Status Checker v2 (PascalCase)   ║')
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  // ─── 1. Índices parciales ─────────────────────────────────────────────────
  console.log('── Índices parciales ──────────────────────────────────────')
  const indexes = await prisma.$queryRaw<Array<{indexname:string;tablename:string}>>`
    SELECT indexname, tablename FROM pg_indexes
    WHERE schemaname='public'
      AND indexname IN (
        'unique_open_day_per_establishment',
        'idx_orders_print_pending',
        'idx_orders_waiter_sync',
        'unique_active_contract_per_employee',
        'unique_order_number_per_pos'
      )
    ORDER BY indexname`

  const expectedIdx = [
    { name: 'unique_open_day_per_establishment',  table: 'BusinessDay'      },
    { name: 'idx_orders_print_pending',           table: 'Order'            },
    { name: 'idx_orders_waiter_sync',             table: 'Order'            },
    { name: 'unique_active_contract_per_employee',table: 'EmployeeContract' },
    { name: 'unique_order_number_per_pos',        table: 'Order'            },
  ]
  let idxOk = 0
  for (const e of expectedIdx) {
    const found = indexes.find(i => i.indexname === e.name)
    const ok = found !== undefined
    console.log(`  ${e.name.padEnd(45)} ${ok ? '✓' : '✗ FALTA'}`)
    if (ok) idxOk++
  }

  // ─── 2. CHECK constraints ─────────────────────────────────────────────────
  console.log('\n── CHECK constraints ──────────────────────────────────────')
  const constraints = await prisma.$queryRaw<Array<{constraint_name:string}>>`
    SELECT constraint_name FROM information_schema.check_constraints
    WHERE constraint_schema='public'
      AND constraint_name IN (
        'order_author_required',
        'order_location_when_confirmed',
        'credit_debtor_xor'
      )`

  const expectedCk = ['order_author_required','order_location_when_confirmed','credit_debtor_xor']
  let ckOk = 0
  for (const name of expectedCk) {
    const ok = constraints.some(c => c.constraint_name === name)
    console.log(`  ${name.padEnd(45)} ${ok ? '✓' : '✗ FALTA'}`)
    if (ok) ckOk++
  }

  // ─── 3. RLS por tabla (PascalCase exacto) ─────────────────────────────────
  console.log('\n── Row-Level Security (27 tablas) ─────────────────────────')
  const rlsRows = await prisma.$queryRaw<Array<{tablename:string;rowsecurity:boolean}>>`
    SELECT tablename, rowsecurity FROM pg_tables
    WHERE schemaname='public'
      AND tablename IN (
        'Establishment','PointOfSale','User','UserRole',
        'Device','DeviceToken','EmployeeContract','EmployeeLedgerEntry',
        'PayrollRecord','Warehouse','ProductCategory','Product',
        'StockLevel','StockMovement','Supplier','PurchaseOrder',
        'PurchaseOrderItem','InventoryAudit','InventoryAuditItem',
        'BusinessDay','Table','Order','OrderItem','TransferPayment',
        'CashRegisterEvent','Customer','CreditTransaction'
      )
    ORDER BY tablename`

  const expected27 = [
    'BusinessDay','CashRegisterEvent','CreditTransaction','Customer',
    'Device','DeviceToken','EmployeeContract','EmployeeLedgerEntry',
    'Establishment','InventoryAudit','InventoryAuditItem','Order',
    'OrderItem','PayrollRecord','PointOfSale','Product','ProductCategory',
    'PurchaseOrder','PurchaseOrderItem','StockLevel','StockMovement',
    'Supplier','Table','TransferPayment','User','UserRole','Warehouse',
  ]
  let rlsOk = 0, rlsMissing = 0
  for (const tbl of expected27) {
    const row = rlsRows.find(r => r.tablename === tbl)
    if (!row) {
      console.log(`  ${tbl.padEnd(30)} ✗ TABLA NO ENCONTRADA`)
      rlsMissing++
    } else if (!row.rowsecurity) {
      console.log(`  ${tbl.padEnd(30)} ✗ RLS INACTIVO`)
      rlsMissing++
    } else {
      console.log(`  ${tbl.padEnd(30)} ✓`)
      rlsOk++
    }
  }

  // ─── 4. Funciones PostgreSQL ──────────────────────────────────────────────
  console.log('\n── Funciones PostgreSQL ───────────────────────────────────')
  const fns = await prisma.$queryRaw<Array<{proname:string}>>`
    SELECT p.proname FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN ('assign_order_number','current_tenant_id')
    ORDER BY p.proname`

  let fnOk = 0
  for (const name of ['assign_order_number','current_tenant_id']) {
    const ok = fns.some(f => f.proname === name)
    console.log(`  ${name.padEnd(45)} ${ok ? '✓' : '✗ FALTA'}`)
    if (ok) fnOk++
  }

  // ─── 5. Resumen ───────────────────────────────────────────────────────────
  const total    = idxOk + ckOk + rlsOk + fnOk
  const expected = 5 + 3 + 27 + 2   // = 37
  const allOk    = total === expected && rlsMissing === 0

  console.log('\n── Resumen ────────────────────────────────────────────────')
  console.log(`  Índices parciales : ${idxOk}/5`)
  console.log(`  CHECK constraints : ${ckOk}/3`)
  console.log(`  RLS tablas        : ${rlsOk}/27${rlsMissing > 0 ? ` (${rlsMissing} pendientes)` : ''}`)
  console.log(`  Funciones PG      : ${fnOk}/2`)
  console.log(`  Total             : ${total}/${expected}`)
  console.log()
  console.log(`  Estado: ${allOk
    ? '✓  BASE DE DATOS COMPLETAMENTE BLINDADA'
    : '⚠  MIGRACIONES PENDIENTES — ejecuta apply-manual-migrations.ts'}`)
  console.log()
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
