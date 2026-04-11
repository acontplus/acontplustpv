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
//
// FIX AUDITORÍA (Bug CRÍTICO 2):
//   payTransfer: añadida validación de que input.amount coincide con
//   order.totalAmount (±$0.01 de tolerancia de redondeo).
//   La versión anterior creaba TransferPayment con input.amount y
//   CashRegisterEvent con totalAmount del pedido — si diferían, la
//   conciliación del Paso 7 quedaba con una diferencia irreconciliable.
//   El arqueo de caja acumulaba errores silenciosos por cada transferencia.
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import {
  barProcedure,
  cashierProcedure,
}                     from '../middleware/auth'
import { withOpenDay }  from '../middleware/businessDay'
import { withTenant, withTenantOptions } from '../lib/rls'
import {
  CashEventType,
  CreditEventType,
}                     from '@prisma/client'

// =============================================================================
// SCHEMAS
// =============================================================================

// Pago en efectivo
const payCashInput = z.object({
  localSequence:  z.string().min(1),
  amountReceived: z.number().positive(),
  // Lo que el cliente entregó físicamente (puede ser mayor al totalAmount)
  notes:          z.string().max(500).optional(),
})

// Pago con transferencia bancaria
const payTransferInput = z.object({
  localSequence:   z.string().min(1),
  amount:          z.number().positive(),
  // Monto que el cajero registra — DEBE coincidir con order.totalAmount
  // (validación server-side dentro de la mutación con tolerancia ±$0.01)
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
// Si dos requests llegan al mismo tiempo, solo uno actualiza count=1 y
// el otro recibe CONFLICT — sin posibilidad de doble cobro.
// =============================================================================

async function lockAndTransition(
  tx: Parameters<Parameters<typeof withTenantOptions>[1]>[0],
  opts: {
    tenantId:        string
    localSequence:   string
    allowedStatuses: string[]
    newStatus:       string
    extraData?:      Record<string, unknown>
  },
) {
  const updated = await tx.order.updateMany({
    where: {
      tenantId:      opts.tenantId,
      localSequence: opts.localSequence,
      status:        { in: opts.allowedStatuses as never[] },
    },
    data: {
      status:    opts.newStatus as never,
      updatedAt: new Date(),
      ...opts.extraData,
    },
  })

  if (updated.count === 0) {
    // El pedido no existía, no pertenecía al tenant, o ya fue procesado
    const existing = await tx.order.findFirst({
      where:  { tenantId: opts.tenantId, localSequence: opts.localSequence },
      select: { status: true, localSequence: true },
    })

    if (!existing) {
      throw new TRPCError({
        code:    'NOT_FOUND',
        message: `Pedido con secuencia "${opts.localSequence}" no encontrado`,
      })
    }

    throw new TRPCError({
      code:    'CONFLICT',
      message: `El pedido ya fue procesado (estado actual: ${existing.status}). Recarga la pantalla.`,
    })
  }

  // Obtener el pedido actualizado para leer su totalAmount y otros campos
  const order = await tx.order.findFirst({
    where:  { tenantId: opts.tenantId, localSequence: opts.localSequence },
    select: {
      id:              true,
      localSequence:   true,
      orderNumber:     true,
      totalAmount:     true,
      status:          true,
      establishmentId: true,
      businessDayId:   true,
      deviceId:        true,
    },
  })

  if (!order) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Pedido no encontrado tras actualización' })
  }

  return order
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
            localSequence:   input.localSequence,
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

          // Registrar el ingreso en la caja (append-only)
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
        orderId:        result.order.id,
        localSequence:  result.order.localSequence,
        orderNumber:    result.order.orderNumber,
        status:         'PAID_CASH' as const,
        totalAmount:    Number(result.order.totalAmount),
        amountReceived: input.amountReceived,
        change:         result.change,
        cashEventId:    result.cashEvent.id,
        message:        `Cobrado. Cambio: $${result.change.toFixed(2)}`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // payTransfer — Cobro con transferencia bancaria
  //
  // AWAITING_PAYMENT | AWAITING_PAYMENT_AT_CASHIER → PAID_TRANSFER_PENDING
  //
  // FIX CRÍTICO: input.amount DEBE coincidir con order.totalAmount (±$0.01).
  //
  // Razón: TransferPayment.amount, CashRegisterEvent.amount y Order.totalAmount
  // deben ser idénticos para que la conciliación del Paso 7 cuadre.
  // Si input.amount ≠ totalAmount, el arqueo acumula diferencias silenciosas:
  //   - SALE_TRANSFER registra X en caja
  //   - TRANSFER_CONFIRMED (Paso 7) registra Y en la confirmación
  //   - Diferencia irreconciliable en el cierre de jornada
  //
  // La UI del cajero debe pre-rellenar el campo con order.totalAmount.
  // El servidor valida como última línea de defensa.
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
            localSequence:   input.localSequence,
            allowedStatuses: ['AWAITING_PAYMENT', 'AWAITING_PAYMENT_AT_CASHIER'],
            newStatus:       'PAID_TRANSFER_PENDING',
            extraData: {
              paymentMethod:  'TRANSFER',
              closedByUserId: userId!,
            },
          })

          const totalAmount = Number(order.totalAmount)

          // ── VALIDACIÓN DE MONTO (FIX CRÍTICO) ─────────────────────────────
          // input.amount debe ser exactamente el total del pedido.
          // Tolerancia de ±$0.01 para cubrir redondeos de decimales en el cliente.
          // Si el cajero registra un monto diferente, rechazamos antes de crear
          // cualquier registro financiero — más fácil corregir que conciliar.
          if (Math.abs(input.amount - totalAmount) > 0.01) {
            throw new TRPCError({
              code:    'BAD_REQUEST',
              message: `El monto de la transferencia ($${input.amount.toFixed(2)}) no coincide con el total del pedido ($${totalAmount.toFixed(2)}). Ambos montos deben ser iguales para que la conciliación cuadre.`,
            })
          }

          // Usar totalAmount (fuente de verdad del sistema) para todos los
          // registros financieros — no input.amount. Esto garantiza coherencia
          // incluso si hubiera un redondeo mínimo por encima de la tolerancia.
          const confirmedAmount = totalAmount

          // 1. Crear el registro de transferencia con cadena de custodia completa
          const transferPayment = await tx.transferPayment.create({
            data: {
              tenantId,
              establishmentId:    order.establishmentId,
              orderId:            order.id,
              businessDayId,
              amount:             confirmedAmount,
              // ↑ Siempre totalAmount del pedido — no input.amount
              bankName:           input.bankName,
              referenceNumber:    input.referenceNumber,
              receiptUrl:         input.receiptUrl ?? null,
              targetAccount:      input.targetAccount,
              status:             'PENDING',
              capturedByUserId:   userId!,
              capturedByDeviceId: deviceId ?? order.deviceId,
              capturedAt:         new Date(),
            },
          })

          // 2. Registrar en caja como SALE_TRANSFER (ingreso esperado)
          //    amount = confirmedAmount = totalAmount — los tres registros son coherentes
          const cashEvent = await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId:   order.establishmentId,
              businessDayId,
              type:              CashEventType.SALE_TRANSFER,
              amount:            confirmedAmount,
              userId:            userId!,
              orderId:           order.id,
              transferPaymentId: transferPayment.id,
              deviceId:          deviceId ?? order.deviceId,
              notes:             `Ref: ${input.referenceNumber} | ${input.bankName} → ${input.targetAccount}`,
            },
          })

          return { order, transferPayment, cashEvent }
        },
        { timeout: 15_000 },
      )

      return {
        orderId:           result.order.id,
        localSequence:     result.order.localSequence,
        orderNumber:       result.order.orderNumber,
        status:            'PAID_TRANSFER_PENDING' as const,
        transferPaymentId: result.transferPayment.id,
        referenceNumber:   input.referenceNumber,
        message:           `Transferencia registrada. Pendiente de conciliación bancaria.`,
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

      const order = await withTenant(tenantId, (tx) =>
        lockAndTransition(tx, {
          tenantId,
          localSequence:   input.localSequence,
          allowedStatuses: ['AWAITING_PAYMENT', 'AWAITING_PAYMENT_AT_CASHIER'],
          newStatus:       'CREDIT_REQUESTED',
          extraData: {
            notes: input.notes ?? null,
          },
        }),
      )

      return {
        orderId:       order.id,
        localSequence: order.localSequence,
        orderNumber:   order.orderNumber,
        status:        'CREDIT_REQUESTED' as const,
        message:       'Solicitud de crédito enviada al cajero.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // approveCredit — Paso B: el cajero aprueba el crédito
  //
  // CREDIT_REQUESTED → PAID_CREDIT + CreditTransaction(CREDIT_ISSUED)
  //
  // Crea la deuda en CreditTransaction. El deudor puede ser empleado o
  // cliente externo (XOR).
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
          const order = await lockAndTransition(tx, {
            tenantId,
            localSequence:   input.localSequence,
            allowedStatuses: ['CREDIT_REQUESTED'],
            newStatus:       'PAID_CREDIT',
            extraData: {
              paymentMethod:  'CREDIT_EMPLOYEE',
              closedByUserId: userId!,
            },
          })

          const totalAmount = Number(order.totalAmount)

          const effectiveDevice = deviceId ?? order.deviceId

          // Crear la deuda en el libro de créditos (append-only)
          const creditTx = await tx.creditTransaction.create({
            data: {
              tenantId,
              businessDayId,
              type:             CreditEventType.CREDIT_ISSUED,
              amount:           totalAmount,
              orderId:          order.id,
              debtorUserId:     input.debtorUserId     ?? null,
              debtorCustomerId: input.debtorCustomerId ?? null,
              authorizedBy:     userId!,
              deviceId:         effectiveDevice,
              notes:            input.notes ?? null,
            },
          })

          // CashRegisterEvent con tipo ADJUSTMENT — no existe CREDIT_SALE en el enum
          // Se documenta como salida administrativa del cobro a crédito
          await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId: order.establishmentId,
              businessDayId,
              type:    CashEventType.ADJUSTMENT,
              amount:  totalAmount,
              userId:  userId!,
              orderId: order.id,
              deviceId: effectiveDevice,
              notes:   `Crédito aprobado | CreditTx: ${creditTx.id}`,
            },
          })

          return { order, creditTx }
        },
        { timeout: 15_000 },
      )

      return {
        orderId:             result.order.id,
        localSequence:       result.order.localSequence,
        orderNumber:         result.order.orderNumber,
        status:              'PAID_CREDIT' as const,
        creditTransactionId: result.creditTx.id,
        totalAmount:         Number(result.order.totalAmount),
        message:             'Crédito aprobado y registrado. El pedido ha sido cerrado.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // rejectCredit — El cajero rechaza la solicitud de crédito
  //
  // CREDIT_REQUESTED → AWAITING_PAYMENT
  //
  // Devuelve el pedido al estado de espera de pago. El barman debe
  // volver a intentar cobrar por otro método.
  // ──────────────────────────────────────────────────────────────────────────
  rejectCredit: cashierProcedure
    .use(withOpenDay)
    .input(rejectCreditInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const order = await withTenant(tenantId, (tx) =>
        lockAndTransition(tx, {
          tenantId,
          localSequence:   input.localSequence,
          allowedStatuses: ['CREDIT_REQUESTED'],
          newStatus:       'AWAITING_PAYMENT',
          extraData: {
            notes: input.notes ?? null,
          },
        }),
      )

      return {
        orderId:       order.id,
        localSequence: order.localSequence,
        orderNumber:   order.orderNumber,
        status:        'AWAITING_PAYMENT' as const,
        message:       'Crédito rechazado. El pedido vuelve a esperar pago.',
      }
    }),
})
