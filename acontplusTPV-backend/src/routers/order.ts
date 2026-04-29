// =============================================================================
// apps/api/src/routers/order.ts
// Flujo completo de pedidos — Offline-First con PowerSync
//
// Flujo de estados (Instrucciones §3):
//   DRAFT → CONFIRMED → SERVED? → AWAITING_PAYMENT → PAID_* | CANCELLED
//   KIOSK_PENDING → AWAITING_PAYMENT_AT_CASHIER → PAID_* | CANCELLED
//   CONFIRMED → CREDIT_REQUESTED → PAID_CREDIT
//
// Decisiones arquitectónicas clave:
//
//   1. UPSERT por localSequence:
//      PowerSync puede enviar el mismo pedido más de una vez si hay
//      reconexiones. El endpoint syncOrder hace UPSERT usando localSequence
//      como clave idempotente — nunca crea duplicados.
//
//   2. assign_order_number dentro de la transacción:
//      La función SQL se llama con tx.$queryRaw (no prisma.$queryRaw)
//      para que el incremento del secuencial sea atómico con el cambio
//      de estado y el descuento de stock. Si la transacción falla, el
//      secuencial NO se incrementa — sin huecos en la numeración.
//
//   3. Descuento de stock al CONFIRMAR:
//      Al pasar de DRAFT → CONFIRMED se generan StockMovement(SALE_DEDUCTION)
//      por cada OrderItem, descontando de la bodega isDefault del
//      establecimiento. Si no hay bodega default, el pedido se confirma
//      pero sin movimiento de stock (y se registra la advertencia).
//
//   4. withOpenDay obligatorio en todas las mutaciones:
//      Garantiza que la jornada esté abierta. ctx.businessDay viene
//      inyectado por el middleware sin re-consultar la BD.
// =============================================================================

import { z }                from 'zod'
import { TRPCError }        from '@trpc/server'
import { router }           from '../trpc'
import {
  anyUserRoleProcedure,
  cashierProcedure,
  barProcedure,
}                           from '../middleware/auth'
import { withOpenDay }      from '../middleware/businessDay'
import { withTenant, withTenantOptions } from '../lib/rls'
import {
  OrderStatus,
  PrintStatus,
  CancellationReason,
  MovementType,
  ServiceModel,
}                           from '@prisma/client'

// =============================================================================
// SCHEMAS
// =============================================================================

// Items del pedido — misma forma tanto en DRAFT como en CONFIRMED
const orderItemSchema = z.object({
  productId: z.string().uuid(),
  quantity:  z.number().positive(),
  notes:     z.string().max(200).optional(),
})

// syncOrder: el dispositivo envía su pedido offline para crear/actualizar
const syncOrderInput = z.object({
  localSequence:    z.string().min(1).max(100),
  // UUID corto generado en el dispositivo. Clave idempotente del upsert.
  pointOfSaleId:    z.string().uuid(),
  tableId:          z.string().uuid().optional(),
  tableAlias:       z.string().max(100).optional(),
  kioskTurnNumber:  z.string().max(20).optional(),
  items:            z.array(orderItemSchema).min(1).max(50),
  notes:            z.string().max(500).optional(),
  // Para kiosco: el device crea el pedido, no el usuario
  createdByDeviceId: z.string().uuid().optional(),
})

const confirmOrderInput = z.object({
  localSequence: z.string().min(1),
  // El dispositivo confirma por localSequence, no por id de servidor
})

const cancelOrderInput = z.object({
  localSequence:     z.string().min(1),
  cancellationReason: z.nativeEnum(CancellationReason),
  cancellationNotes:  z.string().max(500).optional(),
})

const markServedInput = z.object({
  localSequence: z.string().min(1),
})

const requestPaymentInput = z.object({
  localSequence: z.string().min(1),
})

const listOrdersInput = z.object({
  status: z.array(z.nativeEnum(OrderStatus)).optional(),
  limit:  z.number().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
  // Cursor-based pagination por id para listas largas
})

// =============================================================================
// HELPERS INTERNOS
// =============================================================================

/**
 * Calcula los totales del pedido a partir de los items y los precios
 * actuales de la BD. Los unitPrice/unitCost son snapshots — se toman
 * al confirmar, no al crear el DRAFT.
 */
async function resolveItemPrices(
  tx: Parameters<Parameters<typeof withTenantOptions>[1]>[0],
  tenantId: string,
  items: z.infer<typeof orderItemSchema>[],
): Promise<{
  enriched: Array<{
    productId:  string
    quantity:   number
    unitPrice:  number
    unitCost:   number
    subtotal:   number
    notes:      string | null
  }>
  subtotal:   number
  totalAmount: number
}> {
  const productIds = [...new Set(items.map(i => i.productId))]

  const products = await tx.product.findMany({
    where: {
      id:        { in: productIds },
      tenantId,
      isActive:  true,
      deletedAt: null,
    },
    select: {
      id:                 true,
      name:               true,
      salePrice:          true,
      currentAverageCost: true,
    },
  })

  const productMap = new Map(products.map(p => [p.id, p]))

  // Verify all products exist
  for (const item of items) {
    if (!productMap.has(item.productId)) {
      throw new TRPCError({
        code:    'NOT_FOUND',
        message: `Producto ${item.productId} no encontrado o inactivo`,
      })
    }
  }

  const enriched = items.map(item => {
    const product  = productMap.get(item.productId)!
    const unitPrice = Number(product.salePrice)
    const unitCost  = Number(product.currentAverageCost)
    const subtotal  = parseFloat((unitPrice * item.quantity).toFixed(2))
    return {
      productId:  item.productId,
      quantity:   item.quantity,
      unitPrice,
      unitCost,
      subtotal,
      notes:      item.notes ?? null,
    }
  })

  const subtotal    = parseFloat(enriched.reduce((s, i) => s + i.subtotal, 0).toFixed(2))
  const totalAmount = subtotal // sin impuesto por ahora — extensible con taxRate en Product

  return { enriched, subtotal, totalAmount }
}

/**
 * Descuenta stock de la bodega default del establecimiento.
 * Genera un StockMovement(SALE_DEDUCTION) por cada item.
 * Retorna una advertencia si no hay bodega default configurada.
 */
async function deductStock(
  tx: Parameters<Parameters<typeof withTenantOptions>[1]>[0],
  params: {
    tenantId:        string
    establishmentId: string
    businessDayId:   string
    orderId:         string
    items:           Array<{ productId: string; quantity: number; unitCost: number }>
    userId:          string
    deviceId:        string
  },
): Promise<{ stockDeducted: boolean; warehouseId: string | null }> {
  // Buscar la bodega default del establecimiento
  const defaultWarehouse = await tx.warehouse.findFirst({
    where: {
      tenantId:        params.tenantId,
      establishmentId: params.establishmentId,
      isDefault:       true,
      isActive:        true,
      deletedAt:       null,
    },
    select: { id: true },
  })

  if (!defaultWarehouse) {
    // Sin bodega default: el pedido se confirma pero no hay descuento de stock.
    // El admin debe configurar una bodega default para este establecimiento.
    return { stockDeducted: false, warehouseId: null }
  }

  const warehouseId = defaultWarehouse.id

  // Crear un StockMovement por cada item y actualizar StockLevel
  for (const item of params.items) {
    // Decrementar el saldo en StockLevel (upsert: si no existe, lo crea en 0 - qty)
    await tx.stockLevel.upsert({
      where: {
        warehouseId_productId: {
          warehouseId,
          productId: item.productId,
        },
      },
      create: {
        tenantId:    params.tenantId,
        warehouseId,
        productId:   item.productId,
        quantity:    -item.quantity,
        // Negativo es válido — puede ocurrir offline y corregirse después
      },
      update: {
        quantity: {
          decrement: item.quantity,
        },
      },
    })

    // Registro inmutable del movimiento
    await tx.stockMovement.create({
      data: {
        tenantId:          params.tenantId,
        establishmentId:   params.establishmentId,
        type:              MovementType.SALE_DEDUCTION,
        sourceWarehouseId: warehouseId,
        productId:         item.productId,
        quantity:          item.quantity,
        unitCost:          item.unitCost,
        orderId:           params.orderId,
        businessDayId:     params.businessDayId,
        createdBy:         params.userId,
        deviceId:          params.deviceId,
      },
    })
  }

  return { stockDeducted: true, warehouseId }
}

// =============================================================================
// HELPER: Validación de serviceModel
//
// Aplica reglas COUNTER / DINE_IN al confirmar un pedido.
// syncOrder se mantiene sin cambios para permitir DRAFT offline.
//
// Reglas:
//   DINE_IN -> exige tableId o tableAlias real (trimmed, no vacio)
//   COUNTER -> prohíbe mesa y genera turno atomico T-N con sequence por
//              establecimiento + jornada. CREATE SEQUENCE queda como fallback
//              de transicion hasta moverlo a businessDay.open en PR3.
// =============================================================================
async function validateServiceModel(
  tx: Parameters<Parameters<typeof withTenantOptions>[1]>[0],
  params: {
    tenantId:        string
    establishmentId: string
    businessDayId:   string
    orderId:         string
    tableId:         string | null
    tableAlias:      string | null
  },
): Promise<{ kioskTurnNumber: string | null }> {
  const normalizedAlias = params.tableAlias?.trim() || null

  const establishment = await tx.establishment.findFirst({
    where: {
      id:        params.establishmentId,
      tenantId:  params.tenantId,
      isActive:  true,
      deletedAt: null,
    },
    select: { serviceModel: true },
  })

  if (!establishment) {
    throw new TRPCError({
      code:    'NOT_FOUND',
      message: 'Establecimiento no encontrado o inactivo',
    })
  }

  if (establishment.serviceModel === ServiceModel.DINE_IN) {
    if (!params.tableId && !normalizedAlias) {
      throw new TRPCError({
        code:    'BAD_REQUEST',
        message: 'Este establecimiento requiere asignar una mesa antes de confirmar el pedido.',
      })
    }
    return { kioskTurnNumber: null }
  }

  if (establishment.serviceModel === ServiceModel.COUNTER) {
    if (params.tableId || normalizedAlias) {
      throw new TRPCError({
        code:    'BAD_REQUEST',
        message: 'Este establecimiento opera en modo barra (Counter) y no admite asignacion de mesa.',
      })
    }

    const estSafe = params.establishmentId.replace(/-/g, '')
    const daySafe = params.businessDayId.replace(/-/g, '')
    const seqName = `turno_${estSafe}_${daySafe}`

    await tx.$executeRawUnsafe(
      `CREATE SEQUENCE IF NOT EXISTS "${seqName}" START 1 INCREMENT 1`
    )

    const [turnRow] = await tx.$queryRawUnsafe<Array<{ nextval: bigint }>>(
      `SELECT nextval('"${seqName}"')`
    )

    const turnNumber = Number(turnRow!.nextval)
    return { kioskTurnNumber: `T-${turnNumber}` }
  }

  throw new TRPCError({
    code:    'INTERNAL_SERVER_ERROR',
    message: `serviceModel desconocido: ${establishment.serviceModel}`,
  })
}

// =============================================================================
// ROUTER
// =============================================================================

export const orderRouter = router({

  // ────────────────────────────────────────────────────────────────────────────
  // syncOrder — Crea o actualiza un pedido usando localSequence como clave
  //
  // PowerSync llama a este endpoint cuando el dispositivo sincroniza.
  // Es idempotente: si el pedido ya existe con ese localSequence, lo actualiza
  // SOLO si sigue en estado DRAFT (un pedido CONFIRMED no se sobreescribe).
  //
  // Estado resultante: DRAFT (el barman NO recibe nada todavía)
  // ────────────────────────────────────────────────────────────────────────────
  syncOrder: anyUserRoleProcedure
    .use(withOpenDay)
    .input(syncOrderInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      // Verificar que el POS pertenece al establecimiento del usuario
      const pos = await withTenant(tenantId, (tx) =>
        tx.pointOfSale.findFirst({
          where: {
            id:              input.pointOfSaleId,
            tenantId,
            establishmentId,
            isActive:        true,
            deletedAt:       null,
          },
          select: { id: true },
        }),
      )

      if (!pos) {
        throw new TRPCError({
          code:    'NOT_FOUND',
          message: 'Punto de venta no encontrado o no pertenece a este establecimiento',
        })
      }

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // ── Buscar si ya existe por localSequence ──────────────────────────
          const existing = await tx.order.findFirst({
            where:   { tenantId, localSequence: input.localSequence },
            include: { items: { select: { id: true } } },
          })

          // Si ya está confirmado o más avanzado, no sobreescribir
          const lockedStatuses: OrderStatus[] = [
            'CONFIRMED', 'SERVED', 'AWAITING_PAYMENT',
            'AWAITING_PAYMENT_AT_CASHIER', 'CREDIT_REQUESTED',
            'PAID_CASH', 'PAID_TRANSFER_PENDING',
            'PAID_TRANSFER_CONFIRMED', 'PAID_CREDIT',
          ]

          if (existing && lockedStatuses.includes(existing.status)) {
            return { order: existing, action: 'skipped' as const }
          }

          // ── Calcular totales en DRAFT sin snapshots de precio todavía ─────
          // Los precios se capturan al CONFIRMAR, no al crear el DRAFT
          const productIds = [...new Set(input.items.map(i => i.productId))]
          const products = await tx.product.findMany({
            where: {
              id:        { in: productIds },
              tenantId,
              isActive:  true,
              deletedAt: null,
            },
            select: { id: true, salePrice: true },
          })

          if (products.length !== productIds.length) {
            throw new TRPCError({
              code:    'NOT_FOUND',
              message: 'Uno o más productos no existen o están inactivos',
            })
          }

          const priceMap = new Map(products.map(p => [p.id, Number(p.salePrice)]))
          const subtotal = parseFloat(
            input.items.reduce((s, i) => s + priceMap.get(i.productId)! * i.quantity, 0).toFixed(2),
          )

          // ── Determinar autoría ─────────────────────────────────────────────
          // Si es un kiosco y viene createdByDeviceId, usar eso.
          // De lo contrario usar el userId del token.
          const authorUserId   = input.createdByDeviceId ? undefined : userId
          const authorDeviceId = input.createdByDeviceId ?? deviceId

          if (!authorUserId && !authorDeviceId) {
            throw new TRPCError({
              code:    'BAD_REQUEST',
              message: 'El pedido debe tener autor (userId o deviceId)',
            })
          }

          if (existing) {
            // ── UPDATE: pedido existe en DRAFT, sincronizar cambios ──────────
            // Borrar items anteriores y reemplazar (offline puede cambiar el pedido)
            await tx.orderItem.deleteMany({ where: { orderId: existing.id } })

            const updated = await tx.order.update({
              where: { id: existing.id },
              data: {
                tableId:        input.tableId          ?? null,
                tableAlias:     input.tableAlias       ?? null,
                kioskTurnNumber: input.kioskTurnNumber ?? null,
                subtotal,
                totalAmount: subtotal,
                notes:       input.notes ?? null,
                items: {
                  create: input.items.map(item => ({
                    tenantId,
                    productId: item.productId,
                    quantity:  item.quantity,
                    unitPrice: priceMap.get(item.productId)!,
                    // unitCost es null en DRAFT — se llena al confirmar
                    unitCost:  null,
                    subtotal:  parseFloat((priceMap.get(item.productId)! * item.quantity).toFixed(2)),
                    notes:     item.notes ?? null,
                  })),
                },
              },
              include: { items: true },
            })

            return { order: updated, action: 'updated' as const }
          } else {
            // ── CREATE: primer sync de este pedido ───────────────────────────
            const created = await tx.order.create({
              data: {
                tenantId,
                establishmentId,
                pointOfSaleId:    input.pointOfSaleId,
                businessDayId,
                localSequence:    input.localSequence,
                orderNumber:      null, // se asigna al CONFIRMAR
                createdByUserId:  authorUserId   ?? null,
                createdByDeviceId: authorDeviceId ?? null,
                tableId:          input.tableId          ?? null,
                tableAlias:       input.tableAlias       ?? null,
                kioskTurnNumber:  input.kioskTurnNumber  ?? null,
                status:           'DRAFT',
                printStatus:      'SKIPPED', // DRAFT no se imprime
                subtotal,
                totalAmount: subtotal,
                notes:       input.notes ?? null,
                deviceId:    authorDeviceId,
                items: {
                  create: input.items.map(item => ({
                    tenantId,
                    productId: item.productId,
                    quantity:  item.quantity,
                    unitPrice: priceMap.get(item.productId)!,
                    unitCost:  null,
                    subtotal:  parseFloat((priceMap.get(item.productId)! * item.quantity).toFixed(2)),
                    notes:     item.notes ?? null,
                  })),
                },
              },
              include: { items: true },
            })

            return { order: created, action: 'created' as const }
          }
        },
        { timeout: 15_000 },
      )

      return {
        orderId:       result.order.id,
        localSequence: result.order.localSequence,
        orderNumber:   result.order.orderNumber,
        status:        result.order.status,
        action:        result.action,
        // 'skipped' = pedido ya confirmado, el cliente no debe sobreescribirlo
      }
    }),

  // ────────────────────────────────────────────────────────────────────────────
  // confirmOrder — Transiciona DRAFT → CONFIRMED
  //
  // Esta es la operación más crítica del sistema. En una sola transacción:
  //   1. Valida que el pedido está en DRAFT y pertenece a la jornada activa
  //   2. Toma snapshots de precio (unitPrice) y costo (unitCost) de cada item
  //   3. Llama a assign_order_number() para asignar el número tributario
  //   4. Cambia printStatus → PENDING para despertar al PRINT_NODE
  //   5. Descuenta stock de la bodega default
  //
  // Si cualquier paso falla, toda la transacción se revierte — incluido
  // el incremento del secuencial en PointOfSale.
  // ────────────────────────────────────────────────────────────────────────────
  confirmOrder: anyUserRoleProcedure
    .use(withOpenDay)
    .input(confirmOrderInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const confirmed = await withTenantOptions(
        tenantId,
        async (tx) => {
          // ── 1. Bloquear la fila con SELECT FOR UPDATE ─────────────────────
          // BLINDAJE I1: SELECT FOR UPDATE adquiere un bloqueo exclusivo sobre
          // la fila ANTES de leer su estado. Si dos requests concurrentes
          // intentan confirmar el mismo pedido, el segundo queda bloqueado
          // hasta que el primero haga commit o rollback. Una vez que el primero
          // confirma (status → CONFIRMED), el segundo lee el status actualizado
          // y lanza CONFLICT — sin duplicar stock ni números de secuencia.
          //
          // Por qué FOR UPDATE aquí y no updateMany en otros procedimientos:
          // confirmOrder es la única transición con efectos secundarios en
          // cascada (snapshots, secuencial, stock). Un FOR UPDATE garantiza
          // que todos esos efectos ocurren exactamente una vez.
          const [locked] = await tx.$queryRaw<Array<{
            id:              string
            status:          string
            businessDayId:   string
            pointOfSaleId:   string
            deviceId:        string
            createdByUserId: string | null
            tableId:         string | null
            tableAlias:      string | null
            kioskTurnNumber: string | null
          }>>`
            SELECT
              id, status, "businessDayId", "pointOfSaleId", "deviceId", "createdByUserId",
              "tableId", "tableAlias", "kioskTurnNumber"
            FROM "Order"
            WHERE "tenantId" = ${tenantId}::uuid
              AND "localSequence" = ${input.localSequence}
            FOR UPDATE
          `

          if (!locked) {
            throw new TRPCError({
              code:    'NOT_FOUND',
              message: 'Pedido no encontrado. Sincroniza el pedido primero con syncOrder.',
            })
          }

          if (locked.status !== 'DRAFT' && locked.status !== 'KIOSK_PENDING') {
            throw new TRPCError({
              code:    'CONFLICT',
              message: `El pedido ya está en estado "${locked.status}" y no puede confirmarse`,
            })
          }

          // Verificar jornada activa (defensa contra replay de pedidos offline de otro día)
          if (locked.businessDayId !== businessDayId) {
            throw new TRPCError({
              code:    'PRECONDITION_FAILED',
              message: 'El pedido pertenece a una jornada anterior. No puede confirmarse en esta jornada.',
            })
          }

          const { kioskTurnNumber: generatedTurn } = await validateServiceModel(tx, {
            tenantId,
            establishmentId,
            businessDayId,
            orderId:    locked.id,
            tableId:    locked.tableId,
            tableAlias: locked.tableAlias,
          })

          // Cargar items y productos ahora que la fila está bloqueada
          const order = await tx.order.findUnique({
            where: { id: locked.id },
            include: {
              items: {
                include: {
                  product: {
                    select: {
                      id:                 true,
                      salePrice:          true,
                      currentAverageCost: true,
                    },
                  },
                },
              },
              pointOfSale: { select: { id: true } },
            },
          })

          if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido no encontrado' })

          // ── 2. Snapshots de precio y costo al momento de confirmar ────────
          // unitPrice = precio de venta actual del producto
          // unitCost  = costo promedio actual (para calcular margen después)
          const itemUpdates = order.items.map(item => ({
            id:        item.id,
            unitPrice: Number(item.product.salePrice),
            unitCost:  Number(item.product.currentAverageCost),
            subtotal:  parseFloat((Number(item.product.salePrice) * Number(item.quantity)).toFixed(2)),
          }))

          const subtotal    = parseFloat(itemUpdates.reduce((s, i) => s + i.subtotal, 0).toFixed(2))
          const totalAmount = subtotal

          // Actualizar snapshots en los items
          for (const upd of itemUpdates) {
            await tx.orderItem.update({
              where: { id: upd.id },
              data: {
                unitPrice: upd.unitPrice,
                unitCost:  upd.unitCost,
                subtotal:  upd.subtotal,
              },
            })
          }

          // ── 3. Asignar número tributario DENTRO de la transacción ─────────
          // Usar tx.$queryRaw — si la transacción falla, el secuencial
          // se revierte. Con prisma.$queryRaw (fuera de tx) quedaría
          // un hueco en la numeración aunque el pedido no se confirmara.
          const [row] = await tx.$queryRaw<Array<{ assign_order_number: string }>>`
            SELECT assign_order_number(
              ${order.id}::uuid,
              ${order.pointOfSaleId}::uuid,
              ${tenantId}::uuid
            )
          `
          const orderNumber = row.assign_order_number

          // ── 4. Cambiar estado + activar impresión ─────────────────────────
          // printStatus → PENDING despierta al PRINT_NODE vía PowerSync sync rule
          // (índice parcial idx_orders_print_pending WHERE printStatus = 'PENDING')
          const updatedOrder = await tx.order.update({
            where: { id: order.id },
            data: {
              status:      'CONFIRMED',
              printStatus: 'PENDING',
              orderNumber,
              subtotal,
              totalAmount,
              kioskTurnNumber: generatedTurn,
            },
          })

          // ── 5. Descontar stock de la bodega default ───────────────────────
          const stockItems = order.items.map(item => ({
            productId: item.productId,
            quantity:  Number(item.quantity),
            unitCost:  Number(item.product.currentAverageCost),
          }))

          const { stockDeducted, warehouseId } = await deductStock(tx, {
            tenantId,
            establishmentId,
            businessDayId,
            orderId:  order.id,
            items:    stockItems,
            userId:   userId ?? order.createdByUserId ?? 'system',
            deviceId: deviceId ?? order.deviceId,
          })

          return {
            order: updatedOrder,
            orderNumber,
            stockDeducted,
            warehouseId,
          }
        },
        { timeout: 20_000 },
      )

      return {
        orderId:       confirmed.order.id,
        localSequence: confirmed.order.localSequence,
        orderNumber:   confirmed.orderNumber,
        status:        confirmed.order.status,
        printStatus:   confirmed.order.printStatus,
        stockDeducted: confirmed.stockDeducted,
        warehouseId:   confirmed.warehouseId,
        message:       confirmed.stockDeducted
          ? `Pedido ${confirmed.orderNumber} confirmado. Comanda en camino a la impresora.`
          : `Pedido ${confirmed.orderNumber} confirmado. Sin bodega default configurada — stock no descontado.`,
      }
    }),

  // ────────────────────────────────────────────────────────────────────────────
  // markServed — CONFIRMED → SERVED
  //
  // El barman marca el pedido como entregado al cliente.
  // Opcional según la configuración del negocio.
  // ────────────────────────────────────────────────────────────────────────────
  markServed: barProcedure
    .use(withOpenDay)
    .input(markServedInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // BLINDAJE I1: updateMany con WHERE status = CONFIRMED.
      // Si count === 0: pedido no existe O ya cambió de estado (carrera).
      // Un segundo findFirst diagnóstico determina cuál de los dos ocurrió.
      const result = await withTenant(tenantId, (tx) =>
        tx.order.updateMany({
          where: {
            tenantId,
            localSequence: input.localSequence,
            status:        'CONFIRMED',
          },
          data: { status: 'SERVED' },
        }),
      )

      if (result.count === 0) {
        const existing = await withTenant(tenantId, (tx) =>
          tx.order.findFirst({
            where:  { tenantId, localSequence: input.localSequence },
            select: { status: true },
          }),
        )
        if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido no encontrado' })
        throw new TRPCError({
          code:    'CONFLICT',
          message: `Solo se pueden marcar como servidos los pedidos CONFIRMED. Estado actual: ${existing.status}`,
        })
      }

      const updated = await withTenant(tenantId, (tx) =>
        tx.order.findFirst({
          where:  { tenantId, localSequence: input.localSequence },
          select: { id: true, status: true, localSequence: true, orderNumber: true },
        }),
      )

      return { order: updated }
    }),

  // ────────────────────────────────────────────────────────────────────────────
  // requestPayment — CONFIRMED | SERVED → AWAITING_PAYMENT
  //
  // El mesero indica que el cliente quiere pagar.
  // El cajero/barman verá el pedido en su cola de cobro.
  // ────────────────────────────────────────────────────────────────────────────
  requestPayment: anyUserRoleProcedure
    .use(withOpenDay)
    .input(requestPaymentInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // BLINDAJE I1: una sola operación atómica.
      // status IN ('CONFIRMED', 'SERVED') — si el pedido fue cobrado o
      // cancelado por otro proceso entre tanto, count === 0 y lanzamos error.
      const result = await withTenant(tenantId, (tx) =>
        tx.order.updateMany({
          where: {
            tenantId,
            localSequence: input.localSequence,
            status: { in: ['CONFIRMED', 'SERVED'] },
          },
          data: { status: 'AWAITING_PAYMENT' },
        }),
      )

      if (result.count === 0) {
        const existing = await withTenant(tenantId, (tx) =>
          tx.order.findFirst({
            where:  { tenantId, localSequence: input.localSequence },
            select: { status: true },
          }),
        )
        if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido no encontrado' })
        throw new TRPCError({
          code:    'CONFLICT',
          message: `No se puede solicitar cobro para un pedido en estado "${existing.status}"`,
        })
      }

      const updated = await withTenant(tenantId, (tx) =>
        tx.order.findFirst({
          where:  { tenantId, localSequence: input.localSequence },
          select: { id: true, status: true, localSequence: true, orderNumber: true, totalAmount: true },
        }),
      )

      return {
        order: {
          ...updated!,
          totalAmount: Number(updated!.totalAmount),
        },
      }
    }),

  // ────────────────────────────────────────────────────────────────────────────
  // cancel — Cancela un pedido
  //
  // Solo se pueden cancelar pedidos que aún no tienen pago registrado.
  // Si el pedido ya fue CONFIRMED, se revierte el stock (StockMovement de ajuste).
  // ────────────────────────────────────────────────────────────────────────────
  cancel: barProcedure
    .use(withOpenDay)
    .input(cancelOrderInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      await withTenantOptions(
        tenantId,
        async (tx) => {
          // BLINDAJE I1: SELECT FOR UPDATE bloquea la fila durante la transacción.
          // cancel tiene efectos secundarios condicionales (reversión de stock)
          // que dependen del status actual — necesitamos leer + actuar de forma
          // atómica. FOR UPDATE es más apropiado que updateMany aquí porque
          // primero necesitamos saber si había stock que revertir.
          const [locked] = await tx.$queryRaw<Array<{
            id:     string
            status: string
          }>>`
            SELECT id, status FROM "Order"
            WHERE "tenantId"      = ${tenantId}::uuid
              AND "localSequence" = ${input.localSequence}
            FOR UPDATE
          `

          if (!locked) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido no encontrado' })
          }

          const cancelableStatuses = ['DRAFT', 'KIOSK_PENDING', 'CONFIRMED', 'SERVED', 'AWAITING_PAYMENT']
          if (!cancelableStatuses.includes(locked.status)) {
            throw new TRPCError({
              code:    'CONFLICT',
              message: `No se puede cancelar un pedido en estado "${locked.status}"`,
            })
          }

          // Cargar items solo si hay stock que revertir
          const needsStockReversal = locked.status === 'CONFIRMED' || locked.status === 'SERVED'

          const order = await tx.order.findUnique({
            where:   { id: locked.id },
            include: needsStockReversal
              ? { items: { select: { productId: true, quantity: true, unitCost: true } } }
              : { items: false },
          })

          if (needsStockReversal && order?.items?.length) {
            const defaultWarehouse = await tx.warehouse.findFirst({
              where: {
                tenantId,
                establishmentId,
                isDefault:  true,
                isActive:   true,
                deletedAt:  null,
              },
              select: { id: true },
            })

            if (defaultWarehouse) {
              for (const item of order.items) {
                await tx.stockLevel.update({
                  where: {
                    warehouseId_productId: {
                      warehouseId: defaultWarehouse.id,
                      productId:   item.productId,
                    },
                  },
                  data: { quantity: { increment: Number(item.quantity) } },
                })

                await tx.stockMovement.create({
                  data: {
                    tenantId,
                    establishmentId,
                    type:              MovementType.WASTE_ADJUSTMENT,
                    // Usamos WASTE_ADJUSTMENT para revertir — el auditor puede
                    // distinguirlo del movimiento original (SALE_DEDUCTION)
                    destWarehouseId:   defaultWarehouse.id,
                    productId:         item.productId,
                    quantity:          Number(item.quantity),
                    unitCost:          item.unitCost ? Number(item.unitCost) : 0,
                    orderId:           order.id,
                    businessDayId,
                    createdBy:         userId ?? 'system',
                    deviceId:          deviceId ?? order.deviceId,
                    notes:             `Reversión por cancelación del pedido ${order.orderNumber ?? order.localSequence}`,
                  },
                })
              }
            }
          }

          await tx.order.update({
            where: { id: order.id },
            data: {
              status:             'CANCELLED',
              printStatus:        'SKIPPED',
              cancellationReason: input.cancellationReason,
              cancellationNotes:  input.cancellationNotes ?? null,
              cancelledBy:        userId ?? null,
              cancelledAt:        new Date(),
            },
          })
        },
        { timeout: 15_000 },
      )

      return { success: true, localSequence: input.localSequence }
    }),

  // ────────────────────────────────────────────────────────────────────────────
  // listActive — Pedidos activos de la jornada
  //
  // El cajero y el barman necesitan ver todos los pedidos activos.
  // El mesero solo ve los suyos (filtrado por userId en ctx).
  // ────────────────────────────────────────────────────────────────────────────
  listActive: anyUserRoleProcedure
    .use(withOpenDay)
    .input(listOrdersInput)
    .query(async ({ input, ctx }) => {
      const { tenantId, userId, roles } = ctx.auth
      const { id: businessDayId }       = ctx.businessDay

      const isCashierOrAdmin = roles.some(r => ['ADMIN','CASHIER','BARMAN'].includes(r))

      const orders = await withTenant(tenantId, (tx) =>
        tx.order.findMany({
          where: {
            tenantId,
            businessDayId,
            // Mesero solo ve los suyos; cajero/barman ven todos
            ...(isCashierOrAdmin ? {} : { createdByUserId: userId }),
            status: {
              in: input.status ?? [
                'DRAFT', 'CONFIRMED', 'SERVED',
                'AWAITING_PAYMENT', 'AWAITING_PAYMENT_AT_CASHIER',
                'CREDIT_REQUESTED',
              ],
            },
            ...(input.cursor && { id: { lt: input.cursor } }),
          },
          select: {
            id:              true,
            localSequence:   true,
            orderNumber:     true,
            status:          true,
            printStatus:     true,
            tableId:         true,
            tableAlias:      true,
            kioskTurnNumber: true,
            totalAmount:     true,
            createdAt:       true,
            items: {
              select: {
                productId: true,
                quantity:  true,
                unitPrice: true,
                product: { select: { name: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take:    input.limit,
        }),
      )

      return {
        orders: orders.map(o => ({
          ...o,
          totalAmount: Number(o.totalAmount),
          items: o.items.map(i => ({
            ...i,
            quantity:  Number(i.quantity),
            unitPrice: Number(i.unitPrice),
          })),
        })),
        nextCursor: orders.length === input.limit
          ? orders[orders.length - 1].id
          : null,
      }
    }),

  // ────────────────────────────────────────────────────────────────────────────
  // getByLocalSequence — Detalle de un pedido
  //
  // La app usa localSequence para no depender del id del servidor.
  // ────────────────────────────────────────────────────────────────────────────
  getByLocalSequence: anyUserRoleProcedure
    .input(z.object({ localSequence: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const order = await withTenant(tenantId, (tx) =>
        tx.order.findFirst({
          where: { tenantId, localSequence: input.localSequence },
          include: {
            items: {
              include: {
                product: { select: { id: true, name: true, unit: true } },
              },
            },
            table: { select: { id: true, number: true, alias: true } },
          },
        }),
      )

      if (!order) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido no encontrado' })
      }

      return {
        order: {
          ...order,
          subtotal:    Number(order.subtotal),
          taxAmount:   Number(order.taxAmount),
          totalAmount: Number(order.totalAmount),
          items: order.items.map(i => ({
            ...i,
            quantity:  Number(i.quantity),
            unitPrice: Number(i.unitPrice),
            unitCost:  i.unitCost ? Number(i.unitCost) : null,
            subtotal:  Number(i.subtotal),
          })),
        },
      }
    }),
})
