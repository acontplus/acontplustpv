// =============================================================================
// apps/api/src/routers/purchasing.ts
// Órdenes de Compra a Proveedores — Paso 9
//
// Flujo de una orden de compra (Instrucciones §6):
//   PENDING → PARTIAL → RECEIVED | CANCELLED
//
// receiveOrder es el procedimiento más importante:
//   Cuando llega la mercancía, por cada item recibido:
//   1. Actualiza PurchaseOrderItem.quantityReceived
//   2. StockMovement(PURCHASE_RECEIPT) en la bodega destino
//   3. StockLevel.quantity += cantidadRecibida (upsert)
//   4. Product.currentAverageCost = costo promedio ponderado:
//
//        nuevo_costo = (stock_actual × costo_actual + cantidad_nueva × costo_unitario)
//                     / (stock_actual + cantidad_nueva)
//
//      Si se usa el precio de la orden actual sin ponderar, el historial
//      de costos se pierde y los márgenes de pedidos anteriores quedan
//      incorrectos.
//
//   5. Si todos los items llegaron completos → status RECEIVED
//      Si llegó solo parte → status PARTIAL (puede recibirse de nuevo)
//      Si ya estaba RECEIVED → error (no se puede recibir dos veces)
//
// withOpenDay requerido en receiveOrder:
//   Los StockMovement se atan al businessDayId de la jornada activa.
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

const createOrderInput = z.object({
  establishmentId: z.string().uuid(),
  supplierId:      z.string().uuid(),
  warehouseId:     z.string().uuid(),
  // Bodega destino donde se recibirá la mercancía
  notes:           z.string().max(500).optional(),
  items: z.array(z.object({
    productId:      z.string().uuid(),
    quantityOrdered: z.number().positive(),
    unitCost:       z.number().positive(),
  })).min(1).max(100),
})

const updateOrderInput = z.object({
  id:      z.string().uuid(),
  notes:   z.string().max(500).optional(),
  items:   z.array(z.object({
    productId:      z.string().uuid(),
    quantityOrdered: z.number().positive(),
    unitCost:       z.number().positive(),
  })).min(1).optional(),
})

const receiveOrderInput = z.object({
  purchaseOrderId: z.string().uuid(),
  items: z.array(z.object({
    purchaseOrderItemId: z.string().uuid(),
    quantityReceived:    z.number().positive(),
    // La cantidad que físicamente llegó (puede ser menor a la ordenada)
    unitCost:           z.number().positive().optional(),
    // Si el proveedor ajusta el precio al entregar
  })).min(1),
  notes: z.string().max(500).optional(),
})

const cancelOrderInput = z.object({
  id:    z.string().uuid(),
  notes: z.string().max(500).optional(),
})

const listOrdersInput = z.object({
  establishmentId: z.string().uuid().optional(),
  status:          z.enum(['PENDING', 'PARTIAL', 'RECEIVED', 'CANCELLED']).optional(),
  supplierId:      z.string().uuid().optional(),
  limit:           z.number().min(1).max(100).default(30),
})

// =============================================================================
// ROUTER
// =============================================================================

export const purchasingRouter = router({

  // ──────────────────────────────────────────────────────────────────────────
  // list — Lista órdenes de compra con filtros
  // ──────────────────────────────────────────────────────────────────────────
  list: anyUserRoleProcedure
    .input(listOrdersInput)
    .query(async ({ input, ctx }) => {
      const { tenantId, establishmentId: ctxEstId } = ctx.auth

      const orders = await withTenant(tenantId, (tx) =>
        tx.purchaseOrder.findMany({
          where: {
            tenantId,
            establishmentId: input.establishmentId ?? ctxEstId,
            ...(input.status     && { status:     input.status }),
            ...(input.supplierId && { supplierId: input.supplierId }),
          },
          select: {
            id:              true,
            status:          true,
            orderDate:       true,
            receivedAt:      true,
            totalAmount:     true,
            notes:           true,
            supplier:        { select: { id: true, name: true } },
            warehouse:       { select: { id: true, name: true } },
            _count:          { select: { items: true } },
          },
          orderBy: { orderDate: 'desc' },
          take:    input.limit,
        }),
      )

      return {
        orders: orders.map(o => ({
          ...o,
          totalAmount: o.totalAmount ? Number(o.totalAmount) : null,
          itemCount:   o._count.items,
        })),
        total: orders.length,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // getById — Detalle completo de una orden
  // ──────────────────────────────────────────────────────────────────────────
  getById: anyUserRoleProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const order = await withTenant(tenantId, (tx) =>
        tx.purchaseOrder.findFirst({
          where: { id: input.id, tenantId },
          include: {
            supplier:  { select: { id: true, name: true, phone: true } },
            warehouse: { select: { id: true, name: true, type: true } },
            items: {
              include: {
                product: {
                  select: { id: true, name: true, unit: true, currentAverageCost: true },
                },
              },
            },
          },
        }),
      )

      if (!order) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Orden de compra no encontrada' })
      }

      return {
        order: {
          ...order,
          totalAmount: order.totalAmount ? Number(order.totalAmount) : null,
          items: order.items.map(i => ({
            ...i,
            quantityOrdered:  Number(i.quantityOrdered),
            quantityReceived: Number(i.quantityReceived),
            unitCost:         Number(i.unitCost),
          })),
        },
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // create — Crea una nueva orden de compra
  // ──────────────────────────────────────────────────────────────────────────
  create: adminProcedure
    .input(createOrderInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId } = ctx.auth

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // Verificar establecimiento
          const establishment = await tx.establishment.findFirst({
            where: { id: input.establishmentId, tenantId, isActive: true, deletedAt: null },
            select: { id: true },
          })
          if (!establishment) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Establecimiento no encontrado' })
          }

          // Verificar proveedor
          const supplier = await tx.supplier.findFirst({
            where: { id: input.supplierId, tenantId, isActive: true, deletedAt: null },
            select: { id: true, name: true },
          })
          if (!supplier) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Proveedor no encontrado o inactivo' })
          }

          // Verificar bodega destino
          const warehouse = await tx.warehouse.findFirst({
            where: {
              id:              input.warehouseId,
              tenantId,
              establishmentId: input.establishmentId,
              isActive:        true,
              deletedAt:       null,
            },
            select: { id: true },
          })
          if (!warehouse) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Bodega no encontrada en este establecimiento' })
          }

          // Verificar que todos los productos existen
          const productIds = input.items.map(i => i.productId)
          const products   = await tx.product.findMany({
            where:  { id: { in: productIds }, tenantId, isActive: true, deletedAt: null },
            select: { id: true },
          })
          if (products.length !== productIds.length) {
            throw new TRPCError({
              code:    'NOT_FOUND',
              message: 'Uno o más productos no existen o están inactivos',
            })
          }

          const totalAmount = input.items.reduce((s, i) => s + i.quantityOrdered * i.unitCost, 0)

          const order = await tx.purchaseOrder.create({
            data: {
              tenantId,
              establishmentId: input.establishmentId,
              supplierId:      input.supplierId,
              warehouseId:     input.warehouseId,
              status:          'PENDING',
              orderDate:       new Date(),
              totalAmount:     parseFloat(totalAmount.toFixed(2)),
              createdBy:       userId!,
              notes:           input.notes ?? null,
              items: {
                create: input.items.map(item => ({
                  tenantId,
                  productId:        item.productId,
                  quantityOrdered:  item.quantityOrdered,
                  quantityReceived: 0,
                  unitCost:         item.unitCost,
                })),
              },
            },
            include: { items: true },
          })

          return { order }
        },
        { timeout: 15_000 },
      )

      return { orderId: result.order.id, status: result.order.status }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // update — Edita una orden PENDING (antes de recibir mercancía)
  // ──────────────────────────────────────────────────────────────────────────
  update: adminProcedure
    .input(updateOrderInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const order = await withTenant(tenantId, (tx) =>
        tx.purchaseOrder.findFirst({
          where:  { id: input.id, tenantId },
          select: { id: true, status: true },
        }),
      )

      if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Orden no encontrada' })
      if (order.status !== 'PENDING') {
        throw new TRPCError({
          code:    'CONFLICT',
          message: `Solo se pueden editar órdenes en estado PENDING. Estado actual: ${order.status}`,
        })
      }

      await withTenantOptions(tenantId, async (tx) => {
        if (input.notes !== undefined) {
          await tx.purchaseOrder.update({
            where: { id: input.id },
            data:  { notes: input.notes },
          })
        }

        if (input.items) {
          const productIds = input.items.map(i => i.productId)
          const products   = await tx.product.findMany({
            where:  { id: { in: productIds }, tenantId, isActive: true, deletedAt: null },
            select: { id: true },
          })
          if (products.length !== productIds.length) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Uno o más productos no existen' })
          }

          await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: input.id } })

          const totalAmount = input.items.reduce((s, i) => s + i.quantityOrdered * i.unitCost, 0)

          await tx.purchaseOrder.update({
            where: { id: input.id },
            data: {
              totalAmount: parseFloat(totalAmount.toFixed(2)),
              items: {
                create: input.items.map(item => ({
                  tenantId,
                  productId:        item.productId,
                  quantityOrdered:  item.quantityOrdered,
                  quantityReceived: 0,
                  unitCost:         item.unitCost,
                })),
              },
            },
          })
        }
      }, { timeout: 15_000 })

      return { success: true }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // receiveOrder — Registra la llegada de mercancía
  //
  // El procedimiento más importante del módulo de compras.
  // Por cada item recibido, en una sola transacción atómica:
  //
  //   1. Actualiza PurchaseOrderItem.quantityReceived
  //   2. Crea StockMovement(PURCHASE_RECEIPT) → append-only
  //   3. Upsert StockLevel.quantity += cantidadRecibida
  //   4. Actualiza Product.currentAverageCost con fórmula ponderada:
  //
  //      Si stock_actual + cantidad_nueva = 0:
  //        nuevo_costo = costo_unitario (evitar división por cero)
  //      Si no:
  //        nuevo_costo = (stock_actual × costo_actual + cant_nueva × costo_unitario)
  //                     / (stock_actual + cant_nueva)
  //
  //   5. Determina si la orden quedó PARTIAL o RECEIVED comparando
  //      quantityOrdered vs quantityReceived en TODOS los items de la orden
  // ──────────────────────────────────────────────────────────────────────────
  receiveOrder: adminProcedure
    .use(withOpenDay)
    .input(receiveOrderInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // Obtener la orden completa
          const order = await tx.purchaseOrder.findFirst({
            where: { id: input.purchaseOrderId, tenantId },
            include: {
              items: {
                include: {
                  product: {
                    select: {
                      id:                 true,
                      currentAverageCost: true,
                    },
                  },
                },
              },
            },
          })

          if (!order) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Orden de compra no encontrada' })
          }

          if (order.status === 'RECEIVED') {
            throw new TRPCError({
              code:    'CONFLICT',
              message: 'Esta orden ya fue recibida completamente',
            })
          }

          if (order.status === 'CANCELLED') {
            throw new TRPCError({
              code:    'CONFLICT',
              message: 'No se puede recibir mercancía de una orden cancelada',
            })
          }

          // Validar que los items del input pertenecen a esta orden
          const orderItemIds = new Set(order.items.map(i => i.id))
          for (const inputItem of input.items) {
            if (!orderItemIds.has(inputItem.purchaseOrderItemId)) {
              throw new TRPCError({
                code:    'BAD_REQUEST',
                message: `El item ${inputItem.purchaseOrderItemId} no pertenece a esta orden`,
              })
            }
          }

          const effectiveDevice = deviceId ?? (
            await tx.device.findFirst({
              where: { tenantId, establishmentId, isActive: true, deletedAt: null },
              select: { id: true },
            }).then(d => d?.id ?? '')
          )

          const movements: string[] = []

          // Procesar cada item recibido
          for (const inputItem of input.items) {
            const orderItem = order.items.find(i => i.id === inputItem.purchaseOrderItemId)!
            const effectiveCost = inputItem.unitCost ?? Number(orderItem.unitCost)
            const alreadyReceived = Number(orderItem.quantityReceived)
            const remaining = Number(orderItem.quantityOrdered) - alreadyReceived

            if (inputItem.quantityReceived > remaining + 0.001) {
              throw new TRPCError({
                code:    'BAD_REQUEST',
                message: `El item ${orderItem.productId} tiene pendiente ${remaining.toFixed(3)} unidades. ` +
                         `No se pueden recibir ${inputItem.quantityReceived}.`,
              })
            }

            // 1. Actualizar quantityReceived en el item
            await tx.purchaseOrderItem.update({
              where: { id: inputItem.purchaseOrderItemId },
              data: {
                quantityReceived: { increment: inputItem.quantityReceived },
                // Si el proveedor ajustó el precio, actualizar
                ...(inputItem.unitCost && { unitCost: inputItem.unitCost }),
              },
            })

            // 2. StockMovement(PURCHASE_RECEIPT) — append-only
            const movement = await tx.stockMovement.create({
              data: {
                tenantId,
                establishmentId,
                type:             MovementType.PURCHASE_RECEIPT,
                destWarehouseId:  order.warehouseId,
                productId:        orderItem.productId,
                quantity:         inputItem.quantityReceived,
                unitCost:         effectiveCost,
                purchaseOrderId:  order.id,
                businessDayId,
                createdBy:        userId!,
                deviceId:         effectiveDevice,
                notes:            input.notes ?? null,
              },
            })
            movements.push(movement.id)

            // 3. StockLevel: incrementar stock en la bodega destino
            const stockLevel = await tx.stockLevel.upsert({
              where: {
                warehouseId_productId: {
                  warehouseId: order.warehouseId,
                  productId:   orderItem.productId,
                },
              },
              create: {
                tenantId,
                warehouseId: order.warehouseId,
                productId:   orderItem.productId,
                quantity:    inputItem.quantityReceived,
              },
              update: {
                quantity: { increment: inputItem.quantityReceived },
              },
            })

            // 4. Recalcular currentAverageCost con fórmula ponderada
            //    (Instrucciones §6: "costo promedio ponderado")
            //    stock_antes = stockLevel ANTES del increment (necesitamos leerlo)
            const stockBefore = Number(stockLevel.quantity) - inputItem.quantityReceived
            const costBefore  = Number(orderItem.product.currentAverageCost)
            const newQty      = Number(stockLevel.quantity)

            let newAvgCost: number
            if (newQty <= 0) {
              // Evitar división por cero si el stock quedó negativo por algún ajuste previo
              newAvgCost = effectiveCost
            } else {
              newAvgCost = (stockBefore * costBefore + inputItem.quantityReceived * effectiveCost)
                          / newQty
            }

            await tx.product.update({
              where: { id: orderItem.productId },
              data:  { currentAverageCost: parseFloat(newAvgCost.toFixed(4)) },
            })
          }

          // 5. Determinar el nuevo status de la orden
          //    Re-leer todos los items actualizados para comparar
          const updatedItems = await tx.purchaseOrderItem.findMany({
            where:  { purchaseOrderId: order.id },
            select: { quantityOrdered: true, quantityReceived: true },
          })

          const allReceived = updatedItems.every(
            i => Number(i.quantityReceived) >= Number(i.quantityOrdered) - 0.001,
          )
          const newStatus = allReceived ? 'RECEIVED' : 'PARTIAL'

          await tx.purchaseOrder.update({
            where: { id: order.id },
            data: {
              status:     newStatus,
              receivedAt: allReceived ? new Date() : undefined,
              receivedBy: allReceived ? userId!    : undefined,
            },
          })

          return { orderStatus: newStatus, movementIds: movements }
        },
        { timeout: 30_000 },
      )

      return {
        purchaseOrderId: input.purchaseOrderId,
        newStatus:       result.orderStatus,
        movementsCreated: result.movementIds.length,
        message:         result.orderStatus === 'RECEIVED'
          ? 'Mercancía recibida completamente. Inventario y costos actualizados.'
          : 'Recepción parcial registrada. Puedes recibir el resto cuando llegue.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // cancel — Cancela una orden PENDING
  // ──────────────────────────────────────────────────────────────────────────
  cancel: adminProcedure
    .input(cancelOrderInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const order = await withTenant(tenantId, (tx) =>
        tx.purchaseOrder.findFirst({
          where:  { id: input.id, tenantId },
          select: { id: true, status: true },
        }),
      )

      if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Orden no encontrada' })

      if (!['PENDING', 'PARTIAL'].includes(order.status)) {
        throw new TRPCError({
          code:    'CONFLICT',
          message: `No se puede cancelar una orden en estado "${order.status}"`,
        })
      }

      await withTenant(tenantId, (tx) =>
        tx.purchaseOrder.update({
          where: { id: input.id },
          data: {
            status: 'CANCELLED',
            notes:  input.notes ?? null,
          },
        }),
      )

      return { success: true }
    }),
})
