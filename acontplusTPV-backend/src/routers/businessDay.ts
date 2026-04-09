// =============================================================================
// apps/api/src/routers/businessDay.ts
//
// Gestión de jornadas laborales por establecimiento.
//
// Reglas de negocio (Instrucciones §3):
//   - Solo puede haber UNA jornada abierta por establecimiento a la vez.
//     Garantizado por partial unique index SQL (Migración 1).
//   - Solo ADMIN o CASHIER pueden abrir/cerrar jornadas.
//   - El servidor rechaza transacciones con businessDayId de jornadas
//     cerradas — el middleware withOpenDay enforza esto en cada router
//     de transacciones.
//   - Al cerrar, se registra el resumen financiero del día en la respuesta
//     para que el cajero pueda imprimirlo.
// =============================================================================

import { z }             from 'zod'
import { TRPCError }     from '@trpc/server'
import { router }        from '../trpc'
import { cashierProcedure, anyUserRoleProcedure } from '../middleware/auth'
import { withTenant, withTenantOptions } from '../lib/rls'
import { CashEventType } from '@prisma/client'

// =============================================================================
// SCHEMAS DE ENTRADA
// =============================================================================

const openDayInput = z.object({
  establishmentId: z.string().uuid(),
  initialCash:     z.number().min(0).default(0),
  // Monto de efectivo inicial en caja al abrir la jornada
  notes:           z.string().max(500).optional(),
})

const closeDayInput = z.object({
  establishmentId: z.string().uuid(),
  businessDayId:   z.string().uuid(),
  // Se envía explícitamente para confirmar que el cajero sabe qué cierra
  blindCount:      z.number().min(0),
  // El cajero digita el efectivo que tiene en caja SIN saber el teórico
  notes:           z.string().max(500).optional(),
})

const statusInput = z.object({
  establishmentId: z.string().uuid(),
})

// =============================================================================
// ROUTER
// =============================================================================

export const businessDayRouter = router({

  // ──────────────────────────────────────────────────────────────────────────
  // open — Abre una nueva jornada laboral
  //
  // Solo CASHIER o ADMIN pueden abrir jornadas.
  // Si ya existe una jornada abierta en el establecimiento, lanza error
  // (el partial unique index SQL también lo bloquea a nivel de BD).
  // Crea el primer CashRegisterEvent de tipo SHIFT_OPEN.
  // ──────────────────────────────────────────────────────────────────────────
  open: cashierProcedure
    .input(openDayInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Verificar que el establecimiento pertenece al tenant del usuario
      const establishment = await withTenant(tenantId, (tx) =>
        tx.establishment.findFirst({
          where: {
            id:        input.establishmentId,
            tenantId,
            isActive:  true,
            deletedAt: null,
          },
          select: { id: true, name: true, code: true },
        }),
      )

      if (!establishment) {
        throw new TRPCError({
          code:    'NOT_FOUND',
          message: 'Establecimiento no encontrado o inactivo',
        })
      }

      // Verificar que no haya jornada abierta (doble seguridad además del unique index)
      const existing = await withTenant(tenantId, (tx) =>
        tx.businessDay.findFirst({
          where: {
            tenantId,
            establishmentId: input.establishmentId,
            isOpen:          true,
          },
          select: { id: true, openedAt: true },
        }),
      )

      if (existing) {
        throw new TRPCError({
          code:    'CONFLICT',
          message: `Ya existe una jornada abierta en este establecimiento desde ${
            existing.openedAt.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })
          }. Ciérrala antes de abrir una nueva.`,
        })
      }

      // Encontrar el dispositivo del usuario para el deviceId del evento de caja
      const device = await withTenant(tenantId, (tx) =>
        tx.device.findFirst({
          where: {
            tenantId,
            establishmentId: input.establishmentId,
            isActive:        true,
            deletedAt:       null,
          },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        }),
      )

      if (!device) {
        throw new TRPCError({
          code:    'PRECONDITION_FAILED',
          message: 'No hay dispositivos activos en este establecimiento. Registra al menos uno.',
        })
      }

      // Crear jornada + evento SHIFT_OPEN en una sola transacción atómica
      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          const businessDay = await tx.businessDay.create({
            data: {
              tenantId,
              establishmentId: input.establishmentId,
              isOpen:          true,
              openedAt:        new Date(),
              openedBy:        ctx.auth.userId!,
            },
          })

          // Registrar el efectivo inicial como SHIFT_OPEN
          await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId: input.establishmentId,
              businessDayId:   businessDay.id,
              type:            CashEventType.SHIFT_OPEN,
              amount:          input.initialCash,
              userId:          ctx.auth.userId!,
              deviceId:        device.id,
              notes:           input.notes ?? null,
            },
          })

          return businessDay
        },
        { timeout: 10_000 },
      )

      return {
        businessDay: {
          id:              result.id,
          establishmentId: result.establishmentId,
          isOpen:          result.isOpen,
          openedAt:        result.openedAt,
          openedBy:        result.openedBy,
        },
        establishment: {
          id:   establishment.id,
          name: establishment.name,
          code: establishment.code,
        },
        initialCash: input.initialCash,
        message:     `Jornada abierta en ${establishment.name}`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // close — Cierra la jornada actual
  //
  // Registra el cierre ciego (el cajero digitó cuánto tiene en caja
  // sin saber el teórico esperado).
  // Calcula el resumen financiero del día para imprimir.
  // Marca la jornada como isOpen = false.
  // ──────────────────────────────────────────────────────────────────────────
  close: cashierProcedure
    .input(closeDayInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Verificar que la jornada existe, está abierta y pertenece al tenant
      const businessDay = await withTenant(tenantId, (tx) =>
        tx.businessDay.findFirst({
          where: {
            id:              input.businessDayId,
            tenantId,
            establishmentId: input.establishmentId,
            isOpen:          true,
          },
          select: {
            id:              true,
            openedAt:        true,
            establishmentId: true,
          },
        }),
      )

      if (!businessDay) {
        throw new TRPCError({
          code:    'NOT_FOUND',
          message: 'Jornada no encontrada, ya cerrada, o no pertenece a este establecimiento',
        })
      }

      // Encontrar dispositivo del cajero
      const device = await withTenant(tenantId, (tx) =>
        tx.device.findFirst({
          where: {
            tenantId,
            establishmentId: input.establishmentId,
            isActive:        true,
            deletedAt:       null,
          },
          select: { id: true },
        }),
      )

      if (!device) {
        throw new TRPCError({
          code:    'PRECONDITION_FAILED',
          message: 'No hay dispositivos activos en este establecimiento',
        })
      }

      // Calcular resumen financiero del día para el cierre
      const [cashEvents, orderSummary, pendingTransfers] = await Promise.all([

        // Todos los eventos de caja del día
        withTenant(tenantId, (tx) =>
          tx.cashRegisterEvent.findMany({
            where: { businessDayId: input.businessDayId, tenantId },
            select: { type: true, amount: true },
          }),
        ),

        // Resumen de pedidos por método de pago
        withTenant(tenantId, (tx) =>
          tx.order.groupBy({
            by:     ['status'],
            where: {
              businessDayId: input.businessDayId,
              tenantId,
              status: {
                in: [
                  'PAID_CASH',
                  'PAID_TRANSFER_CONFIRMED',
                  'PAID_TRANSFER_PENDING',
                  'PAID_CREDIT',
                ],
              },
            },
            _sum:   { totalAmount: true },
            _count: { id: true },
          }),
        ),

        // Transferencias pendientes de conciliar
        withTenant(tenantId, (tx) =>
          tx.transferPayment.count({
            where: {
              businessDayId: input.businessDayId,
              tenantId,
              status:        'PENDING',
            },
          }),
        ),
      ])

      // Calcular totales de la jornada
      const totalCashSales = cashEvents
        .filter(e => e.type === CashEventType.SALE_CASH || e.type === CashEventType.SHIFT_OPEN)
        .reduce((sum, e) => sum + Number(e.amount), 0)

      const totalCashOuts = cashEvents
        .filter(e => [
          CashEventType.CASH_OUT_ADVANCE,
          CashEventType.CASH_OUT_EXPENSE,
          CashEventType.CASH_OUT_ADJUSTMENT,
        ].includes(e.type))
        .reduce((sum, e) => sum + Number(e.amount), 0)

      const totalTransferConfirmed = cashEvents
        .filter(e => e.type === CashEventType.TRANSFER_CONFIRMED)
        .reduce((sum, e) => sum + Number(e.amount), 0)

      const theoreticalCash = totalCashSales - totalCashOuts
      const cashDifference  = input.blindCount - theoreticalCash

      // Cerrar jornada + BLIND_COUNT + SHIFT_CLOSE en una sola transacción
      await withTenantOptions(
        tenantId,
        async (tx) => {
          // 1. Registrar el conteo ciego
          await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId: input.establishmentId,
              businessDayId:   input.businessDayId,
              type:            CashEventType.BLIND_COUNT,
              amount:          input.blindCount,
              userId:          ctx.auth.userId!,
              deviceId:        device.id,
              notes:           `Diferencia: ${cashDifference >= 0 ? '+' : ''}${cashDifference.toFixed(2)}`,
            },
          })

          // 2. Registrar el cierre
          await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId: input.establishmentId,
              businessDayId:   input.businessDayId,
              type:            CashEventType.SHIFT_CLOSE,
              amount:          input.blindCount,
              userId:          ctx.auth.userId!,
              deviceId:        device.id,
              notes:           input.notes ?? null,
            },
          })

          // 3. Marcar la jornada como cerrada
          await tx.businessDay.update({
            where: { id: input.businessDayId },
            data:  {
              isOpen:   false,
              closedAt: new Date(),
              closedBy: ctx.auth.userId!,
            },
          })
        },
        { timeout: 15_000 },
      )

      return {
        businessDayId:            input.businessDayId,
        closedAt:                 new Date(),
        // Resumen financiero para impresión
        summary: {
          totalCashSales:           parseFloat(totalCashSales.toFixed(2)),
          totalCashOuts:            parseFloat(totalCashOuts.toFixed(2)),
          totalTransferConfirmed:   parseFloat(totalTransferConfirmed.toFixed(2)),
          theoreticalCash:          parseFloat(theoreticalCash.toFixed(2)),
          blindCount:               input.blindCount,
          cashDifference:           parseFloat(cashDifference.toFixed(2)),
          pendingTransfersToReview: pendingTransfers,
          ordersByStatus:           orderSummary.map(g => ({
            status:     g.status,
            count:      g._count.id,
            totalAmount: parseFloat((Number(g._sum.totalAmount) || 0).toFixed(2)),
          })),
        },
        message: pendingTransfers > 0
          ? `Jornada cerrada. Hay ${pendingTransfers} transferencia(s) pendiente(s) de conciliar.`
          : 'Jornada cerrada correctamente.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // status — Consulta el estado actual de la jornada
  //
  // Disponible para cualquier rol autenticado.
  // La app móvil lo llama al arrancar para saber si puede operar.
  // También lo usa PowerSync para mostrar/bloquear la UI del mesero.
  // ──────────────────────────────────────────────────────────────────────────
  status: anyUserRoleProcedure
    .input(statusInput)
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const businessDay = await withTenant(tenantId, (tx) =>
        tx.businessDay.findFirst({
          where: {
            tenantId,
            establishmentId: input.establishmentId,
            isOpen:          true,
          },
          select: {
            id:              true,
            isOpen:          true,
            openedAt:        true,
            openedBy:        true,
            establishmentId: true,
          },
          orderBy: { openedAt: 'desc' },
        }),
      )

      if (!businessDay) {
        return {
          isOpen:        false,
          businessDay:   null,
          establishment: null,
          message:       'No hay jornada abierta. Contacta al administrador.',
        }
      }

      const establishment = await withTenant(tenantId, (tx) =>
        tx.establishment.findUnique({
          where:  { id: input.establishmentId },
          select: { id: true, name: true, code: true },
        }),
      )

      return {
        isOpen:      true,
        businessDay: {
          id:       businessDay.id,
          openedAt: businessDay.openedAt,
          openedBy: businessDay.openedBy,
        },
        establishment,
        message: 'Jornada activa.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // history — Historial de jornadas de un establecimiento
  //
  // Solo ADMIN o CASHIER pueden consultar el historial completo.
  // ──────────────────────────────────────────────────────────────────────────
  history: cashierProcedure
    .input(z.object({
      establishmentId: z.string().uuid(),
      limit:           z.number().min(1).max(90).default(30),
      // Últimas N jornadas, máximo 90 (3 meses aprox.)
    }))
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const days = await withTenant(tenantId, (tx) =>
        tx.businessDay.findMany({
          where: {
            tenantId,
            establishmentId: input.establishmentId,
          },
          select: {
            id:        true,
            isOpen:    true,
            openedAt:  true,
            closedAt:  true,
            openedBy:  true,
            closedBy:  true,
          },
          orderBy: { openedAt: 'desc' },
          take:    input.limit,
        }),
      )

      return { days, total: days.length }
    }),
})
