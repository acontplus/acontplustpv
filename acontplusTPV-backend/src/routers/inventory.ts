// =============================================================================
// apps/api/src/routers/inventory.ts
// Movimientos manuales de inventario — Paso 9
//
// Este router cubre los movimientos de stock que NO provienen de ventas
// (esos los maneja order.ts) ni de compras (purchasing.ts):
//
//   adjust   → AUDIT_ADJUSTMENT: corrección manual tras conteo físico
//              o merma registrada (WASTE_ADJUSTMENT para pérdidas reales)
//   transfer → INTERNAL_TRANSFER: mover stock entre bodegas del mismo local
//   returnToSupplier → RETURN_TO_SUPPLIER: devolver mercancía dañada/incorrecta
//
// Corrección al prompt de Gemini:
//   "MANUAL_ADJUSTMENT" no existe en el enum MovementType del schema.
//   Los tipos válidos son: INITIAL_STOCK, PURCHASE_RECEIPT, INTERNAL_TRANSFER,
//   SALE_DEDUCTION, WASTE_ADJUSTMENT, AUDIT_ADJUSTMENT, RETURN_TO_SUPPLIER.
//
// Todos los movimientos son append-only (StockMovement sin updatedAt).
// StockLevel es el único registro mutable — se actualiza atómicamente.
// withOpenDay requerido: los movimientos se atan a la jornada activa.
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import { adminProcedure, anyUserRoleProcedure } from '../middleware/auth'
import { withOpenDay }  from '../middleware/businessDay'
import { withTenant, withTenantOptions } from '../lib/rls'
import { MovementType } from '@prisma/client'

// =============================================================================
// SCHEMAS
// =============================================================================

// Tipos permitidos para ajuste manual (excluye los que tienen su propio flujo)
const manualAdjustmentTypes = z.enum([
  'AUDIT_ADJUSTMENT',  // corrección tras arqueo o conteo físico
  'WASTE_ADJUSTMENT',  // merma, producto vencido, rotura
  'INITIAL_STOCK',     // carga inicial de inventario en una nueva bodega
])

const adjustInput = z.object({
  warehouseId:  z.string().uuid(),
  productId:    z.string().uuid(),
  quantity:     z.number().refine((n) => n !== 0, { message: 'La cantidad no puede ser cero' }),
  // Positivo = entrada, Negativo = salida
  type:         manualAdjustmentTypes,
  unitCost:     z.number().min(0).optional(),
  notes:        z.string().max(500).optional(),
})

const transferInput = z.object({
  sourceWarehouseId: z.string().uuid(),
  destWarehouseId:   z.string().uuid(),
  productId:         z.string().uuid(),
  quantity:          z.number().positive(),
  // Solo cantidades positivas — la dirección la definen source/dest
  notes:             z.string().max(500).optional(),
})

const returnToSupplierInput = z.object({
  warehouseId:     z.string().uuid(),
  productId:       z.string().uuid(),
  quantity:        z.number().positive(),
  purchaseOrderId: z.string().uuid().optional(),
  // El PO original si se conoce
  notes:           z.string().min(5).max(500),
  // Obligatorio — documentar el motivo de la devolución
})

const listMovementsInput = z.object({
  warehouseId: z.string().uuid().optional(),
  productId:   z.string().uuid().optional(),
  type:        z.nativeEnum(MovementType).optional(),
  dateFrom:    z.string().datetime().optional(),
  dateTo:      z.string().datetime().optional(),
  limit:       z.number().min(1).max(200).default(50),
})

// =============================================================================
// HELPER: validar que la bodega pertenece al establecimiento del usuario
// =============================================================================

async function validateWarehouse(
  tx: Parameters<Parameters<typeof withTenantOptions>[1]>[0],
  tenantId: string,
  establishmentId: string,
  warehouseId: string,
) {
  const warehouse = await tx.warehouse.findFirst({
    where: {
      id: warehouseId,
      tenantId,
      establishmentId,
      isActive:  true,
      deletedAt: null,
    },
    select: { id: true, name: true, type: true },
  })

  if (!warehouse) {
    throw new TRPCError({
      code:    'NOT_FOUND',
      message: `Bodega no encontrada o no pertenece a este establecimiento (id: ${warehouseId})`,
    })
  }

  return warehouse
}

// =============================================================================
// ROUTER
// =============================================================================

export const inventoryRouter = router({

  // ──────────────────────────────────────────────────────────────────────────
  // adjust — Ajuste manual de stock
  //
  // Crea un StockMovement y actualiza StockLevel atómicamente.
  // quantity puede ser negativo (salida) o positivo (entrada).
  //
  // Tipos válidos:
  //   AUDIT_ADJUSTMENT → corrección tras conteo físico o arqueo de inventario
  //   WASTE_ADJUSTMENT → merma, vencimiento, rotura
  //   INITIAL_STOCK    → carga inicial en bodega nueva
  // ──────────────────────────────────────────────────────────────────────────
  adjust: adminProcedure
    .use(withOpenDay)
    .input(adjustInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          await validateWarehouse(tx, tenantId, establishmentId, input.warehouseId)

          // Verificar que el producto existe y está activo
          const product = await tx.product.findFirst({
            where:  { id: input.productId, tenantId, isActive: true, deletedAt: null },
            select: { id: true, name: true, currentAverageCost: true },
          })

          if (!product) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Producto no encontrado o inactivo' })
          }

          // Obtener stock actual para validar salidas
          const currentLevel = await tx.stockLevel.findUnique({
            where: {
              warehouseId_productId: {
                warehouseId: input.warehouseId,
                productId:   input.productId,
              },
            },
            select: { quantity: true },
          })

          const currentQty = Number(currentLevel?.quantity ?? 0)

          // Para salidas manuales, el saldo puede quedar negativo en un sistema
          // offline-first, pero emitimos advertencia en la respuesta
          const willBeNegative = input.quantity < 0 && (currentQty + input.quantity) < 0

          // 1. Registrar el movimiento (append-only)
          const movement = await tx.stockMovement.create({
            data: {
              tenantId,
              establishmentId,
              type:     input.type as MovementType,
              // Para salidas (quantity < 0): sourceWarehouse es la bodega afectada
              // Para entradas (quantity > 0): destWarehouse es la bodega afectada
              sourceWarehouseId: input.quantity < 0 ? input.warehouseId : null,
              destWarehouseId:   input.quantity > 0 ? input.warehouseId : null,
              productId:         input.productId,
              quantity:          Math.abs(input.quantity),
              unitCost:          input.unitCost ?? Number(product.currentAverageCost),
              businessDayId,
              createdBy:         userId!,
              deviceId:          deviceId ?? (
                await tx.device.findFirst({
                  where: { tenantId, establishmentId, isActive: true, deletedAt: null },
                  select: { id: true },
                }).then(d => d?.id ?? '')
              ),
              notes: input.notes ?? null,
            },
          })

          // 2. Actualizar StockLevel (upsert — puede no existir aún)
          await tx.stockLevel.upsert({
            where: {
              warehouseId_productId: {
                warehouseId: input.warehouseId,
                productId:   input.productId,
              },
            },
            create: {
              tenantId,
              warehouseId: input.warehouseId,
              productId:   input.productId,
              quantity:    input.quantity,
            },
            update: {
              quantity: { increment: input.quantity },
            },
          })

          const newQty = currentQty + input.quantity

          return { movement, newQty, willBeNegative }
        },
        { timeout: 15_000 },
      )

      return {
        movementId:      result.movement.id,
        type:            input.type,
        quantity:        input.quantity,
        newStockLevel:   parseFloat(result.newQty.toFixed(3)),
        warning:         result.willBeNegative
          ? 'El stock quedó negativo. Verifica el inventario físico.'
          : null,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // transfer — Transferencia entre bodegas del mismo establecimiento
  //
  // Mueve stock de sourceWarehouse a destWarehouse en una sola transacción.
  // Genera UN StockMovement(INTERNAL_TRANSFER) con ambas bodegas referenciadas.
  // Actualiza ambos StockLevel en la misma transacción.
  //
  // Caso de uso típico: pasar producto de MAIN_STORAGE al BAR al inicio
  // de la jornada para que esté disponible en la barra.
  // ──────────────────────────────────────────────────────────────────────────
  transfer: adminProcedure
    .use(withOpenDay)
    .input(transferInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      if (input.sourceWarehouseId === input.destWarehouseId) {
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: 'La bodega origen y destino no pueden ser la misma',
        })
      }

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // Validar ambas bodegas
          const [sourceWarehouse, destWarehouse] = await Promise.all([
            validateWarehouse(tx, tenantId, establishmentId, input.sourceWarehouseId),
            validateWarehouse(tx, tenantId, establishmentId, input.destWarehouseId),
          ])

          const product = await tx.product.findFirst({
            where:  { id: input.productId, tenantId, isActive: true, deletedAt: null },
            select: { id: true, name: true, currentAverageCost: true },
          })

          if (!product) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Producto no encontrado o inactivo' })
          }

          // Verificar stock disponible en origen
          const sourceLevel = await tx.stockLevel.findUnique({
            where: {
              warehouseId_productId: {
                warehouseId: input.sourceWarehouseId,
                productId:   input.productId,
              },
            },
            select: { quantity: true },
          })

          const sourceQty = Number(sourceLevel?.quantity ?? 0)
          if (sourceQty < input.quantity) {
            throw new TRPCError({
              code:    'PRECONDITION_FAILED',
              message: `Stock insuficiente en "${sourceWarehouse.name}". ` +
                       `Disponible: ${sourceQty.toFixed(3)}, solicitado: ${input.quantity}`,
            })
          }

          const effectiveDevice = deviceId ?? (
            await tx.device.findFirst({
              where: { tenantId, establishmentId, isActive: true, deletedAt: null },
              select: { id: true },
            }).then(d => d?.id ?? '')
          )

          // 1. StockMovement (un solo registro para la transferencia completa)
          const movement = await tx.stockMovement.create({
            data: {
              tenantId,
              establishmentId,
              type:              MovementType.INTERNAL_TRANSFER,
              sourceWarehouseId: input.sourceWarehouseId,
              destWarehouseId:   input.destWarehouseId,
              productId:         input.productId,
              quantity:          input.quantity,
              unitCost:          Number(product.currentAverageCost),
              businessDayId,
              createdBy:         userId!,
              deviceId:          effectiveDevice,
              notes:             input.notes ?? null,
            },
          })

          // 2. Decrementar origen
          await tx.stockLevel.update({
            where: {
              warehouseId_productId: {
                warehouseId: input.sourceWarehouseId,
                productId:   input.productId,
              },
            },
            data: { quantity: { decrement: input.quantity } },
          })

          // 3. Incrementar destino (upsert — puede no existir aún)
          await tx.stockLevel.upsert({
            where: {
              warehouseId_productId: {
                warehouseId: input.destWarehouseId,
                productId:   input.productId,
              },
            },
            create: {
              tenantId,
              warehouseId: input.destWarehouseId,
              productId:   input.productId,
              quantity:    input.quantity,
            },
            update: {
              quantity: { increment: input.quantity },
            },
          })

          return {
            movement,
            sourceWarehouse,
            destWarehouse,
            newSourceQty: sourceQty - input.quantity,
          }
        },
        { timeout: 15_000 },
      )

      return {
        movementId:     result.movement.id,
        type:           'INTERNAL_TRANSFER' as const,
        quantity:       input.quantity,
        from:           result.sourceWarehouse.name,
        to:             result.destWarehouse.name,
        newSourceStock: parseFloat(result.newSourceQty.toFixed(3)),
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // returnToSupplier — Devuelve mercancía al proveedor
  //
  // Descuenta stock de la bodega especificada y registra el motivo.
  // Opcionalmente vincula con la PurchaseOrder original.
  // ──────────────────────────────────────────────────────────────────────────
  returnToSupplier: adminProcedure
    .use(withOpenDay)
    .input(returnToSupplierInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          await validateWarehouse(tx, tenantId, establishmentId, input.warehouseId)

          const product = await tx.product.findFirst({
            where:  { id: input.productId, tenantId, isActive: true, deletedAt: null },
            select: { id: true, currentAverageCost: true },
          })

          if (!product) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Producto no encontrado' })
          }

          const currentLevel = await tx.stockLevel.findUnique({
            where: {
              warehouseId_productId: {
                warehouseId: input.warehouseId,
                productId:   input.productId,
              },
            },
            select: { quantity: true },
          })

          if (Number(currentLevel?.quantity ?? 0) < input.quantity) {
            throw new TRPCError({
              code:    'PRECONDITION_FAILED',
              message: `Stock insuficiente para la devolución. Disponible: ${Number(currentLevel?.quantity ?? 0).toFixed(3)}`,
            })
          }

          const effectiveDevice = deviceId ?? (
            await tx.device.findFirst({
              where: { tenantId, establishmentId, isActive: true, deletedAt: null },
              select: { id: true },
            }).then(d => d?.id ?? '')
          )

          const movement = await tx.stockMovement.create({
            data: {
              tenantId,
              establishmentId,
              type:              MovementType.RETURN_TO_SUPPLIER,
              sourceWarehouseId: input.warehouseId,
              productId:         input.productId,
              quantity:          input.quantity,
              unitCost:          Number(product.currentAverageCost),
              purchaseOrderId:   input.purchaseOrderId ?? null,
              businessDayId,
              createdBy:         userId!,
              deviceId:          effectiveDevice,
              notes:             input.notes,
            },
          })

          await tx.stockLevel.update({
            where: {
              warehouseId_productId: {
                warehouseId: input.warehouseId,
                productId:   input.productId,
              },
            },
            data: { quantity: { decrement: input.quantity } },
          })

          return { movement }
        },
        { timeout: 15_000 },
      )

      return {
        movementId: result.movement.id,
        type:       'RETURN_TO_SUPPLIER' as const,
        quantity:   input.quantity,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // listMovements — Historial de movimientos de una bodega o producto
  // ──────────────────────────────────────────────────────────────────────────
  listMovements: anyUserRoleProcedure
    .input(listMovementsInput)
    .query(async ({ input, ctx }) => {
      const { tenantId, establishmentId } = ctx.auth

      const movements = await withTenant(tenantId, (tx) =>
        tx.stockMovement.findMany({
          where: {
            tenantId,
            establishmentId,
            ...(input.warehouseId && {
              OR: [
                { sourceWarehouseId: input.warehouseId },
                { destWarehouseId:   input.warehouseId },
              ],
            }),
            ...(input.productId  && { productId: input.productId }),
            ...(input.type       && { type:      input.type }),
            ...(input.dateFrom || input.dateTo
              ? {
                  createdAt: {
                    ...(input.dateFrom && { gte: new Date(input.dateFrom) }),
                    ...(input.dateTo   && { lte: new Date(input.dateTo)   }),
                  },
                }
              : {}),
          },
          select: {
            id:                true,
            type:              true,
            quantity:          true,
            unitCost:          true,
            notes:             true,
            createdAt:         true,
            product:           { select: { id: true, name: true, unit: true } },
            sourceWarehouse:   { select: { id: true, name: true } },
            destWarehouse:     { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take:    input.limit,
        }),
      )

      return {
        movements: movements.map(m => ({
          ...m,
          quantity: Number(m.quantity),
          unitCost: m.unitCost ? Number(m.unitCost) : null,
        })),
        total: movements.length,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // stockSnapshot — Stock actual de una bodega
  // ──────────────────────────────────────────────────────────────────────────
  stockSnapshot: anyUserRoleProcedure
    .input(z.object({
      warehouseId:      z.string().uuid(),
      onlyBelowReorder: z.boolean().default(false),
    }))
    .query(async ({ input, ctx }) => {
      const { tenantId, establishmentId } = ctx.auth

      await withTenant(tenantId, tx =>
        validateWarehouse(tx, tenantId, establishmentId, input.warehouseId),
      )

      const levels = await withTenant(tenantId, (tx) =>
        tx.stockLevel.findMany({
          where: {
            tenantId,
            warehouseId: input.warehouseId,
            ...(input.onlyBelowReorder && {
              quantity: { lt: tx.stockLevel.fields.quantity },
              // Nota: Prisma no soporta comparación entre campos directamente.
              // Usamos post-filter abajo.
            }),
          },
          include: {
            product: {
              select: {
                id:           true,
                name:         true,
                unit:         true,
                reorderPoint: true,
                salePrice:    true,
                currentAverageCost: true,
                isActive:     true,
              },
            },
          },
          orderBy: { product: { name: 'asc' } },
        }),
      )

      const enriched = levels
        .map(l => ({
          productId:    l.productId,
          productName:  l.product.name,
          unit:         l.product.unit,
          quantity:     Number(l.quantity),
          reorderPoint: Number(l.product.reorderPoint),
          belowReorder: Number(l.quantity) < Number(l.product.reorderPoint),
          salePrice:    Number(l.product.salePrice),
          avgCost:      Number(l.product.currentAverageCost),
          isActive:     l.product.isActive,
        }))
        .filter(l => !input.onlyBelowReorder || l.belowReorder)

      return { levels: enriched, total: enriched.length }
    }),
})
