// =============================================================================
// apps/api/src/lib/rls.ts
// Row-Level Security wrapper
//
// REGLA CRÍTICA (Instrucciones §1):
//   set_config('app.current_tenant_id', tenantId, true) DEBE ejecutarse dentro
//   de una $transaction de Prisma. El tercer parámetro `true` hace el valor
//   LOCAL a la transacción — se limpia automáticamente al terminar.
//   NUNCA ejecutar fuera de transacción: el connection pool reutiliza
//   conexiones y causaría fugas de datos entre tenants.
// =============================================================================

import { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from './prisma'

type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

/**
 * Ejecuta una función dentro de una transacción Prisma con el tenant_id
 * establecido como configuración local de PostgreSQL.
 *
 * Uso:
 *   const orders = await withTenant(tenantId, (tx) =>
 *     tx.order.findMany({ where: { status: 'CONFIRMED' } })
 *   )
 *
 * El RLS de PostgreSQL filtrará automáticamente por tenant_id en cada query
 * ejecutada dentro de la transacción.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: PrismaTransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Establece el tenant_id como LOCAL a esta transacción.
    // true = local a la transacción, no a la conexión completa.
    await tx.$executeRaw`
      SELECT set_config('app.current_tenant_id', ${tenantId}, true)
    `
    return fn(tx)
  })
}

/**
 * Versión que acepta opciones de transacción Prisma (timeout, isolation level).
 * Usar cuando se necesite control fino sobre la transacción (ej: arqueos).
 */
export async function withTenantOptions<T>(
  tenantId: string,
  fn: (tx: PrismaTransactionClient) => Promise<T>,
  options: Parameters<PrismaClient['$transaction']>[1],
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT set_config('app.current_tenant_id', ${tenantId}, true)
    `
    return fn(tx)
  }, options)
}
