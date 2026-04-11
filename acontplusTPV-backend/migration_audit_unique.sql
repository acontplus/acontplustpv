-- =============================================================================
-- migration_audit_unique.sql
-- Partial Unique Index: una auditoría IN_PROGRESS por bodega
--
-- Propósito:
--   Garantiza a nivel de base de datos que solo puede existir UNA auditoría
--   con estado IN_PROGRESS para la misma combinación (tenantId, warehouseId).
--   Dos llamadas concurrentes a startAudit para la misma bodega producirían
--   un error P2002 de Prisma que el router maneja como CONFLICT limpio.
--
-- Por qué partial index y no unique normal:
--   Una bodega puede tener MÚLTIPLES auditorías históricas (COMPLETED).
--   El constraint solo aplica cuando status = 'IN_PROGRESS'.
--   Un UNIQUE normal en (tenantId, warehouseId) impediría el historial.
--
-- Cómo aplicar:
--   Este script debe ejecutarse MANUALMENTE contra la base de datos,
--   igual que el resto de las migraciones manuales del proyecto.
--   NO puede ir dentro de un bloque BEGIN/COMMIT porque CREATE INDEX
--   CONCURRENTLY no se puede ejecutar dentro de una transacción.
--
--   Opción A — psql directo:
--     psql -d acontplusTPV -f migration_audit_unique.sql
--
--   Opción B — Prisma create-only:
--     npx prisma migrate --create-only
--     Pegar este contenido en el archivo generado
--     Ejecutar manualmente (no con prisma migrate deploy)
--
-- Verificar después de aplicar:
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'InventoryAudit'
--     AND indexname = 'InventoryAudit_warehouse_in_progress_key';
--
-- Para revertir (solo en desarrollo):
--   DROP INDEX CONCURRENTLY IF EXISTS "InventoryAudit_warehouse_in_progress_key";
-- =============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  "InventoryAudit_warehouse_in_progress_key"
ON "InventoryAudit" ("tenantId", "warehouseId")
WHERE status = 'IN_PROGRESS';


-- =============================================================================
-- ACCIÓN REQUERIDA: deprecar apply-manual-migrations.ts
-- =============================================================================
--
-- El archivo scripts/apply-manual-migrations.ts contiene políticas RLS con
-- la cláusula "OR current_tenant_id() IS NULL" (fail-OPEN).
-- Si se aplica ese script en producción en lugar de migration.sql (fail-CLOSED),
-- el aislamiento multi-tenant queda silenciosamente roto.
--
-- ACCIÓN: renombrar o eliminar ese archivo para que sea imposible confundirlo.
--
-- Ejecutar desde la raíz del proyecto:
--   mv scripts/apply-manual-migrations.ts scripts/DEPRECATED_apply-manual-migrations.ts
--
-- Y añadir al inicio del archivo renombrado el siguiente comentario de advertencia:
--
--   // ⚠️ DEPRECADO — NO USAR EN PRODUCCIÓN
--   // Este script contiene políticas RLS fail-OPEN (OR current_tenant_id() IS NULL).
--   // El script correcto para producción es migration.sql en la raíz del proyecto,
--   // que implementa políticas fail-CLOSED sin la cláusula OR NULL.
--   // Ver MIGRATIONS_README.md para el proceso correcto de despliegue.
--
-- =============================================================================
