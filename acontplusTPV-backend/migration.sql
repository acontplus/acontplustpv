-- =============================================================================
-- Migración: blindaje_b1_b3
-- Operación Blindaje — Fase 1
--
-- B1: RLS fail-closed
--   Elimina la cláusula "OR current_tenant_id() IS NULL" de TODAS las
--   políticas USING. Sin tenant configurado en sesión → cero filas visibles.
--   Esto convierte el sistema de "fail open" a "fail closed".
--
-- B3: localSequence UNIQUE en BD
--   Añade restricción única (tenantId, localSequence) en Order para que
--   la invariante offline-first esté garantizada por la base de datos,
--   no solo por convención de código.
--
-- IMPORTANTE — Ejecución:
--   1. Primero despliega los cambios a context.ts, server.ts y prisma.ts
--      (que añaden el cliente prismaAuth sin RLS para autenticación).
--   2. Luego aplica esta migración.
--   Si se aplica en orden inverso, el servidor no podrá autenticar tokens
--   hasta que el código nuevo esté desplegado.
-- =============================================================================

-- =============================================================================
-- B1: Actualizar la función auxiliar current_tenant_id()
-- Misma lógica, sin cambios — la dejamos aquí para idempotencia.
-- =============================================================================
CREATE OR REPLACE FUNCTION current_tenant_id()
  RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  $$;

-- =============================================================================
-- B1: Reemplazar las 27 políticas RLS — FAIL CLOSED
--
-- ANTES (fail open):
--   USING ("tenantId" = current_tenant_id() OR current_tenant_id() IS NULL)
--
-- DESPUÉS (fail closed):
--   USING ("tenantId" = current_tenant_id())
--
-- Efecto: si app.current_tenant_id no está configurado, current_tenant_id()
-- devuelve NULL, "tenantId" = NULL siempre es FALSE en SQL → cero filas.
-- =============================================================================

-- "Establishment"
DROP POLICY IF EXISTS tenant_isolation ON "Establishment";
CREATE POLICY tenant_isolation ON "Establishment"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "PointOfSale"
DROP POLICY IF EXISTS tenant_isolation ON "PointOfSale";
CREATE POLICY tenant_isolation ON "PointOfSale"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "User"
DROP POLICY IF EXISTS tenant_isolation ON "User";
CREATE POLICY tenant_isolation ON "User"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "UserRole"
DROP POLICY IF EXISTS tenant_isolation ON "UserRole";
CREATE POLICY tenant_isolation ON "UserRole"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "Device"
DROP POLICY IF EXISTS tenant_isolation ON "Device";
CREATE POLICY tenant_isolation ON "Device"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "DeviceToken"
DROP POLICY IF EXISTS tenant_isolation ON "DeviceToken";
CREATE POLICY tenant_isolation ON "DeviceToken"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "EmployeeContract"
DROP POLICY IF EXISTS tenant_isolation ON "EmployeeContract";
CREATE POLICY tenant_isolation ON "EmployeeContract"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "EmployeeLedgerEntry"
DROP POLICY IF EXISTS tenant_isolation ON "EmployeeLedgerEntry";
CREATE POLICY tenant_isolation ON "EmployeeLedgerEntry"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "PayrollRecord"
DROP POLICY IF EXISTS tenant_isolation ON "PayrollRecord";
CREATE POLICY tenant_isolation ON "PayrollRecord"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "Warehouse"
DROP POLICY IF EXISTS tenant_isolation ON "Warehouse";
CREATE POLICY tenant_isolation ON "Warehouse"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "ProductCategory"
DROP POLICY IF EXISTS tenant_isolation ON "ProductCategory";
CREATE POLICY tenant_isolation ON "ProductCategory"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "Product"
DROP POLICY IF EXISTS tenant_isolation ON "Product";
CREATE POLICY tenant_isolation ON "Product"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "StockLevel"
DROP POLICY IF EXISTS tenant_isolation ON "StockLevel";
CREATE POLICY tenant_isolation ON "StockLevel"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "StockMovement"
DROP POLICY IF EXISTS tenant_isolation ON "StockMovement";
CREATE POLICY tenant_isolation ON "StockMovement"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "Supplier"
DROP POLICY IF EXISTS tenant_isolation ON "Supplier";
CREATE POLICY tenant_isolation ON "Supplier"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "PurchaseOrder"
DROP POLICY IF EXISTS tenant_isolation ON "PurchaseOrder";
CREATE POLICY tenant_isolation ON "PurchaseOrder"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "PurchaseOrderItem"
DROP POLICY IF EXISTS tenant_isolation ON "PurchaseOrderItem";
CREATE POLICY tenant_isolation ON "PurchaseOrderItem"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "InventoryAudit"
DROP POLICY IF EXISTS tenant_isolation ON "InventoryAudit";
CREATE POLICY tenant_isolation ON "InventoryAudit"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "InventoryAuditItem"
DROP POLICY IF EXISTS tenant_isolation ON "InventoryAuditItem";
CREATE POLICY tenant_isolation ON "InventoryAuditItem"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "BusinessDay"
DROP POLICY IF EXISTS tenant_isolation ON "BusinessDay";
CREATE POLICY tenant_isolation ON "BusinessDay"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "Table"
DROP POLICY IF EXISTS tenant_isolation ON "Table";
CREATE POLICY tenant_isolation ON "Table"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "Order"
DROP POLICY IF EXISTS tenant_isolation ON "Order";
CREATE POLICY tenant_isolation ON "Order"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "OrderItem"
DROP POLICY IF EXISTS tenant_isolation ON "OrderItem";
CREATE POLICY tenant_isolation ON "OrderItem"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "TransferPayment"
DROP POLICY IF EXISTS tenant_isolation ON "TransferPayment";
CREATE POLICY tenant_isolation ON "TransferPayment"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "CashRegisterEvent"
DROP POLICY IF EXISTS tenant_isolation ON "CashRegisterEvent";
CREATE POLICY tenant_isolation ON "CashRegisterEvent"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "Customer"
DROP POLICY IF EXISTS tenant_isolation ON "Customer";
CREATE POLICY tenant_isolation ON "Customer"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- "CreditTransaction"
DROP POLICY IF EXISTS tenant_isolation ON "CreditTransaction";
CREATE POLICY tenant_isolation ON "CreditTransaction"
  USING  ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- =============================================================================
-- B3: UNIQUE constraint sobre (tenantId, localSequence) en "Order"
--
-- Garantiza que el localSequence generado en dispositivo sea único por tenant.
-- Si dos dispositivos generan el mismo localSequence (colisión de UUID corto),
-- la BD rechaza el segundo INSERT con error P2002 (Unique constraint violated).
-- syncOrder captura ese error y devuelve el pedido existente — idempotente.
-- =============================================================================
DROP INDEX IF EXISTS unique_order_local_sequence;
CREATE UNIQUE INDEX unique_order_local_sequence
  ON "Order" ("tenantId", "localSequence");

-- =============================================================================
-- Verificación post-migración (ejecutar manualmente para confirmar):
-- =============================================================================
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public' AND tablename = 'Order';
--
-- SELECT polname, polqual::text
--   FROM pg_policy
--   WHERE polrelid = '"Order"'::regclass
--   AND polname = 'tenant_isolation';
-- El polqual NO debe contener "IS NULL".
--
-- SELECT indexname FROM pg_indexes
--   WHERE tablename = 'Order' AND indexname = 'unique_order_local_sequence';
