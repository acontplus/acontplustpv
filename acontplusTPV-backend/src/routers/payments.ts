// =============================================================================
// apps/api/src/routers/payments.ts
// Flujo de cobro — Paso 6
//
// Solo CASHIER y BARMAN pueden cobrar pedidos (closedByUserId).
// El WAITER no maneja dinero — Instrucciones §3.
//
// Métodos de pago soportados:
//   CASH     → PAID_CASH          + CashRegisterEvent(SALE_CASH)
//   TRANSFER → PAID_TRANSFER_PENDING + TransferPayment + CashRegisterEvent(SALE_TRANSFER)
//   CREDIT   → flujo en dos pasos:
//              Paso A (barman):   AWAITING_PAYMENT → CREDIT_REQUESTED
//              Paso B (cashier):  CREDIT_REQUESTED → PAID_CREDIT + CreditTransaction
//
// Por qué el crédito tiene dos pasos (Instrucciones §4):
//   El BARMAN puede *proponer* un crédito pero no aprobarlo.
//   Solo CASHIER o ADMIN aprueban y crean el CreditTransaction.
//   Esto evita que el barman marque pedidos como crédito y se quede
//   con el efectivo que el cliente sí pagó.
//
// Todas las operaciones financieras son atómicas con withTenantOptions.
// Los CashRegisterEvent son append-only (sin updatedAt) — Instrucciones §4.
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import {
  barProcedure,
  cashierProcedure,
}                     from '../middleware/auth'
import { withOpenDay } from '../middleware/businessDay'
import { withTenant, withTenantOptions } from '../lib/rls'
import {
  CashEventType,
  CreditEventType,
  OrderStatus,
}                     from '@prisma/client'

// =============================================================================
// SCHEMAS
// =============================================================================

// Pago en efectivo
const payCashInput = z.object({
  localSequence: z.string().min(1),
  amountReceived: z.number().positive(),
  // Lo que el cliente entregó físicamente (puede ser mayor al totalAmount)
  notes:         z.string().max(500).optional(),
})

// Pago con transferencia bancaria
const payTransferInput = z.object({
  localSequence:   z.string().min(1),
  amount:          z.number().positive(),
  bankName:        z.string().min(1).max(100),
  referenceNumber: z.string().min(1).max(100),
  // Número de transacción verificable contra extracto bancario
  targetAccount:   z.string().min(1).max(100),
  // Cuenta del dueño a la que llegó el dinero (obligatorio para conciliación)
  receiptUrl:      z.string().url().optional(),
  // URL de la foto del comprobante (upload previo por HTTP separado)
  notes:           z.string().max(500).optional(),
})

// Paso A: el barman solicita crédito para el cliente
const requestCreditInput = z.object({
  localSequence: z.string().min(1),
  notes:         z.string().max(500).optional(),
})

// Paso B: el cajero aprueba el crédito y registra el deudor
const approveCreditInput = z.object({
  localSequence:    z.string().min(1),
  // Exactamente uno de los dos siguientes (XOR, igual que en CreditTransaction)
  debtorUserId:     z.string().uuid().optional(),
  debtorCustomerId: z.string().uuid().optional(),
  notes:            z.string().max(500).optional(),
}).refine(
  d => (d.debtorUserId == null) !== (d.debtorCustomerId == null),
  { message: 'Debe especificar exactamente un deudor: debtorUserId o debtorCustomerId, no ambos ni ninguno' },
)

// El cajero rechaza el crédito solicitado
const rejectCreditInput = z.object({
  localSequence: z.string().min(1),
  notes:         z.string().max(500).optional(),
})

// =============================================================================
// HELPER ATÓMICO: lockAndTransition
//
// BLINDAJE B4/I1: Reemplaza el patrón "findFirst → check → update" (race
// condition) por un UPDATE atómico con WHERE status IN (allowedStatuses).
//
// Flujo:
//   1. updateMany con WHERE id + status IN [estados permitidos]
//   2. Si count === 0 → pedido no existe O estado cambió (otra transacción ganó)
//      → findFirst diagnóstico para determinar el mensaje correcto
//   3. Si count === 1 → transición garantizada, cargamos el pedido actualizado
//
// Por qué updateMany en lugar de update({ where: { id, status } }):
//   update lanza P2025 tanto si el registro no existe como si el WHERE
//   de status no coincide — el error es ambiguo.
//   updateMany devuelve count: 0 limpiamente, sin excepción, y podemos
//   diagnosticar con un findFirst posterior.
// =============================================================================

async function lockAndTransition(
  tx: Parameters<Parameters<typeof withTenantOptions>[1]>[0],
  params: {
    tenantId:        string
    localSequence:   string
    allowedStatuses: OrderStatus[]
    newStatus:       OrderStatus
    extraData?:      Record<string, unknown>
    // Datos adicionales a escribir junto con el status (closedByUserId, paymentMethod, etc.)
  },
) {
  const { tenantId, localSequence, allowedStatuses, newStatus, extraData } = params

  const result = await tx.order.updateMany({
    where: {
      tenantId,
      localSequence,
      status: { in: allowedStatuses },
    },
    data: {
      status: newStatus,
      ...extraData,
    },
  })

  if (result.count === 0) {
    // Diagnosticar: ¿no existe, o la carrera nos ganó?
    const existing = await tx.order.findFirst({
      where:  { tenantId, localSequence },
      select: { id: true, status: true },
    })
    if (!existing) {
      throw new TRPCError({
        code:    'NOT_FOUND',
        message: 'Pedido no encontrado',
      })
    }
    throw new TRPCError({
      code:    'CONFLICT',
      message: `El pedido está en estado "${existing.status}". ` +
               `Estados válidos para esta operación: ${allowedStatuses.join(', ')}`,
    })
  }

  // Leer el pedido actualizado para devolver datos completos al caller
  const order = await tx.order.findFirst({
    where:  { tenantId, localSequence },
    select: {
      id:              true,
      tenantId:        true,
      establishmentId: true,
      businessDayId:   true,
      pointOfSaleId:   true,
      localSequence:   true,
      orderNumber:     true,
      status:          true,
      totalAmount:     true,
      deviceId:        true,
      createdByUserId: true,
    },
  })

  return order!
}

// =============================================================================
// ROUTER
// =============================================================================

export const paymentsRouter = router({

  // ──────────────────────────────────────────────────────────────────────────
  // payCash — Cobro en efectivo
  //
  // AWAITING_PAYMENT | AWAITING_PAYMENT_AT_CASHIER → PAID_CASH
  //
  // Genera CashRegisterEvent(SALE_CASH) para que el arqueo ciego cuadre.
  // El campo amountReceived puede ser mayor a totalAmount — el cambio
  // lo calcula la UI del cajero, no el servidor.
  // ──────────────────────────────────────────────────────────────────────────
  payCash: barProcedure
    .use(withOpenDay)
    .input(payCashInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // BLINDAJE B4: lockAndTransition hace el UPDATE atómico.
          // Si otro proceso ya cobró este pedido, count=0 y lanza CONFLICT.
          const order = await lockAndTransition(tx, {
            tenantId,
            localSequence: input.localSequence,
            allowedStatuses: ['AWAITING_PAYMENT', 'AWAITING_PAYMENT_AT_CASHIER'],
            newStatus:       'PAID_CASH',
            extraData: {
              paymentMethod:  'CASH',
              closedByUserId: userId!,
            },
          })

          const totalAmount = Number(order.totalAmount)

          if (input.amountReceived < totalAmount) {
            throw new TRPCError({
              code:    'BAD_REQUEST',
              message: `El monto recibido ($${input.amountReceived}) es menor al total del pedido ($${totalAmount})`,
            })
          }

          // 2. Registrar el ingreso en la caja (append-only)
          const cashEvent = await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId: order.establishmentId,
              businessDayId,
              type:    CashEventType.SALE_CASH,
              amount:  totalAmount,
              userId:  userId!,
              orderId: order.id,
              deviceId: deviceId ?? order.deviceId,
              notes:   input.notes ?? null,
            },
          })

          return {
            order,
            cashEvent,
            change: parseFloat((input.amountReceived - totalAmount).toFixed(2)),
          }
        },
        { timeout: 15_000 },
      )

      return {
        orderId:       result.order.id,
        localSequence: result.order.localSequence,
        orderNumber:   result.order.orderNumber,
        status:        'PAID_CASH' as const,
        totalAmount:   Number(result.order.totalAmount),
        amountReceived: input.amountReceived,
        change:        result.change,
        cashEventId:   result.cashEvent.id,
        message:       `Cobrado. Cambio: $${result.change.toFixed(2)}`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // payTransfer — Cobro con transferencia bancaria
  //
  // AWAITING_PAYMENT | AWAITING_PAYMENT_AT_CASHIER → PAID_TRANSFER_PENDING
  //
  // El cliente se acerca a la barra y muestra el comprobante.
  // El barman/cajero registra:
  //   - referenceNumber (número de transacción, verificable contra extracto)
  //   - targetAccount   (cuenta del dueño a la que llegó el dinero)
  //   - receiptUrl      (foto del comprobante, subida previamente por HTTP)
  //
  // El dinero queda PENDING hasta la conciliación del Paso 7.
  // CashRegisterEvent(SALE_TRANSFER) registra el ingreso "esperado"
  // para que aparezca en el resumen del día del cajero.
  // ──────────────────────────────────────────────────────────────────────────
  payTransfer: barProcedure
    .use(withOpenDay)
    .input(payTransferInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // BLINDAJE B4: lockAndTransition — el ORDER y el estado se actualizan
          // en la misma operación atómica. El TransferPayment se crea después
          // dentro de la misma transacción, garantizando consistencia.
          const order = await lockAndTransition(tx, {
            tenantId,
            localSequence: input.localSequence,
            allowedStatuses: ['AWAITING_PAYMENT', 'AWAITING_PAYMENT_AT_CASHIER'],
            newStatus:       'PAID_TRANSFER_PENDING',
            extraData: {
              paymentMethod:  'TRANSFER',
              closedByUserId: userId!,
            },
          })

          const totalAmount = Number(order.totalAmount)

          // 1. Crear el registro de transferencia con cadena de custodia completa
          const transferPayment = await tx.transferPayment.create({
            data: {
              tenantId,
              establishmentId:   order.establishmentId,
              orderId:           order.id,
              businessDayId,
              amount:            input.amount,
              bankName:          input.bankName,
              referenceNumber:   input.referenceNumber,
              receiptUrl:        input.receiptUrl  ?? null,
              targetAccount:     input.targetAccount,
              status:            'PENDING',
              capturedByUserId:  userId!,
              capturedByDeviceId: deviceId ?? order.deviceId,
              capturedAt:        new Date(),
            },
          })

          // 2. Registrar en caja como SALE_TRANSFER (ingreso esperado)
          const cashEvent = await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId:  order.establishmentId,
              businessDayId,
              type:             CashEventType.SALE_TRANSFER,
              amount:           totalAmount,
              userId:           userId!,
              orderId:          order.id,
              transferPaymentId: transferPayment.id,
              deviceId:         deviceId ?? order.deviceId,
              notes:            `Ref: ${input.referenceNumber} | ${input.bankName} → ${input.targetAccount}`,
            },
          })

          return { order, transferPayment, cashEvent }
        },
        { timeout: 15_000 },
      )

      return {
        orderId:          result.order.id,
        localSequence:    result.order.localSequence,
        orderNumber:      result.order.orderNumber,
        status:           'PAID_TRANSFER_PENDING' as const,
        transferPaymentId: result.transferPayment.id,
        referenceNumber:  input.referenceNumber,
        message:          `Transferencia registrada. Pendiente de conciliación bancaria.`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // requestCredit — Paso A: el barman propone cobrar a crédito
  //
  // AWAITING_PAYMENT → CREDIT_REQUESTED
  //
  // Solo cambia el estado. NO crea CreditTransaction todavía.
  // El cajero verá el pedido en su pantalla y decide si aprueba o rechaza.
  // ──────────────────────────────────────────────────────────────────────────
  requestCredit: barProcedure
    .use(withOpenDay)
    .input(requestCreditInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // BLINDAJE B4: una sola transacción atómica.
      // ANTES: dos withTenant() separados — leer en uno, actualizar en otro.
      //        Ventana de carrera entre ambas llamadas: otro proceso podía
      //        cobrar el pedido justo entre la lectura y la escritura.
      // AHORA: lockAndTransition hace el UPDATE en una sola operación.
      //        Si el cajero ya cobró el pedido en ese milisegundo, count=0
      //        y el barman recibe CONFLICT en lugar de sobrescribir el pago.
      const order = await withTenant(tenantId, (tx) =>
        lockAndTransition(tx, {
          tenantId,
          localSequence:   input.localSequence,
          allowedStatuses: ['AWAITING_PAYMENT', 'AWAITING_PAYMENT_AT_CASHIER'],
          newStatus:       'CREDIT_REQUESTED',
          extraData: {
            notes: input.notes
              ? `[Crédito solicitado] ${input.notes}`
              : '[Crédito solicitado — pendiente de aprobación del cajero]',
          },
        }),
      )

      return {
        orderId:       order.id,
        localSequence: order.localSequence,
        orderNumber:   order.orderNumber,
        status:        'CREDIT_REQUESTED' as const,
        message:       'Solicitud de crédito enviada. El cajero debe aprobarla.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // approveCredit — Paso B: el cajero aprueba el crédito
  //
  // CREDIT_REQUESTED → PAID_CREDIT
  //
  // Solo CASHIER o ADMIN pueden aprobar créditos — Instrucciones §4.
  //
  // Crea CreditTransaction(CREDIT_ISSUED) append-only con el deudor.
  // Verifica el límite de crédito si es un Customer registrado.
  // Registra en caja el crédito otorgado (aparece como "Créditos" en el
  // resumen del día, separado del efectivo y las transferencias).
  // ──────────────────────────────────────────────────────────────────────────
  approveCredit: cashierProcedure
    .use(withOpenDay)
    .input(approveCreditInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // BLINDAJE B4: lockAndTransition — adquiere la transición de
          // CREDIT_REQUESTED → PAID_CREDIT de forma atómica.
          // Si el cajero ya rechazó o aprobó el crédito en otro dispositivo,
          // count=0 y esta operación lanza CONFLICT sin crear registros huérfanos.
          const order = await lockAndTransition(tx, {
            tenantId,
            localSequence:   input.localSequence,
            allowedStatuses: ['CREDIT_REQUESTED'],
            newStatus:       'PAID_CREDIT',
            extraData: {
              paymentMethod:  input.debtorUserId ? 'CREDIT_EMPLOYEE' : 'CREDIT_CUSTOMER',
              closedByUserId: userId!,
            },
          })

          const totalAmount = Number(order.totalAmount)

          // Verificar límite de crédito si es cliente registrado
          if (input.debtorCustomerId) {
            const customer = await tx.customer.findFirst({
              where: {
                id:        input.debtorCustomerId,
                tenantId,
                isActive:  true,
                deletedAt: null,
              },
              select: { id: true, name: true, creditLimit: true },
            })

            if (!customer) {
              throw new TRPCError({
                code:    'NOT_FOUND',
                message: 'Cliente no encontrado o inactivo',
              })
            }

            // Calcular deuda actual del cliente
            const debtResult = await tx.$queryRaw<Array<{ current_debt: number }>>`
              SELECT COALESCE(
                SUM(CASE WHEN type = 'CREDIT_ISSUED' THEN amount ELSE 0 END) -
                SUM(CASE WHEN type IN ('PAYMENT_RECEIVED','CREDIT_CANCELLED','DISCOUNT_APPLIED')
                    THEN COALESCE("appliedAmount", amount) ELSE 0 END),
                0
              ) AS current_debt
              FROM "CreditTransaction"
              WHERE "tenantId"         = ${tenantId}::uuid
                AND "debtorCustomerId" = ${input.debtorCustomerId}::uuid
            `

            const currentDebt   = Number(debtResult[0]?.current_debt ?? 0)
            const creditLimit   = Number(customer.creditLimit)
            const newTotalDebt  = currentDebt + totalAmount

            if (creditLimit > 0 && newTotalDebt > creditLimit) {
              throw new TRPCError({
                code:    'PRECONDITION_FAILED',
                message: `El cliente "${customer.name}" excedería su límite de crédito. ` +
                         `Deuda actual: $${currentDebt.toFixed(2)} | ` +
                         `Límite: $${creditLimit.toFixed(2)} | ` +
                         `Nuevo total si se aprueba: $${newTotalDebt.toFixed(2)}`,
              })
            }
          }

          // Verificar que el empleado deudor existe si aplica
          if (input.debtorUserId) {
            const employee = await tx.user.findFirst({
              where: {
                id:        input.debtorUserId,
                tenantId,
                isActive:  true,
                deletedAt: null,
              },
              select: { id: true, name: true },
            })

            if (!employee) {
              throw new TRPCError({
                code:    'NOT_FOUND',
                message: 'Empleado no encontrado o inactivo',
              })
            }
          }

          // 1. Crear CreditTransaction (append-only)
          const creditTx = await tx.creditTransaction.create({
            data: {
              tenantId,
              businessDayId,
              type:             CreditEventType.CREDIT_ISSUED,
              amount:           totalAmount,
              debtorUserId:     input.debtorUserId     ?? null,
              debtorCustomerId: input.debtorCustomerId ?? null,
              orderId:          order.id,
              authorizedBy:     userId!,
              deviceId:         deviceId ?? order.deviceId,
              notes:            input.notes ?? null,
            },
          })

          // 2. Registrar en caja el crédito otorgado
          // Aparece como "crédito otorgado" en el resumen del día —
          // el cajero puede ver cuánto salió fiado esa noche.
          // NO reduce el saldo teórico de efectivo — es una categoría aparte.
          // Nota: No existe CashEventType.SALE_CREDIT en el schema.
          // Usamos ADJUSTMENT con nota descriptiva para registrar el crédito.
          await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId: order.establishmentId,
              businessDayId,
              type:    CashEventType.ADJUSTMENT,
              amount:  totalAmount,
              userId:  userId!,
              orderId: order.id,
              deviceId: deviceId ?? order.deviceId,
              notes:   `Crédito otorgado | Pedido ${order.orderNumber ?? order.localSequence}`,
            },
          })

          return { order, creditTx }
        },
        { timeout: 15_000 },
      )

      return {
        orderId:           result.order.id,
        localSequence:     result.order.localSequence,
        orderNumber:       result.order.orderNumber,
        status:            'PAID_CREDIT' as const,
        creditTransactionId: result.creditTx.id,
        amount:            Number(result.order.totalAmount),
        message:           'Crédito aprobado y registrado.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // rejectCredit — El cajero rechaza el crédito solicitado
  //
  // CREDIT_REQUESTED → AWAITING_PAYMENT
  //
  // El pedido regresa a la cola de cobro para que el cliente pague
  // con otro método.
  // ──────────────────────────────────────────────────────────────────────────
  rejectCredit: cashierProcedure
    .use(withOpenDay)
    .input(rejectCreditInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // BLINDAJE I1: una sola operación atómica.
      // Si el cajero ya aprobó el crédito desde otro dispositivo,
      // count=0 y esta operación lanza CONFLICT en lugar de revertir un
      // pedido que ya está en PAID_CREDIT.
      const order = await withTenant(tenantId, (tx) =>
        lockAndTransition(tx, {
          tenantId,
          localSequence:   input.localSequence,
          allowedStatuses: ['CREDIT_REQUESTED'],
          newStatus:       'AWAITING_PAYMENT',
          extraData: {
            notes: input.notes
              ? `[Crédito rechazado] ${input.notes}`
              : '[Crédito rechazado por el cajero — requiere otro método de pago]',
          },
        }),
      )

      return {
        orderId:       order.id,
        localSequence: order.localSequence,
        orderNumber:   order.orderNumber,
        status:        'AWAITING_PAYMENT' as const,
        message:       'Crédito rechazado. El pedido volvió a la cola de cobro.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // listPendingPayments — Pedidos esperando cobro (vista del cajero/barman)
  //
  // Muestra AWAITING_PAYMENT, AWAITING_PAYMENT_AT_CASHIER y CREDIT_REQUESTED.
  // Ordenados por antigüedad — el más viejo primero.
  // ──────────────────────────────────────────────────────────────────────────
  listPendingPayments: barProcedure
    .use(withOpenDay)
    .query(async ({ ctx }) => {
      const { tenantId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const orders = await withTenant(tenantId, (tx) =>
        tx.order.findMany({
          where: {
            tenantId,
            businessDayId,
            status: {
              in: [
                'AWAITING_PAYMENT',
                'AWAITING_PAYMENT_AT_CASHIER',
                'CREDIT_REQUESTED',
              ],
            },
          },
          select: {
            id:              true,
            localSequence:   true,
            orderNumber:     true,
            status:          true,
            tableId:         true,
            tableAlias:      true,
            kioskTurnNumber: true,
            totalAmount:     true,
            createdAt:       true,
            items: {
              select: {
                quantity: true,
                product: { select: { name: true } },
              },
            },
            table: {
              select: { number: true, alias: true },
            },
          },
          orderBy: { createdAt: 'asc' }, // el más viejo primero
        }),
      )

      return {
        orders: orders.map(o => ({
          ...o,
          totalAmount: Number(o.totalAmount),
          items: o.items.map(i => ({
            quantity:    Number(i.quantity),
            productName: i.product.name,
          })),
        })),
        total: orders.length,
      }
    }),
})
