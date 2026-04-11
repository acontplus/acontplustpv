// =============================================================================
// =============================================================================
// apps/api/src/routers/audit.ts
// Arqueo de Inventario (Auditoría Física) — Paso 11
//
// Instrucciones §4, §6 — reglas críticas implementadas:
//
//   1. UNA AUDITORÍA ACTIVA POR BODEGA: guard contra apertura duplicada.
//      Dos arqueos simultáneos en la misma bodega aplicarían ajustes dobles.
//
//   2. theoreticalStock se captura en recordItem (momento del conteo),
//      no en completeAudit. Durante un arqueo las ventas siguen activas —
//      si se leyera el stock en el cierre, el "esperado" habría cambiado.
//
//   3. completeAudit es ATÓMICO con withTenantOptions:
//      Para CADA ítem con variance ≠ 0:
//        a) StockMovement(AUDIT_ADJUSTMENT) — append-only, auditId vinculado
//        b) StockLevel UPDATE con el delta exacto (no sobrescritura)
//      StockLevel se actualiza con increment/decrement para ser seguro bajo
//      concurrencia con ventas activas en el mismo instante del cierre.
//
//   4. Blindaje anti-doble-clic en completeAudit: updateMany con predicado
//      status = IN_PROGRESS → patrón idéntico a order.ts/payments.ts.
//
//   5. StockMovement.sourceWarehouseId o destWarehouseId según el signo
//      del ajuste (variance negativa = salida de bodega; positiva = entrada).
//
//   6. InventoryAuditItem es SIN updatedAt (snapshot inmutable).
//      El upsert en recordItem usa update+create explícito, no Prisma upsert,
//      para no depender de updatedAt y para tomar nuevo snapshot de stock.
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import { adminProcedure }         from '../middleware/auth'
import { withOpenDay }            from '../middleware/businessDay'
import { withTenant, withTenantOptions } from '../lib/rls'
import { MovementType, AuditStatus }     from '@prisma/client'
import { Prisma, AuditStatus, MovementType } from '@prisma/client'

// =============================================================================
// SCHEMAS
// =============================================================================

const startAuditInput = z.object({
  warehouseId: z.string().uuid(),
  notes:       z.string().max(500).optional(),
})

const recordItemInput = z.object({
  auditId:       z.string().uuid(),
  productId:     z.string().uuid(),
  physicalStock: z.number().min(0),
  // Cantidad contada físicamente — nunca negativa
  notes:         z.string().max(500).optional(),
})

const completeAuditInput = z.object({
  auditId: z.string().uuid(),
  notes:   z.string().max(500).optional(),
})

const getAuditInput = z.object({
  auditId: z.string().uuid(),
})

const listAuditsInput = z.object({
  warehouseId: z.string().uuid().optional(),
  status:      z.nativeEnum(AuditStatus).optional(),
  limit:       z.number().min(1).max(50).default(20),
})

// =============================================================================
// ROUTER
// =============================================================================

export const auditRouter = router({

  // ──────────────────────────────────────────────────────────────────────────
  // startAudit — Abre una nueva auditoría física para una bodega
  //
  // Guard de unicidad en dos capas (defensa en profundidad):
  //
  //   Capa 1 — aplicación: findFirst dentro de la transacción.
  //     Detecta el conflicto en el caso normal y devuelve un mensaje con el
  //     id de la auditoría activa para que el admin pueda cerrarla primero.
  //
  //   Capa 2 — base de datos: partial unique index
  //     "InventoryAudit_warehouse_in_progress_key" sobre (tenantId, warehouseId)
  //     WHERE status = 'IN_PROGRESS' (ver migration_audit_unique.sql).
  //     Si dos requests concurrentes pasan la capa 1 simultáneamente,
  //     la BD rechaza el segundo INSERT con P2002. El catch lo convierte
  //     en TRPCError CONFLICT limpio — nunca llega un 500 al cliente.
  //
  // No pre-carga InventoryAuditItem — el operador registra solo los
  // productos que físicamente cuenta. Los no registrados se asumen sin
  // discrepancia (o se tratan como no auditados — decisión de negocio).
  // ──────────────────────────────────────────────────────────────────────────
  startAudit: adminProcedure
    .use(withOpenDay)
    .input(startAuditInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId, establishmentId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      let result: Awaited<ReturnType<typeof withTenantOptions<{
        audit: { id: string; status: AuditStatus; startedAt: Date; warehouseId: string; conductedBy: string }
        warehouseName: string
      }>>>

      try {
        result = await withTenantOptions(
          tenantId,
          async (tx) => {
            // Validar que la bodega pertenece al establecimiento del admin
            const warehouse = await tx.warehouse.findFirst({
              where: {
                id:             input.warehouseId,
                tenantId,
                establishmentId,
                isActive:       true,
                deletedAt:      null,
              },
              select: { id: true, name: true },
            })

            if (!warehouse) {
              throw new TRPCError({
                code:    'NOT_FOUND',
                message: 'Bodega no encontrada o no pertenece a este establecimiento',
              })
            }

            // Capa 1 — guard de aplicación: detecta conflicto con mensaje útil
            const existingAudit = await tx.inventoryAudit.findFirst({
              where: {
                tenantId,
                warehouseId: input.warehouseId,
                status:      AuditStatus.IN_PROGRESS,
              },
              select: { id: true },
            })

            if (existingAudit) {
              throw new TRPCError({
                code:    'CONFLICT',
                message: `Ya existe una auditoría en progreso para esta bodega (id: ${existingAudit.id}). Ciérrala antes de iniciar una nueva.`,
              })
            }

            const audit = await tx.inventoryAudit.create({
              data: {
                tenantId,
                establishmentId,
                warehouseId:  input.warehouseId,
                businessDayId,
                status:       AuditStatus.IN_PROGRESS,
                conductedBy:  userId!,
              },
              select: {
                id:          true,
                status:      true,
                startedAt:   true,
                warehouseId: true,
                conductedBy: true,
              },
            })

            return { audit, warehouseName: warehouse.name }
          },
          { timeout: 10_000 },
        )
      } catch (err: unknown) {
        // Capa 2 — guard de BD: el partial unique index rechaza el segundo
        // INSERT concurrente con P2002 antes de que llegue a crear un duplicado.
        // Convertimos el error crudo de Prisma en una respuesta CONFLICT limpia.
        if (
			err instanceof Prisma.PrismaClientKnownRequestError &&
			err.code === 'P2002'
		  ) {
          throw new TRPCError({
            code:    'CONFLICT',
            message: 'Ya existe una auditoría en progreso para esta bodega. Ciérrala antes de iniciar una nueva.',
            cause:   err,
          })
        }
        throw err
      }

      return {
        auditId:       result.audit.id,
        warehouseId:   result.audit.warehouseId,
        warehouseName: result.warehouseName,
        status:        result.audit.status,
        startedAt:     result.audit.startedAt,
        message:       `Auditoría iniciada para bodega "${result.warehouseName}". Registra los conteos físicos con recordItem.`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // recordItem — Registra o actualiza el conteo físico de un producto
  //
  // Comportamiento de upsert manual (sin Prisma upsert):
  //   - Si el ítem no existe → INSERT con theoreticalStock = stock actual
  //   - Si ya existe → UPDATE solo physicalStock, variance y notes
  //     (theoreticalStock NO se actualiza — preservar el snapshot inicial)
  //
  // theoreticalStock se toma del StockLevel EN EL MOMENTO del primer conteo.
  // Durante el arqueo pueden generarse ventas — el expected ya está fijo.
  //
  // La variance se calcula como: physicalStock - theoreticalStock
  //   variance > 0 → sobrante (más físico que sistema)
  //   variance < 0 → faltante (menos físico que sistema)
  //   variance = 0 → cuadra perfectamente
  // ──────────────────────────────────────────────────────────────────────────
  recordItem: adminProcedure
    .input(recordItemInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // 1. Verificar que la auditoría existe, pertenece al tenant y está activa
          const audit = await tx.inventoryAudit.findFirst({
            where: {
              id:      input.auditId,
              tenantId,
              status:  AuditStatus.IN_PROGRESS,
            },
            select: { id: true, warehouseId: true },
          })

          if (!audit) {
            throw new TRPCError({
              code:    'NOT_FOUND',
              message: 'Auditoría no encontrada, no pertenece a este tenant, o ya fue cerrada',
            })
          }

          // 2. Verificar que el producto existe y está activo
          const product = await tx.product.findFirst({
            where: { id: input.productId, tenantId, isActive: true, deletedAt: null },
            select: { id: true, name: true },
          })

          if (!product) {
            throw new TRPCError({
              code:    'NOT_FOUND',
              message: 'Producto no encontrado o inactivo',
            })
          }

          // 3. Buscar si ya existe un ítem para este producto en esta auditoría
          const existingItem = await tx.inventoryAuditItem.findUnique({
            where: {
              auditId_productId: {
                auditId:   input.auditId,
                productId: input.productId,
              },
            },
            select: { id: true, theoreticalStock: true },
          })

          if (existingItem) {
            // UPDATE: preservar theoreticalStock del snapshot original
            // La variance se recalcula contra ese mismo snapshot
            const updatedVariance = parseFloat(
              (input.physicalStock - Number(existingItem.theoreticalStock)).toFixed(3),
            )

            const updated = await tx.inventoryAuditItem.update({
              where: { id: existingItem.id },
              data: {
                physicalStock: input.physicalStock,
                variance:      updatedVariance,
                notes:         input.notes ?? null,
              },
              select: {
                id:               true,
                theoreticalStock: true,
                physicalStock:    true,
                variance:         true,
              },
            })

            return {
              item:        updated,
              productName: product.name,
              isNew:       false,
            }

          } else {
            // INSERT: capturar theoreticalStock = stock actual en este momento
            const stockLevel = await tx.stockLevel.findUnique({
              where: {
                warehouseId_productId: {
                  warehouseId: audit.warehouseId,
                  productId:   input.productId,
                },
              },
              select: { quantity: true },
            })

            const theoreticalStock = Number(stockLevel?.quantity ?? 0)
            const insertVariance   = parseFloat(
              (input.physicalStock - theoreticalStock).toFixed(3),
            )

            const created = await tx.inventoryAuditItem.create({
              data: {
                tenantId,
                auditId:          input.auditId,
                productId:        input.productId,
                theoreticalStock,
                physicalStock:    input.physicalStock,
                variance:         insertVariance,
                notes:            input.notes ?? null,
              },
              select: {
                id:               true,
                theoreticalStock: true,
                physicalStock:    true,
                variance:         true,
              },
            })

            return {
              item:        created,
              productName: product.name,
              isNew:       true,
            }
          }
        },
        { timeout: 10_000 },
      )

      return {
        auditItemId:      result.item.id,
        productName:      result.productName,
        theoreticalStock: Number(result.item.theoreticalStock),
        physicalStock:    Number(result.item.physicalStock),
        variance:         Number(result.item.variance),
        isNew:            result.isNew,
        message:          result.isNew
          ? `Conteo registrado para "${result.productName}". Varianza: ${Number(result.item.variance) >= 0 ? '+' : ''}${Number(result.item.variance)}`
          : `Conteo actualizado para "${result.productName}". Varianza: ${Number(result.item.variance) >= 0 ? '+' : ''}${Number(result.item.variance)}`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // completeAudit — Cierra la auditoría y aplica ajustes de stock atómicamente
  //
  // OPERACIÓN CRÍTICA — todo o nada (withTenantOptions, timeout 30s):
  //
  //   1. Bloqueo anti-doble-clic: updateMany con status = IN_PROGRESS
  //      (patrón idéntico a markServed / requestPayment en order.ts)
  //   2. Por cada InventoryAuditItem con variance ≠ 0:
  //      a) StockMovement(AUDIT_ADJUSTMENT) — append-only con auditId
  //      b) StockLevel increment/decrement con la variance exacta
  //         (increment, no set — seguro bajo concurrencia con ventas activas)
  //   3. Marcar completedAt en el InventoryAudit
  //
  // Por qué increment y no set:
  //   Si entre recordItem y completeAudit se vendió 1 unidad, el stock
  //   real bajó. Un SET al physicalStock sobreescribiría esa venta.
  //   El increment aplica el DELTA (variance) sobre el estado actual,
  //   que es la operación semánticamente correcta para una corrección.
  // ──────────────────────────────────────────────────────────────────────────
  completeAudit: adminProcedure
    .use(withOpenDay)
    .input(completeAuditInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId, establishmentId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // BLINDAJE ANTI-DOBLE-CLIC: updateMany con predicado de estado
          // Si dos requests llegan simultáneamente, solo uno actualiza count=1
          const lockResult = await tx.inventoryAudit.updateMany({
            where: {
              id:      input.auditId,
              tenantId,
              status:  AuditStatus.IN_PROGRESS,
            },
            data: {
              status:      AuditStatus.COMPLETED,
              completedAt: new Date(),
            },
          })

          if (lockResult.count === 0) {
            // La auditoría no existía, no pertenecía al tenant, o ya fue cerrada
            const existing = await tx.inventoryAudit.findFirst({
              where:  { id: input.auditId, tenantId },
              select: { status: true },
            })
            if (!existing) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Auditoría no encontrada' })
            }
            throw new TRPCError({
              code:    'CONFLICT',
              message: `La auditoría ya fue cerrada (estado actual: ${existing.status}). No se puede cerrar dos veces.`,
            })
          }

          // Obtener el registro actualizado con su bodega y establecimiento
          const audit = await tx.inventoryAudit.findUniqueOrThrow({
            where: { id: input.auditId },
            select: {
              id:              true,
              warehouseId:     true,
              establishmentId: true,
              status:          true,
              completedAt:     true,
            },
          })

          // Resolver el deviceId efectivo (igual que inventory.ts y payroll.ts)
          const effectiveDevice = deviceId ?? (
            await tx.device.findFirst({
              where: { tenantId, establishmentId, isActive: true, deletedAt: null },
              select: { id: true },
            }).then(d => d?.id)
          )

          if (!effectiveDevice) {
            throw new TRPCError({
              code:    'PRECONDITION_FAILED',
              message: 'No hay dispositivos activos en este establecimiento',
            })
          }

          // Cargar todos los ítems con varianza ≠ 0 — estos requieren ajuste
          const itemsWithVariance = await tx.inventoryAuditItem.findMany({
            where: {
              tenantId,
              auditId:  input.auditId,
              variance: { not: 0 },
            },
            select: {
              productId:        true,
              theoreticalStock: true,
              physicalStock:    true,
              variance:         true,
            },
          })

          // Aplicar ajustes atómicamente para cada ítem con discrepancia
          const adjustments: Array<{
            productId:  string
            variance:   number
            movementId: string
          }> = []

          for (const item of itemsWithVariance) {
            const variance    = Number(item.variance)
            // variance > 0 → sobrante → entrada a bodega (destWarehouseId)
            // variance < 0 → faltante → salida de bodega (sourceWarehouseId)
            const isEntry     = variance > 0
            const absVariance = Math.abs(variance)

            // a) Registrar StockMovement(AUDIT_ADJUSTMENT) — append-only
            const movement = await tx.stockMovement.create({
              data: {
                tenantId,
                establishmentId: audit.establishmentId,
                type:              MovementType.AUDIT_ADJUSTMENT,
                sourceWarehouseId: isEntry ? null              : audit.warehouseId,
                destWarehouseId:   isEntry ? audit.warehouseId : null,
                productId:         item.productId,
                quantity:          absVariance,
                auditId:           audit.id,
                businessDayId,
                createdBy:         userId!,
                deviceId:          effectiveDevice,
                notes:             input.notes
                  ? `Ajuste de arqueo | ${input.notes}`
                  : `Ajuste de arqueo | Auditoría ${audit.id.slice(0, 8)}`,
              },
              select: { id: true },
            })

            // b) Actualizar StockLevel con el delta exacto (increment, no set)
            //    upsert: si el producto nunca tuvo StockLevel en esta bodega, lo crea
            await tx.stockLevel.upsert({
              where: {
                warehouseId_productId: {
                  warehouseId: audit.warehouseId,
                  productId:   item.productId,
                },
              },
              update: {
                quantity: { increment: variance },
                // variance puede ser positivo o negativo — Prisma acepta ambos en increment
              },
              create: {
                tenantId,
                warehouseId: audit.warehouseId,
                productId:   item.productId,
                quantity:    variance,
                // Si el producto no tenía stock registrado y hay sobrante, lo crea
              },
            })

            adjustments.push({
              productId:  item.productId,
              variance,
              movementId: movement.id,
            })
          }

          return {
            audit,
            adjustmentsApplied: adjustments.length,
            totalItemsAudited:  await tx.inventoryAuditItem.count({
              where: { tenantId, auditId: input.auditId },
            }),
          }
        },
        { timeout: 30_000 },
        // Timeout extendido: N productos × (StockMovement + StockLevel upsert)
        // En bodega grande con 200+ discrepancias puede tardar varios segundos
      )

      return {
        auditId:            result.audit.id,
        status:             result.audit.status,
        completedAt:        result.audit.completedAt,
        totalItemsAudited:  result.totalItemsAudited,
        adjustmentsApplied: result.adjustmentsApplied,
        message:            result.adjustmentsApplied === 0
          ? 'Auditoría cerrada. El inventario físico cuadra perfectamente con el sistema — sin ajustes necesarios.'
          : `Auditoría cerrada. ${result.adjustmentsApplied} producto(s) ajustado(s) para cuadrar el inventario con la realidad física.`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // getAudit — Detalle completo de una auditoría con sus ítems
  // ──────────────────────────────────────────────────────────────────────────
  getAudit: adminProcedure
    .input(getAuditInput)
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const audit = await withTenant(tenantId, (tx) =>
        tx.inventoryAudit.findFirst({
          where:  { id: input.auditId, tenantId },
          select: {
            id:             true,
            warehouseId:    true,
            status:         true,
            startedAt:      true,
            completedAt:    true,
            conductedBy:    true,
            warehouse: { select: { name: true, type: true } },
            conductor: { select: { name: true } },
            items: {
              select: {
                id:               true,
                productId:        true,
                theoreticalStock: true,
                physicalStock:    true,
                variance:         true,
                notes:            true,
                createdAt:        true,
                product: { select: { name: true, unit: true } },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        }),
      )

      if (!audit) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Auditoría no encontrada' })
      }

      return {
        ...audit,
        items: audit.items.map(item => ({
          ...item,
          theoreticalStock: Number(item.theoreticalStock),
          physicalStock:    item.physicalStock != null ? Number(item.physicalStock) : null,
          variance:         item.variance      != null ? Number(item.variance)      : null,
        })),
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // listAudits — Historial de auditorías del establecimiento
  // ──────────────────────────────────────────────────────────────────────────
  listAudits: adminProcedure
    .input(listAuditsInput)
    .query(async ({ input, ctx }) => {
      const { tenantId, establishmentId } = ctx.auth

      const audits = await withTenant(tenantId, (tx) =>
        tx.inventoryAudit.findMany({
          where: {
            tenantId,
            establishmentId,
            ...(input.warehouseId && { warehouseId: input.warehouseId }),
            ...(input.status      && { status:      input.status }),
          },
          select: {
            id:          true,
            warehouseId: true,
            status:      true,
            startedAt:   true,
            completedAt: true,
            conductedBy: true,
            warehouse:   { select: { name: true } },
            conductor:   { select: { name: true } },
            _count:      { select: { items: true } },
          },
          orderBy: { startedAt: 'desc' },
          take:    input.limit,
        }),
      )

      return {
        audits,
        total: audits.length,
      }
    }),
})
