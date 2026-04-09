// =============================================================================
// apps/api/src/routers/transfers.ts
// Conciliación de transferencias bancarias — Paso 7
//
// Flujo de conciliación (normalmente los lunes por la noche):
//   El cajero abre el extracto bancario y compara cada transferencia
//   contra los registros del sistema. Por cada una confirma o rechaza.
//
// Al CONFIRMAR una transferencia (PENDING → CONFIRMED):
//   1. TransferPayment.status      → CONFIRMED
//   2. Order.status                → PAID_TRANSFER_CONFIRMED
//   3. CashRegisterEvent(TRANSFER_CONFIRMED) — el efectivo entra al arqueo
//   4. PayrollRecord.hasPendingAdjustments → false (si existía registro)
//      Los PayrollRecord del mesero creador del pedido se marcan si tenían
//      este período pendiente — para que el admin sepa que hay comisiones
//      por recalcular.
//
// Al RECHAZAR una transferencia (PENDING → REJECTED):
//   1. TransferPayment.status      → REJECTED
//   2. Order.status                → AWAITING_PAYMENT (vuelve a la cola)
//   3. CashRegisterEvent(TRANSFER_REJECTED) — el ingreso "esperado" se anula
//      Esto reduce el teórico de caja para que el arqueo no quede inflado.
//
// Por qué necesitamos CashRegisterEvent en ambos casos:
//   El Paso 6 ya creó SALE_TRANSFER cuando el barman registró la transferencia.
//   Ese evento sube el teórico de caja. Si la confirmación no genera
//   TRANSFER_CONFIRMED, el saldo teórico queda "esperando" indefinidamente.
//   Si el rechazo no genera TRANSFER_REJECTED, el cajero verá un faltante
//   inexplicable en su arqueo.
//
// Todos los endpoints requieren CASHIER o ADMIN.
// withOpenDay NO es obligatorio aquí — la conciliación puede hacerse
// incluso con la jornada cerrada (los lunes se revisa el fin de semana).
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import { cashierProcedure } from '../middleware/auth'
import { withTenant, withTenantOptions } from '../lib/rls'
import { CashEventType }    from '@prisma/client'

// =============================================================================
// SCHEMAS
// =============================================================================

const listPendingInput = z.object({
  establishmentId: z.string().uuid().optional(),
  // Si no se especifica, usa el establishmentId del token del usuario
  targetAccount:   z.string().optional(),
  // Filtrar por cuenta bancaria destino para conciliar una cuenta a la vez
  dateFrom:        z.string().datetime().optional(),
  dateTo:          z.string().datetime().optional(),
  limit:           z.number().min(1).max(200).default(50),
})

const confirmTransferInput = z.object({
  transferPaymentId: z.string().uuid(),
  reviewNotes:       z.string().max(500).optional(),
  // Ej: "Verificado en extracto Pichincha 28/04 — transacción #TXN123456"
})

const rejectTransferInput = z.object({
  transferPaymentId: z.string().uuid(),
  reviewNotes:       z.string().min(10).max(500),
  // Obligatorio al rechazar — el auditor debe documentar el motivo
})

const bulkConfirmInput = z.object({
  transferPaymentIds: z.array(z.string().uuid()).min(1).max(50),
  reviewNotes:        z.string().max(500).optional(),
  // Nota común para todos los confirmados en lote
})

// =============================================================================
// HELPER: obtener y validar una transferencia para conciliación
// =============================================================================

async function getPendingTransfer(
  tx: Parameters<Parameters<typeof withTenantOptions>[1]>[0],
  tenantId: string,
  establishmentId: string,
  transferPaymentId: string,
) {
  const transfer = await tx.transferPayment.findFirst({
    where: {
      id:              transferPaymentId,
      tenantId,
      establishmentId,
      status:          'PENDING',
    },
    include: {
      order: {
        select: {
          id:              true,
          status:          true,
          businessDayId:   true,
          totalAmount:     true,
          orderNumber:     true,
          localSequence:   true,
          createdByUserId: true,
          deviceId:        true,
        },
      },
    },
  })

  if (!transfer) {
    throw new TRPCError({
      code:    'NOT_FOUND',
      message: 'Transferencia no encontrada, ya conciliada, o no pertenece a este establecimiento',
    })
  }

  if (transfer.order.status !== 'PAID_TRANSFER_PENDING') {
    throw new TRPCError({
      code:    'CONFLICT',
      message: `El pedido asociado está en estado "${transfer.order.status}" en lugar de PAID_TRANSFER_PENDING. ` +
               'Esto indica una inconsistencia de datos — contacta al administrador.',
    })
  }

  return transfer
}

// =============================================================================
// ROUTER
// =============================================================================

export const transfersRouter = router({

  // ──────────────────────────────────────────────────────────────────────────
  // listPending — Transferencias pendientes de conciliación
  //
  // El cajero ve todas las transferencias PENDING de su establecimiento.
  // Puede filtrar por targetAccount para conciliar una cuenta bancaria
  // a la vez (Instrucciones §4: el dueño puede tener múltiples cuentas).
  // ──────────────────────────────────────────────────────────────────────────
  listPending: cashierProcedure
    .input(listPendingInput)
    .query(async ({ input, ctx }) => {
      const { tenantId, establishmentId: ctxEstId } = ctx.auth
      const establishmentId = input.establishmentId ?? ctxEstId

      const transfers = await withTenant(tenantId, (tx) =>
        tx.transferPayment.findMany({
          where: {
            tenantId,
            establishmentId,
            status: 'PENDING',
            ...(input.targetAccount && { targetAccount: input.targetAccount }),
            ...(input.dateFrom || input.dateTo
              ? {
                  capturedAt: {
                    ...(input.dateFrom && { gte: new Date(input.dateFrom) }),
                    ...(input.dateTo   && { lte: new Date(input.dateTo)   }),
                  },
                }
              : {}),
          },
          select: {
            id:              true,
            amount:          true,
            bankName:        true,
            referenceNumber: true,
            receiptUrl:      true,
            targetAccount:   true,
            status:          true,
            capturedAt:      true,
            capturedByUserId: true,
            order: {
              select: {
                id:            true,
                orderNumber:   true,
                localSequence: true,
                totalAmount:   true,
                tableAlias:    true,
                tableId:       true,
                createdAt:     true,
              },
            },
          },
          orderBy: { capturedAt: 'asc' },
          take:    input.limit,
        }),
      )

      // Agrupar por targetAccount para facilitar la conciliación
      const byAccount = transfers.reduce<Record<string, typeof transfers>>((acc, t) => {
        const key = t.targetAccount
        if (!acc[key]) acc[key] = []
        acc[key].push(t)
        return acc
      }, {})

      const totalAmount = transfers.reduce((sum, t) => sum + Number(t.amount), 0)

      return {
        transfers: transfers.map(t => ({
          ...t,
          amount: Number(t.amount),
          order: {
            ...t.order,
            totalAmount: Number(t.order.totalAmount),
          },
        })),
        byAccount: Object.fromEntries(
          Object.entries(byAccount).map(([account, items]) => [
            account,
            {
              count:       items.length,
              totalAmount: parseFloat(items.reduce((s, i) => s + Number(i.amount), 0).toFixed(2)),
            },
          ]),
        ),
        total:       transfers.length,
        totalAmount: parseFloat(totalAmount.toFixed(2)),
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // confirmTransfer — Confirma que el dinero llegó a la cuenta del dueño
  //
  // PENDING → CONFIRMED
  // Order:   PAID_TRANSFER_PENDING → PAID_TRANSFER_CONFIRMED
  //
  // Genera CashRegisterEvent(TRANSFER_CONFIRMED) para que el efectivo
  // "esperado" del SALE_TRANSFER se materialice en el arqueo real.
  //
  // Marca hasPendingAdjustments=false en los PayrollRecord del mesero
  // que creó el pedido, si los había marcado como pendientes.
  // ──────────────────────────────────────────────────────────────────────────
  confirmTransfer: cashierProcedure
    .input(confirmTransferInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          const transfer = await getPendingTransfer(
            tx, tenantId, establishmentId, input.transferPaymentId,
          )

          const order       = transfer.order
          const amount      = Number(transfer.amount)
          const now         = new Date()

          // 1. Confirmar la transferencia
          await tx.transferPayment.update({
            where: { id: transfer.id },
            data: {
              status:          'CONFIRMED',
              reviewedByUserId: userId!,
              reviewedAt:      now,
              reviewNotes:     input.reviewNotes ?? null,
            },
          })

          // 2. Confirmar el pedido
          await tx.order.update({
            where: { id: order.id },
            data: { status: 'PAID_TRANSFER_CONFIRMED' },
          })

          // 3. Registrar el ingreso confirmado en la caja (append-only)
          // El SALE_TRANSFER del Paso 6 registró el ingreso "esperado".
          // Este TRANSFER_CONFIRMED confirma que el dinero llegó.
          // El arqueo del cajero suma ambos para calcular el teórico correcto.
          const cashEvent = await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId,
              businessDayId:    order.businessDayId,
              type:             CashEventType.TRANSFER_CONFIRMED,
              amount,
              userId:           userId!,
              orderId:          order.id,
              transferPaymentId: transfer.id,
              deviceId:         deviceId ?? order.deviceId,
              notes:            input.reviewNotes
                ?? `Conciliado: ${transfer.referenceNumber} | ${transfer.bankName}`,
            },
          })

          // 4. Marcar PayrollRecord con ajustes pendientes si el mesero
          //    ya fue liquidado en este período sin contar esta transferencia.
          //    Las instrucciones §5 dicen que las comisiones aplican sobre
          //    PAID_TRANSFER_CONFIRMED — si el PayrollRecord ya fue cerrado
          //    antes de esta confirmación, sus comisiones estaban incompletas.
          if (order.createdByUserId) {
            const affectedPayrolls = await tx.payrollRecord.updateMany({
              where: {
                tenantId,
                userId:               order.createdByUserId,
                hasPendingAdjustments: true,
                // Solo afecta registros que ya estaban marcados como pendientes
                // (marcados en el Paso 10 al detectar transferencias sin confirmar)
              },
              data: { hasPendingAdjustments: false },
            })

            return { transfer, order, cashEvent, affectedPayrolls: affectedPayrolls.count }
          }

          return { transfer, order, cashEvent, affectedPayrolls: 0 }
        },
        { timeout: 15_000 },
      )

      return {
        transferPaymentId: input.transferPaymentId,
        orderId:           result.order.id,
        orderNumber:       result.order.orderNumber,
        transferStatus:    'CONFIRMED' as const,
        orderStatus:       'PAID_TRANSFER_CONFIRMED' as const,
        amount:            Number(result.transfer.amount),
        cashEventId:       result.cashEvent.id,
        affectedPayrolls:  result.affectedPayrolls,
        message:           result.affectedPayrolls > 0
          ? `Transferencia confirmada. ${result.affectedPayrolls} liquidación(es) de nómina actualizadas.`
          : 'Transferencia confirmada y registrada en caja.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // rejectTransfer — Rechaza la transferencia (comprobante falso o sin fondos)
  //
  // PENDING → REJECTED
  // Order:   PAID_TRANSFER_PENDING → AWAITING_PAYMENT
  //
  // Genera CashRegisterEvent(TRANSFER_REJECTED) para restar del teórico
  // de caja el ingreso "esperado" que nunca llegó.
  // El pedido vuelve a AWAITING_PAYMENT para ser cobrado por otro medio
  // o cancelado manualmente.
  // ──────────────────────────────────────────────────────────────────────────
  rejectTransfer: cashierProcedure
    .input(rejectTransferInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          const transfer = await getPendingTransfer(
            tx, tenantId, establishmentId, input.transferPaymentId,
          )

          const order  = transfer.order
          const amount = Number(transfer.amount)
          const now    = new Date()

          // 1. Rechazar la transferencia
          await tx.transferPayment.update({
            where: { id: transfer.id },
            data: {
              status:           'REJECTED',
              reviewedByUserId: userId!,
              reviewedAt:       now,
              reviewNotes:      input.reviewNotes,
            },
          })

          // 2. Devolver el pedido a la cola de cobro
          await tx.order.update({
            where: { id: order.id },
            data: {
              status:         'AWAITING_PAYMENT',
              paymentMethod:  null,
              // Limpiamos paymentMethod — ya no está "pagado" con transferencia
              closedByUserId: null,
              // Limpiamos closedByUserId — el pedido vuelve a estar abierto
            },
          })

          // 3. Registrar el rechazo en caja (append-only)
          // TRANSFER_REJECTED anula el SALE_TRANSFER del Paso 6.
          // El arqueo debe mostrar el teórico reducido en este monto.
          const cashEvent = await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId,
              businessDayId:    order.businessDayId,
              type:             CashEventType.TRANSFER_REJECTED,
              amount,
              userId:           userId!,
              orderId:          order.id,
              transferPaymentId: transfer.id,
              deviceId:         deviceId ?? order.deviceId,
              notes:            `Rechazado: ${input.reviewNotes}`,
            },
          })

          return { transfer, order, cashEvent }
        },
        { timeout: 15_000 },
      )

      return {
        transferPaymentId: input.transferPaymentId,
        orderId:           result.order.id,
        orderNumber:       result.order.orderNumber,
        transferStatus:    'REJECTED' as const,
        orderStatus:       'AWAITING_PAYMENT' as const,
        amount:            Number(result.transfer.amount),
        cashEventId:       result.cashEvent.id,
        message:           `Transferencia rechazada. El pedido ${result.order.orderNumber ?? result.order.localSequence} volvió a la cola de cobro.`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // bulkConfirm — Confirma múltiples transferencias en lote
  //
  // Flujo real del cajero los lunes: tiene el extracto bancario y va
  // marcando una por una. Cuando las referencias coinciden, las confirma
  // todas juntas. Cada una es una transacción independiente para que
  // un fallo en una no deshaga las demás.
  // ──────────────────────────────────────────────────────────────────────────
  bulkConfirm: cashierProcedure
    .input(bulkConfirmInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth

      const results = {
        confirmed: [] as string[],
        failed:    [] as Array<{ id: string; reason: string }>,
      }

      // Procesar cada una de forma independiente — fallo aislado
      for (const transferPaymentId of input.transferPaymentIds) {
        try {
          await withTenantOptions(
            tenantId,
            async (tx) => {
              const transfer = await getPendingTransfer(
                tx, tenantId, establishmentId, transferPaymentId,
              )

              const order  = transfer.order
              const amount = Number(transfer.amount)
              const now    = new Date()

              await tx.transferPayment.update({
                where: { id: transfer.id },
                data: {
                  status:           'CONFIRMED',
                  reviewedByUserId: userId!,
                  reviewedAt:       now,
                  reviewNotes:      input.reviewNotes ?? 'Confirmación en lote',
                },
              })

              await tx.order.update({
                where: { id: order.id },
                data: { status: 'PAID_TRANSFER_CONFIRMED' },
              })

              await tx.cashRegisterEvent.create({
                data: {
                  tenantId,
                  establishmentId,
                  businessDayId:    order.businessDayId,
                  type:             CashEventType.TRANSFER_CONFIRMED,
                  amount,
                  userId:           userId!,
                  orderId:          order.id,
                  transferPaymentId: transfer.id,
                  deviceId:         deviceId ?? order.deviceId,
                  notes:            input.reviewNotes ?? 'Confirmación en lote',
                },
              })
            },
            { timeout: 15_000 },
          )

          results.confirmed.push(transferPaymentId)
        } catch (err: unknown) {
          results.failed.push({
            id:     transferPaymentId,
            reason: err instanceof Error ? err.message : 'Error desconocido',
          })
        }
      }

      return {
        confirmed: results.confirmed.length,
        failed:    results.failed.length,
        details:   results,
        message:   results.failed.length === 0
          ? `${results.confirmed.length} transferencia(s) confirmadas correctamente.`
          : `${results.confirmed.length} confirmadas, ${results.failed.length} fallaron. Revisa los detalles.`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // summary — Resumen de conciliación por período
  //
  // Vista consolidada para el dueño: cuánto entró por transferencias
  // en un rango de fechas, agrupado por cuenta bancaria.
  // ──────────────────────────────────────────────────────────────────────────
  summary: cashierProcedure
    .input(z.object({
      establishmentId: z.string().uuid().optional(),
      dateFrom:        z.string().datetime(),
      dateTo:          z.string().datetime(),
    }))
    .query(async ({ input, ctx }) => {
      const { tenantId, establishmentId: ctxEstId } = ctx.auth
      const establishmentId = input.establishmentId ?? ctxEstId

      const transfers = await withTenant(tenantId, (tx) =>
        tx.transferPayment.findMany({
          where: {
            tenantId,
            establishmentId,
            capturedAt: {
              gte: new Date(input.dateFrom),
              lte: new Date(input.dateTo),
            },
          },
          select: {
            status:        true,
            amount:        true,
            targetAccount: true,
            bankName:      true,
          },
        }),
      )

      // Agrupar por targetAccount y status
      type AccountSummary = {
        pending:   number
        confirmed: number
        rejected:  number
        totalPending:   number
        totalConfirmed: number
        totalRejected:  number
      }
      const byAccount = transfers.reduce<Record<string, AccountSummary>>((acc, t) => {
        if (!acc[t.targetAccount]) {
          acc[t.targetAccount] = {
            pending: 0, confirmed: 0, rejected: 0,
            totalPending: 0, totalConfirmed: 0, totalRejected: 0,
          }
        }
        const entry = acc[t.targetAccount]
        const amount = Number(t.amount)
        if (t.status === 'PENDING')   { entry.pending++;   entry.totalPending   += amount }
        if (t.status === 'CONFIRMED') { entry.confirmed++; entry.totalConfirmed += amount }
        if (t.status === 'REJECTED')  { entry.rejected++;  entry.totalRejected  += amount }
        return acc
      }, {})

      const totals = {
        pending:        transfers.filter(t => t.status === 'PENDING').length,
        confirmed:      transfers.filter(t => t.status === 'CONFIRMED').length,
        rejected:       transfers.filter(t => t.status === 'REJECTED').length,
        amountPending:   parseFloat(transfers.filter(t => t.status === 'PENDING').reduce((s, t) => s + Number(t.amount), 0).toFixed(2)),
        amountConfirmed: parseFloat(transfers.filter(t => t.status === 'CONFIRMED').reduce((s, t) => s + Number(t.amount), 0).toFixed(2)),
        amountRejected:  parseFloat(transfers.filter(t => t.status === 'REJECTED').reduce((s, t) => s + Number(t.amount), 0).toFixed(2)),
      }

      return { byAccount, totals, period: { from: input.dateFrom, to: input.dateTo } }
    }),
})
